import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

test("automation saves refuse borrowed identities before writing, for timers and webhooks", async () => {
  const home = mkdtempSync(join(tmpdir(), "automations-api-")), previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const files = new Map<string, string>();
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/fs/write") files.set(body.path, body.content);
    if (req.url === "/fs/read") {
      if (!files.has(body.path)) { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); return; }
      res.end(JSON.stringify({ content: files.get(body.path) })); return;
    }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const registry = new AgentRegistry();
    registry.create({ name: "Ada" }); registry.create({ name: "Quinn" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${address.port}`, token: "daemon" }),
      onReady: url => { base = url; },
    });
    const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
    const save = (method: string, body: unknown) => fetch(base + "/api/automations", { method, headers, body: JSON.stringify(body) });
    assert.equal((await save("POST", {})).status, 400);
    assert.equal((await save("POST", { name: "Empty", body: "" })).status, 400);
    assert.equal((await save("PUT", { name: "Missing", body: "Report", slug: "../escape" })).status, 400);
    for (const triggerType of ["schedule", "webhook"]) {
      const body = { name: `Routine ${triggerType}`, body: "Report status", triggerType, schedule: "0 * * * *" };
      for (const method of ["POST", "PUT"]) {
        const skillFiles = () => [...files].filter(([path]) => path.endsWith("/SKILL.md"));
        const before = skillFiles();
        const denied = await save(method, { ...body, slug: `routine-${triggerType}`, agent: "Quinn" });
        assert.equal(denied.status, 400);
        const said = (await denied.json()) as { error: string };
        assert.match(said.error, /Quinn/); assert.match(said.error, /borrow its permissions/); assert.match(said.error, /Choose Ada/);
        assert.deepEqual(skillFiles(), before, "a refused save writes no routine");
      }
      assert.equal((await save("POST", { ...body, agent: "Ada" })).status, 200);
      assert.equal((await save("PUT", { ...body, slug: `routine-${triggerType}` })).status, 200, "omitted means default on edit too");
      assert.equal((await save("POST", { ...body, name: `Default ${triggerType}` })).status, 200);
    }
    const choices = await (await fetch(base + "/api/schedules", { headers })).json() as { runnerAgents: string[] };
    assert.deepEqual(choices.runnerAgents, ["Ada"], "the new-routine picker offers only a usable identity");
  } finally {
    stop?.(); await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
