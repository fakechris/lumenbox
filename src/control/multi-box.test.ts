/**
 * Boxes on the control plane (docs/30 Stage D): one primary per tenant, any number attached;
 * an attach goes through the primary and leaves a row; the collector mirrors what the primary
 * reports and retires what it stops reporting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminRouteOf, handleAdmin } from "./admin.ts";
import type { BoxHandle } from "./allocator.ts";
import { Collector } from "./collector.ts";
import type { Session } from "./gateway.ts";
import { SqliteControlStore } from "./store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-control-mb-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const tenant = store.upsertTenant({ name: "acme" });
  const alice = store.upsertUser({ username: "alice" });
  store.putMembership(alice.id, tenant.id, "owner");
  const primary = store.createBox(
    { id: "box-1", tenantId: tenant.id, allocatorKind: "compose", externalId: "agentbox-acme", boxdUrl: "http://127.0.0.1:1", uiUrl: "http://primary:7777", state: "ready", image: "img", createdAt: "2026-09-02T00:00:00Z" },
    { box: "boxtoken", ui: "uitoken" }
  );
  const handle: BoxHandle = { tenantId: tenant.id, id: primary.id, externalId: primary.externalId, boxdUrl: primary.boxdUrl, uiUrl: primary.uiUrl, tokens: { box: "boxtoken", ui: "uitoken" }, createdAt: primary.createdAt, state: "ready" };
  const allocator = {
    kind: "compose" as const,
    async allocate() {
      return handle;
    },
    async find() {
      return handle;
    },
    async stop() {},
    async destroy() {},
    async list() {
      return [handle];
    },
    async reconcile(target: BoxHandle) {
      return target;
    },
  };
  const session: Session = { userId: alice.id, tenantId: tenant.id, role: "owner" };
  return { dir, store, tenant, primary, allocator, session, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("one primary per tenant, any number attached; the primary is what the gateway finds", () => {
  const { store, tenant, primary, cleanup } = fixture();
  try {
    assert.equal(primary.role, "primary");
    assert.throws(
      () => store.createBox({ id: "box-2", tenantId: tenant.id, allocatorKind: "compose", externalId: "second", boxdUrl: "http://x", uiUrl: "http://y", state: "ready", image: "", createdAt: "2026-09-02T00:00:00Z" }),
      /UNIQUE/,
      "a second primary is still two bills"
    );
    const grok = store.upsertAttachedBox({ tenantId: tenant.id, name: "grok", boxdUrl: "http://host.docker.internal:13370" });
    const vm2 = store.upsertAttachedBox({ tenantId: tenant.id, name: "vm2", boxdUrl: "http://host.docker.internal:13371" });
    assert.equal(grok.role, "attached");
    assert.equal(vm2.role, "attached");
    assert.equal(store.boxForTenant(tenant.id)?.id, primary.id, "the primary, never an attached one");
    assert.deepEqual(store.attachedBoxesOf(tenant.id).map(row => row.externalId), ["grok", "vm2"]);
    // Upsert by name: the same box reported again is the same row, with the newer address.
    const again = store.upsertAttachedBox({ tenantId: tenant.id, name: "grok", boxdUrl: "http://host.docker.internal:23370", state: "unreachable" });
    assert.equal(again.id, grok.id);
    assert.equal(again.boxdUrl, "http://host.docker.internal:23370");
    assert.equal(again.state, "unreachable");
    assert.equal(store.retireAttachedBox(tenant.id, "vm2"), true);
    assert.deepEqual(store.attachedBoxesOf(tenant.id).map(row => row.externalId), ["grok"]);
    assert.equal(store.retireAttachedBox(tenant.id, "vm2"), false);
    // A token scan sees attached rows too: an attached box's own token reaches the template API.
    store.putToken(grok.id, "box", "grok-token");
    assert.equal(store.findBoxByToken("box", "grok-token")?.id, grok.id);
  } finally {
    cleanup();
  }
});

test("attaching through the admin surface forwards to the primary and leaves a row; detaching retires it", async () => {
  const { store, tenant, allocator, session, cleanup } = fixture();
  try {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), auth: headers.authorization });
      const path = new URL(String(url)).pathname;
      if (path === "/api/boxes/attach") return new Response(JSON.stringify({ connected: true, detail: "grok: box ready" }), { status: 200 });
      if (path === "/api/boxes/detach") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    assert.deepEqual(adminRouteOf("GET", "/api/admin/boxes"), { kind: "boxes" });
    assert.deepEqual(adminRouteOf("POST", "/api/admin/boxes/attach"), { kind: "attach-box" });
    assert.deepEqual(adminRouteOf("POST", "/api/admin/boxes/detach"), { kind: "detach-box" });

    const attached = await handleAdmin({ kind: "attach-box" }, { name: "grok", baseUrl: "http://host.docker.internal:13370", token: "t", displayFloor: 10 }, new URLSearchParams(), { store, allocator, session, fetchImpl });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.equal(calls[0]?.url, "http://primary:7777/api/boxes/attach");
    assert.equal(calls[0]?.auth, "Bearer uitoken", "the primary's own UI token, never the caller's cookie");
    assert.deepEqual(calls[0]?.body, { name: "grok", baseUrl: "http://host.docker.internal:13370", token: "t", displayFloor: 10 });
    assert.deepEqual(store.attachedBoxesOf(tenant.id).map(row => [row.externalId, row.state]), [["grok", "ready"]]);

    const listed = await handleAdmin({ kind: "boxes" }, {}, new URLSearchParams(), { store, allocator, session, fetchImpl });
    const boxes = (listed.body as { boxes: { name: string; role: string }[] }).boxes;
    assert.deepEqual(boxes.map(box => [box.name, box.role]), [["agentbox-acme", "primary"], ["grok", "attached"]]);

    const bad = await handleAdmin({ kind: "attach-box" }, { name: "no spaces here", baseUrl: "http://x", token: "t" }, new URLSearchParams(), { store, allocator, session, fetchImpl });
    assert.equal(bad.status, 400);

    const detached = await handleAdmin({ kind: "detach-box" }, { name: "grok" }, new URLSearchParams(), { store, allocator, session, fetchImpl });
    assert.equal(detached.status, 200);
    assert.equal(calls[1]?.url, "http://primary:7777/api/boxes/detach");
    assert.deepEqual(store.attachedBoxesOf(tenant.id), []);

    // A member is refused, and it is audited.
    const member: Session = { ...session, role: "member" };
    assert.equal((await handleAdmin({ kind: "attach-box" }, { name: "x", baseUrl: "http://x", token: "t" }, new URLSearchParams(), { store, allocator, session: member, fetchImpl })).status, 403);
    assert.ok(store.recentAudit(20).some(entry => entry.action === "admin.box.attach"));
  } finally {
    cleanup();
  }
});

test("the collector probes primaries only and mirrors what each reports about its attached boxes", async () => {
  const { store, tenant, primary, allocator, cleanup } = fixture();
  try {
    store.upsertAttachedBox({ tenantId: tenant.id, name: "stale", boxdUrl: "http://old" });
    let report = [
      { id: "own", name: "agentbox-box", kind: "docker", connected: true, displayFloor: 1 },
      { id: "box_g", name: "grok", kind: "attached", connected: true, endpoint: "http://host.docker.internal:13370", displayFloor: 10 },
    ];
    const probed: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = new URL(String(url));
      probed.push(target.host + target.pathname);
      if (target.pathname === "/health") return new Response(JSON.stringify({ ok: true, desktop_health: [] }), { status: 200 });
      if (target.pathname === "/api/usage") return new Response(JSON.stringify({ records: [] }), { status: 200 });
      if (target.pathname === "/api/boxes") return new Response(JSON.stringify({ own: "own", boxes: report }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const collector = new Collector({ store, allocator, fetchImpl, timeoutMs: 500 });

    const first = await collector.sweep();
    assert.equal(first.boxes, 1, "the stale attached row was not probed");
    assert.deepEqual(store.attachedBoxesOf(tenant.id).map(row => [row.externalId, row.boxdUrl, row.state]), [["grok", "http://host.docker.internal:13370", "ready"]], "grok mirrored, stale retired");
    assert.ok(!probed.some(entry => entry.startsWith("old")), "the attached box's own address is never dialled from here");
    const grokRow = store.attachedBoxesOf(tenant.id)[0]!;
    assert.equal(store.latestHealth(grokRow.id)?.ok, true);

    report = [report[0]!, { ...report[1]!, connected: false }];
    await collector.sweep();
    assert.equal(store.attachedBoxesOf(tenant.id)[0]?.state, "unreachable");
    assert.equal(store.latestHealth(grokRow.id)?.ok, false);
    void primary;
  } finally {
    cleanup();
  }
});
