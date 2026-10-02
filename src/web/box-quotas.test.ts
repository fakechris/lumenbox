import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Principals } from "../host/principals.ts";

test("admin allocation limits are atomic, enforced by the box update route, and self reads reveal only a count", async () => {
  const home = mkdtempSync(join(tmpdir(), "box-quotas-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    new Principals().save([
      { id: "ada", name: "Ada", role: "driver", identities: ["web:ada"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    ]);
    const registry = new AgentRegistry(join(home, "agents"));
    for (const id of ["one", "two"]) registry.attachBox({ id, name: id, kind: "attached", members: "everyone", displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "quota-test", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const request = async (path: string, body?: unknown, role?: string, identity = "web:ada") => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
        authorization: "Bearer quota-test", "content-type": "application/json",
        ...(role ? { "x-agentbox-user": identity, "x-agentbox-role": role } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    assert.equal((await request("/api/quotas", {}, "member")).status, 403);
    assert.equal((await request("/api/quotas", undefined, "viewer")).status, 403);
    assert.equal((await request("/api/quotas", { personalBoxQuota: 1 })).status, 200);
    assert.equal((await request("/api/quotas", { personalBoxQuota: 0, personBoxQuotas: { nobody: 2 } })).status, 400);
    assert.equal((await request("/api/quotas")).data.personalBoxQuota, 1, "invalid patch writes nothing");
    for (const invalid of [-1, 100, 0.5, "2", false]) assert.equal((await request("/api/quotas", { personalBoxQuota: invalid })).status, 400);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["ada"] })).status, 200);
    mkdirSync(join(home, "boxes"), { recursive: true });
    const tokenFile = join(home, "boxes", "two.token");
    writeFileSync(tokenFile, "original-test-token");
    assert.equal((await request("/api/boxes/update", { name: "two", members: ["ada", "ada"], token: "replacement-test-token" })).status, 409);
    assert.equal(readFileSync(tokenFile, "utf8"), "original-test-token", "rejected allocation cannot mutate credentials");
    assert.equal(new AgentRegistry(join(home, "agents")).boxById("two")?.members, "everyone", "membership is also unchanged");
    assert.deepEqual((await request("/api/quotas/self", undefined, "member")).data, { quota: 1, held: 1 });
    assert.deepEqual((await request("/api/quotas/self", undefined, "member", "web:bob")).data, { quota: 1, held: 0 });
    assert.equal((await request("/api/quotas", { personalBoxQuota: 0, personBoxQuotas: { ada: 2 } })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "two", members: ["ada"] })).status, 200);
    assert.equal((await request("/api/quotas", { personBoxQuotas: { ada: null } })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["ada"] })).status, 200, "lowering quota does not revoke existing boxes");
    assert.equal((await request("/api/boxes/update", { name: "one", members: "everyone" })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["bob"] })).status, 409);
    assert.equal((await request("/api/quotas", { personalBoxQuota: null })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["bob"] })).status, 200);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
