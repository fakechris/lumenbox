import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { AgentRegistry } from "../agents/registry.ts";
import { Principals } from "../host/principals.ts";
import { catalogTemplate } from "../host/template.ts";
import { CATALOG_EXPERTS } from "../host/catalog.ts";
import { startWebServer } from "./server.ts";

test("template reads and installation respect both source and target box membership", async () => {
  const home = mkdtempSync(join(tmpdir(), "template-membership-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    new Principals().save([
      { id: "alice", name: "Alice", role: "driver", identities: ["web:alice", "feishu:alice"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    ]);
    const registry = new AgentRegistry(join(home, "agents"));
    registry.attachBox({ id: "alice-private", name: "Alice-private", kind: "attached", members: ["alice"], displayFloor: 1, workDir: "/work", createdAt: "2026-10-02" });
    const privateAgent = registry.create({ name: "Secret source", boxId: "alice-private", importedFrom: { id: "secret-share", name: "Shared recipe", at: "2026-10-02" } });
    const sharedAgent = registry.create({ name: "Shared source", boxId: registry.box.id, importedFrom: { id: "public-share", name: "Shared recipe", at: "2026-10-02" } });
    const template = catalogTemplate(CATALOG_EXPERTS[0]!);
    for (const agent of [privateAgent, sharedAgent]) {
      const dir = join(home, "templates", agent.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "v1.json"), JSON.stringify({ ...template, profile: { ...template.profile, name: agent === privateAgent ? "Secret recipe" : "Shared recipe" } }));
    }
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "template-fixture", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const request = async (path: string, body?: unknown, user: string | undefined = "web:bob", role = "member") => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
        authorization: "Bearer template-fixture", "content-type": "application/json",
        ...(user === "operator" ? {} : { "x-agentbox-user": user!, "x-agentbox-role": role }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, text: await response.text() };
    };
    const shelf = await request("/api/templates/shelf");
    assert.equal(shelf.status, 200);
    assert.ok(!shelf.text.includes("Alice-private") && !shelf.text.includes(privateAgent.id) && !shelf.text.includes("Secret recipe"), "outsider shelf has no private box, source or imported metadata");
    const visible = JSON.parse(shelf.text);
    assert.equal(visible.mine.find((row: { agentId: string }) => row.agentId === sharedAgent.id).stamped, 1, "private imports do not inflate visible counts");
    for (const user of ["feishu:alice", "operator"]) assert.ok((await request("/api/templates/shelf", undefined, user)).text.includes("Alice-private"));
    assert.ok(!(await request("/api/templates/shelf", undefined, "web:bob", "owner")).text.includes("Alice-private"), "admin is not implicitly a box member");
    for (const route of ["mine", "download"]) {
      assert.equal((await request(`/api/templates/${route}?agent=${privateAgent.id}`)).status, 403);
      assert.equal((await request(`/api/templates/${route}?agent=${privateAgent.id}`, undefined, "feishu:alice", "viewer")).status, 200, "member viewers may read");
      assert.equal((await request(`/api/templates/${route}?agent=missing`)).status, 404);
    }
    const count = () => new AgentRegistry(join(home, "agents")).list().length;
    const before = count();
    const requests = [
      ["/api/templates/stamp", { catalogSlug: CATALOG_EXPERTS[0]!.slug }],
      ["/api/catalog/install", { slug: CATALOG_EXPERTS[0]!.slug }],
      ["/api/templates/import", { template }],
    ] as const;
    for (const [route, body] of requests) {
      assert.equal((await request(route, { ...body, boxId: "alice-private" })).status, 403, route);
      assert.equal((await request(route, { ...body, boxId: "missing" })).status, 404, "invalid target does not fall back");
      assert.equal((await request(route, { ...body, boxId: 42 })).status, 400, "malformed target does not fall back");
    }
    assert.equal((await request("/api/templates/stamp", { agentId: privateAgent.id, boxId: registry.box.id })).status, 403, "shared destination does not authorize a private source");
    assert.equal(count(), before, "denied writes created no agents");
    assert.equal((await request("/api/catalog/install", { slug: CATALOG_EXPERTS[0]!.slug, boxId: "alice-private" }, "feishu:alice")).status, 200);
    assert.equal((await request("/api/catalog/install", { slug: CATALOG_EXPERTS[0]!.slug, boxId: registry.box.id })).status, 200);
    assert.equal(count(), before + 2, "same catalog share in different boxes creates independent agents");
    const own = new AgentRegistry(join(home, "agents"));
    own.updateBox(own.box.id, { members: ["alice"] });
    // Server's in-memory registry is updated through its own API as well.
    assert.equal((await request("/api/boxes/update", { name: own.box.name, members: ["alice"] }, "operator")).status, 200);
    for (const [route, body] of requests) assert.equal((await request(route, body)).status, 403, "omitted target is still authorized");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});


test("a remote template fetch cannot outlive revocation of target membership", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "template-revocation-"));
  const previous = { home: process.env.AGENTBOX_HOME, control: process.env.AGENTBOX_CONTROL_URL, token: process.env.BOXD_TOKEN };
  process.env.AGENTBOX_HOME = home;
  process.env.BOXD_TOKEN = "fixture-box-token";
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const template = catalogTemplate(CATALOG_EXPERTS[0]!);
  const control = createServer((_req, res) => {
    release = () => { if (res.writableEnded) return; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ document: JSON.stringify(template) })); };
    entered!();
  });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  const address = control.address();
  assert.ok(address && typeof address === "object");
  process.env.AGENTBOX_CONTROL_URL = `http://127.0.0.1:${address.port}`;
  let stop: (() => void) | undefined;
  try {
    new Principals().save([{ id: "alice", name: "Alice", role: "driver", identities: ["web:alice"] }]);
    const registry = new AgentRegistry(join(home, "agents"));
    registry.attachBox({ id: "target", name: "Target", kind: "attached", members: ["alice"], displayFloor: 1, workDir: "/work", createdAt: "2026-10-02" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const before = new AgentRegistry(join(home, "agents")).list().length;
    const pending = fetch(base + "/api/templates/import", { method: "POST", headers: {
      authorization: "Bearer fixture", "content-type": "application/json", "x-agentbox-user": "web:alice", "x-agentbox-role": "member",
    }, body: JSON.stringify({ boxId: "target", shareId: "a".repeat(21) }) });
    await arrived;
    const revoked = await fetch(base + "/api/boxes/update", { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ name: "Target", members: [] }) });
    assert.equal(revoked.status, 200);
    release!();
    const result = await pending;
    assert.equal(result.status, 403);
    await result.text();
    assert.equal(new AgentRegistry(join(home, "agents")).list().length, before, "no agent created after revocation during fetch");
  } finally {
    release?.(); stop?.(); control.closeAllConnections();
    await new Promise<void>(resolve => control.close(() => resolve()));
    for (const [key, value] of Object.entries({ AGENTBOX_HOME: previous.home, AGENTBOX_CONTROL_URL: previous.control, BOXD_TOKEN: previous.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
