/**
 * Tests for the admin surface.
 *
 * The ones that matter most are the two that stop a tenant becoming unadministerable — removing or
 * demoting its only owner — and the audit rows for attempts that were refused. The rest is routing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminRouteOf, handleAdmin, requireOwner } from "./admin.ts";
import type { BoxAllocator, BoxHandle } from "./allocator.ts";
import { SqliteControlStore } from "./store.ts";
import type { Session } from "./gateway.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-admin-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const tenant = store.upsertTenant({ name: "acme", quota: { monthlyTokens: 5_000 } });
  const alice = store.upsertUser({ username: "alice" });
  store.putMembership(alice.id, tenant.id, "owner");

  const destroyed: string[] = [];
  const restarted: string[] = [];
  const handle: BoxHandle = {
    tenantId: tenant.id,
    id: "box-1",
    externalId: "agentbox-acme",
    boxdUrl: "http://127.0.0.1:1",
    uiUrl: "http://127.0.0.1:2",
    tokens: { box: "boxtoken", ui: "uitoken" },
    createdAt: new Date().toISOString(),
    state: "ready",
  };
  const allocator = {
    kind: "compose" as const,
    async allocate() {
      return handle;
    },
    async find() {
      return handle;
    },
    async stop() {},
    async destroy(target: BoxHandle) {
      destroyed.push(target.externalId);
    },
    async list() {
      return [handle];
    },
    async reconcile(target: BoxHandle) {
      return target;
    },
    async restart(target: BoxHandle) {
      restarted.push(target.externalId);
    },
  };

  const asOwner: Session = { userId: alice.id, tenantId: tenant.id, role: "owner" };
  const call = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    session: Session = asOwner
  ) => {
    const route = adminRouteOf(method, path);
    assert.ok(route, `${method} ${path} should be an admin route`);
    return handleAdmin(route, body, new URLSearchParams(), { store, allocator, session });
  };

  return {
    store,
    tenant,
    alice,
    asOwner,
    call,
    destroyed,
    restarted,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("only real admin paths are admin paths", () => {
  assert.deepEqual(adminRouteOf("GET", "/api/admin/tenant"), { kind: "tenant" });
  assert.deepEqual(adminRouteOf("POST", "/api/admin/users"), { kind: "invite" });
  assert.deepEqual(adminRouteOf("PATCH", "/api/admin/users/abc-123"), {
    kind: "set-role",
    userId: "abc-123",
  });
  assert.deepEqual(adminRouteOf("DELETE", "/api/admin/users/abc-123"), {
    kind: "remove-member",
    userId: "abc-123",
  });

  // Not admin, and importantly not mistaken for it.
  assert.equal(adminRouteOf("GET", "/api/state"), undefined);
  assert.equal(adminRouteOf("GET", "/api/admin/tenant/extra"), undefined);
  assert.equal(adminRouteOf("POST", "/api/admin/tenant"), undefined, "wrong method is not a route");
  // A path that looks administrative but escapes the prefix must not be handled here.
  assert.equal(adminRouteOf("GET", "/api/admin/../state"), undefined);
  assert.equal(adminRouteOf("GET", "/api/admin//users"), undefined);
});

test("everything here is an owner's business, and a refusal is audited", async () => {
  const { store, tenant, call, cleanup } = fixture();
  try {
    const bob = store.upsertUser({ username: "bob" });
    store.putMembership(bob.id, tenant.id, "member");
    const asMember: Session = { userId: bob.id, tenantId: tenant.id, role: "member" };

    assert.equal(requireOwner(asMember)?.includes("Only an owner"), true);

    const refused = await call("GET", "/api/admin/users", {}, asMember);
    assert.equal(refused.status, 403);

    // "Who tried" is asked after an incident as often as "who did".
    assert.ok(
      store.recentAudit().some(row => row.action === "admin.refused.users" && row.actor === bob.id),
      "the attempt is on the record"
    );

    // A viewer likewise, and the message says what would let them.
    const asViewer: Session = { userId: bob.id, tenantId: tenant.id, role: "viewer" };
    assert.equal((await call("POST", "/api/admin/users", { username: "x" }, asViewer)).status, 403);
  } finally {
    cleanup();
  }
});

test("the tenant view shows state and spend, and never a token", async () => {
  const { store, tenant, call, cleanup } = fixture();
  try {
    store.createBox({
      id: "box-1",
      tenantId: tenant.id,
      allocatorKind: "compose",
      externalId: "agentbox-acme",
      boxdUrl: "http://127.0.0.1:1",
      uiUrl: "http://127.0.0.1:2",
      state: "ready",
      image: "agentbox/box:test",
      createdAt: new Date().toISOString(),
    });
    store.putToken("box-1", "ui", "the-ui-token");

    const result = await call("GET", "/api/admin/tenant");
    assert.equal(result.status, 200);
    const serialised = JSON.stringify(result.body);
    // A surface for a person, and a token on a page is a token in a screenshot.
    assert.ok(!serialised.includes("the-ui-token"), "no tokens in the tenant view");
    assert.ok(!serialised.includes("boxtoken"));
    assert.match(serialised, /agentbox-acme/);
    assert.match(serialised, /monthlyTokens/);
  } finally {
    cleanup();
  }
});

test("a tenant cannot be left with nobody who can manage it", async () => {
  const { store, tenant, alice, call, cleanup } = fixture();
  try {
    // Demoting the only owner.
    const demoted = await call("PATCH", `/api/admin/users/${alice.id}`, { role: "member" });
    assert.equal(demoted.status, 409);
    assert.match(JSON.stringify(demoted.body), /only owner/);
    assert.equal(store.membership(alice.id, tenant.id)?.role, "owner", "and it did not happen");

    // Removing the only owner.
    const removed = await call("DELETE", `/api/admin/users/${alice.id}`);
    assert.equal(removed.status, 409);
    assert.ok(store.membership(alice.id, tenant.id), "still a member");

    // With a second owner, both become possible.
    const bob = store.upsertUser({ username: "bob" });
    store.putMembership(bob.id, tenant.id, "owner");
    assert.equal((await call("PATCH", `/api/admin/users/${alice.id}`, { role: "viewer" })).status, 200);
    assert.equal(store.membership(alice.id, tenant.id)?.role, "viewer");
  } finally {
    cleanup();
  }
});

test("inviting grants a role and says what it does not do", async () => {
  const { store, tenant, call, cleanup } = fixture();
  try {
    const result = await call("POST", "/api/admin/users", { username: "carol", role: "viewer" });
    assert.equal(result.status, 200);
    assert.equal(store.membership(store.findUserByName("carol")!.id, tenant.id)?.role, "viewer");
    // It grants a role; it does not create a credential, because the identity provider owns those.
    assert.match(JSON.stringify(result.body), /does not create a sign-in credential/);

    assert.equal((await call("POST", "/api/admin/users", { username: "" })).status, 400);
    const badRole = await call("POST", "/api/admin/users", { username: "dave", role: "root" });
    assert.equal(badRole.status, 400);
    assert.match(JSON.stringify(badRole.body), /owner, member or viewer/);

    // A role change lands at the next sign-in, because the role rides in the session cookie. Said
    // in the response rather than left to be discovered.
    const changed = await call("PATCH", `/api/admin/users/${store.findUserByName("carol")!.id}`, {
      role: "member",
    });
    assert.match(JSON.stringify(changed.body), /next sign-in/);

    assert.equal((await call("PATCH", "/api/admin/users/nobody", { role: "member" })).status, 404);
    assert.equal((await call("DELETE", "/api/admin/users/nobody")).status, 404);
  } finally {
    cleanup();
  }
});

test("destroying a box needs the tenant's name typed, not a flag", async () => {
  const { call, destroyed, cleanup } = fixture();
  try {
    // A confirm flag is something a script sets once and forgets, and this deletes the work and the
    // logged-in browser profiles.
    const noConfirm = await call("POST", "/api/admin/box/destroy", {});
    assert.equal(noConfirm.status, 400);
    assert.match(String((noConfirm.body as { error: string }).error), /"confirm": "acme"/);
    assert.deepEqual(destroyed, []);

    assert.equal((await call("POST", "/api/admin/box/destroy", { confirm: true })).status, 400);
    assert.equal((await call("POST", "/api/admin/box/destroy", { confirm: "other" })).status, 400);
    assert.deepEqual(destroyed, [], "nothing was destroyed by a near miss");

    const done = await call("POST", "/api/admin/box/destroy", { confirm: "acme" });
    assert.equal(done.status, 200);
    assert.deepEqual(destroyed, ["agentbox-acme"]);
  } finally {
    cleanup();
  }
});

test("restarting keeps the volumes, and is audited before it happens", async () => {
  const { store, call, restarted, cleanup } = fixture();
  try {
    assert.equal((await call("POST", "/api/admin/box/restart")).status, 200);
    assert.deepEqual(restarted, ["agentbox-acme"]);
    assert.ok(store.recentAudit().some(row => row.action === "admin.box.restart"));
  } finally {
    cleanup();
  }
});

test("an allocator that cannot restart says so rather than pretending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-admin-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const alice = store.upsertUser({ username: "alice" });
    store.putMembership(alice.id, tenant.id, "owner");
    const handle: BoxHandle = {
      tenantId: tenant.id,
      id: "box-1",
      externalId: "static:box-1",
      boxdUrl: "http://127.0.0.1:1",
      uiUrl: "http://127.0.0.1:2",
      tokens: { box: "b", ui: "u" },
      createdAt: new Date().toISOString(),
      state: "ready",
    };
    // The static allocator did not start the box, so restarting it is not its business. 501 rather
    // than a silent success, which would look like a restart that did nothing.
    const allocator: BoxAllocator = {
      kind: "static",
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
      async reconcile(target) {
        return target;
      },
    };
    const result = await handleAdmin(
      { kind: "restart-box" },
      {},
      new URLSearchParams(),
      { store, allocator, session: { userId: alice.id, tenantId: tenant.id, role: "owner" } }
    );
    assert.equal(result.status, 501);
    assert.match(JSON.stringify(result.body), /static allocator cannot restart/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audit feed shows this tenant's rows and nobody else's", async () => {
  const { store, call, cleanup } = fixture();
  try {
    const other = store.upsertTenant({ name: "beta" });
    store.audit({ tenantId: other.id, actor: "someone", action: "signin", target: "beta" });
    await call("POST", "/api/admin/users", { username: "carol" });

    const result = await call("GET", "/api/admin/audit");
    const rows = (result.body as { rows: { tenantId?: string; action: string }[] }).rows;
    // An owner administers their own team, not the fleet.
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.tenantId !== other.id), "another tenant's rows are not shown");
    assert.ok(rows.some(row => row.action === "admin.invite"));
  } finally {
    cleanup();
  }
});
