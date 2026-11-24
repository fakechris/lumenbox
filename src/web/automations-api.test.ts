import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { Principals } from "../host/principals.ts";
import { startWebServer } from "./server.ts";

test("automation saves refuse borrowed identities before writing, for timers and webhooks", async () => {
  const home = mkdtempSync(join(tmpdir(), "automations-api-")), previous = process.env.AGENTBOX_HOME;
  const previousGateway = process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY;
  const previousSkillTtl = process.env.AGENTBOX_SKILL_TTL_MS;
  process.env.AGENTBOX_HOME = home;
  process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";
  process.env.AGENTBOX_SKILL_TTL_MS = "0";
  const files = new Map<string, string>();
  let connected = true;
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (!connected) { res.statusCode = 503; res.end(JSON.stringify({ error: "unavailable" })); return; }
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/fs/write") files.set(body.path, body.content);
    if (req.url === "/fs/list") {
      const prefix = body.path.replace(/\/$/, "") + "/", entries = new Map<string, { name: string; type: string }>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), name = rest.split("/")[0]!;
        entries.set(name, { name, type: rest.includes("/") ? "directory" : "file" });
      }
      res.end(JSON.stringify({ entries: [...entries.values()] })); return;
    }
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
    new Principals().save([{ id: "outsider", name: "Outsider", role: "driver", identities: ["web:outsider"] }]);
    registry.updateBox(registry.defaultBox().id, { members: [] });
    registry.create({ name: "Ada" }); registry.create({ name: "Quinn" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${address.port}`, token: "daemon" }),
      onReady: url => { base = url; },
    });
    const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
    const save = (body: unknown) => fetch(base + "/api/automations", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await save({})).status, 400);
    assert.equal((await save({ name: "Empty", body: "" })).status, 400);
    for (const triggerType of ["schedule", "webhook"]) {
      const body = { name: `Routine ${triggerType}`, body: "Report status", triggerType, schedule: "0 * * * *", timezone: "UTC" };
      const skillFiles = () => [...files].filter(([path]) => path.endsWith("/SKILL.md"));
      const before = skillFiles();
      const denied = await save({ ...body, agent: "Quinn" });
      assert.equal(denied.status, 400);
      const said = (await denied.json()) as { error: string };
      assert.match(said.error, /^Quinn can't run this automation:/);
      assert.match(said.error, /borrow its permissions/); assert.match(said.error, /Choose Ada/);
      assert.doesNotMatch(said.error, /who wrote it/);
      assert.deepEqual(skillFiles(), before, "a refused save writes no routine");
      assert.equal((await save({ ...body, agent: "Ada" })).status, 200);
      assert.equal((await save({ ...body, agent: "Ada" })).status, 409, "creation cannot overwrite an existing skill");
      assert.equal((await save({ ...body, name: `Default ${triggerType}` })).status, 200);
      const listed = await (await fetch(base + "/api/schedules", { headers })).json() as {
        schedules: { slug: string; kind: string; timezone?: string }[];
      };
      for (const slug of [`routine-${triggerType}`, `default-${triggerType}`]) {
        const routine = listed.schedules.find(entry => entry.slug === slug);
        assert.ok(routine, "a saved automation must be loadable and listed");
        assert.equal(routine.kind, triggerType);
        assert.equal(routine.timezone, triggerType === "schedule" ? "UTC" : undefined);
      }
    }
    const choices = await (await fetch(base + "/api/schedules", { headers })).json() as { runnerAgents: string[] };
    assert.deepEqual(choices.runnerAgents, ["Ada"], "the new-routine picker offers only a usable identity");
    const excluded = await fetch(base + "/api/schedules", {
      headers: { ...headers, "x-agentbox-user": "web:outsider", "x-agentbox-role": "member" },
    });
    assert.equal(excluded.status, 200);
    const hidden = await excluded.json() as { runnerAgents: string[]; boxes: unknown[] };
    assert.deepEqual(hidden.boxes, [], "this caller cannot read the default box");
    assert.deepEqual(hidden.runnerAgents, [], "the picker must not disclose its default agent's name");
    const interrupted = { name: "After reconnect", body: "Report status", triggerType: "webhook" };
    connected = false;
    const lost = await save(interrupted);
    assert.equal(lost.status, 503);
    assert.equal((await lost.json()).code, "no-box", "the computer disappeared before the host's connection status caught up");
    connected = true;
    assert.equal((await save(interrupted)).status, 200, "the unchanged request can be retried after recovery");
  } finally {
    stop?.(); await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    if (previousGateway === undefined) delete process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY;
    else process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = previousGateway;
    if (previousSkillTtl === undefined) delete process.env.AGENTBOX_SKILL_TTL_MS;
    else process.env.AGENTBOX_SKILL_TTL_MS = previousSkillTtl;
    rmSync(home, { recursive: true, force: true });
  }
});
