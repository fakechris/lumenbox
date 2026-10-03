import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Principals } from "../host/principals.ts";

test("directory API scopes quotas to authenticated links and retains snapshots on failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "directory-api-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  let failed = false;
  let departed = false;
  try {
    writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", type: "feishu", name: "fixture", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "fixture-app", FIXTURE_APP_SECRET: "fixture-secret" } }));
    new Principals().save([{ id: "ada", name: "Ada", role: "driver", identities: ["web:ada", "fixture:ou_ada"] }]);
    const registry = new AgentRegistry(join(home, "agents"));
    for (const id of ["one", "two"]) registry.attachBox({ id, name: id, kind: "attached", members: "everyone", displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() });
    let base = "";
    const directoryFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      let body: unknown;
      if (url.pathname.includes("tenant_access_token")) body = { code: 0, tenant_access_token: "fixture-token" };
      else if (url.pathname.includes("departments/")) body = { code: 0, data: { items: [{ department_id: "eng", name: "Engineering" }] } };
      else body = failed ? { code: 230002 } : { code: 0, data: { items: departed ? [] : [{ open_id: "ou_ada", name: "Ada", department_ids: ["eng"] }] } };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, directoryFetch, onLog: () => {}, onReady: url => { base = url; } });
    const request = async (path: string, body?: unknown, member = false) => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
        authorization: "Bearer fixture", "content-type": "application/json", ...(member ? { "x-agentbox-user": "web:ada", "x-agentbox-role": "member" } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as { departments: Array<{ key: string }>; quota: number } };
    };
    assert.equal((await request("/api/directories", undefined, true)).status, 403);
    assert.equal((await request("/api/directories/sync", { channelId: "fixture" }, true)).status, 403);
    assert.equal((await request("/api/directories/sync", { channelId: "fixture" })).status, 200);
    const quotas = (await request("/api/quotas")).data;
    const key = quotas.departments[0]!.key;
    assert.equal((await request("/api/quotas", { personalBoxQuota: 3, departmentBoxQuotas: { [key]: 1 } })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["ada"] })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "two", members: ["ada"] })).status, 409);
    const snapshot = JSON.parse(readFileSync(join(home, "directory.json"), "utf8")).fixture.snapshot;
    failed = true;
    assert.equal((await request("/api/directories/sync", { channelId: "fixture" })).status, 503);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "directory.json"), "utf8")).fixture.snapshot, snapshot);
    assert.equal((await request("/api/quotas/self", undefined, true)).data.quota, 0);
    failed = false; departed = true;
    assert.equal((await request("/api/directories/sync", { channelId: "fixture" })).status, 200);
    assert.equal((await request("/api/quotas", { personBoxQuotas: { ada: 9 } })).status, 200);
    assert.equal((await request("/api/boxes/update", { name: "two", members: ["ada"] })).status, 409);
    assert.equal((await request("/api/boxes/update", { name: "one", members: ["ada"] })).status, 200);
    assert.equal(new Principals().list().length, 1, "directory sync never creates or merges identities");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
