import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AgentRegistry } from "../agents/registry.ts";
import { TaskStore } from "../host/tasks.ts";
import { resolveProvider } from "../host/provider.ts";
import { resetConfigEnvForTests } from "../config.ts";
import { startWebServer } from "./server.ts";

test("missing model auth refuses before admission; configuring a model allows a real send and reply", async () => {
  const home = mkdtempSync(join(tmpdir(), "model-readiness-"));
  const vars = ["HOME", "AGENTBOX_HOME", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE",
    "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_FEDERATION_RULE_ID", "AGENTBOX_MODEL", "AGENTBOX_BASE_URL"];
  const saved = new Map(vars.map(key => [key, process.env[key]]));
  for (const key of vars) delete process.env[key];
  process.env.HOME = home; process.env.AGENTBOX_HOME = home; process.env.ANTHROPIC_CONFIG_DIR = join(home, "anthropic");
  resetConfigEnvForTests();
  let stop: (() => void) | undefined, base = "";
  const model = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"fixture","model":"fixture","choices":[{"delta":{"content":"Hello from Ada."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    const registry = new AgentRegistry(join(home, "agents")), agent = registry.create({ name: "Ada" });
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false,
      provider: resolveProvider("anthropic"), onLog: () => {}, onReady: url => { base = url; } });
    const headers = { authorization: "Bearer fixture", "content-type": "application/json", "accept-language": "en" };
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const ready = async () => (await (await fetch(base + "/api/model-readiness?agent=" + agent.id, { headers })).json()).configured;
    assert.equal(await ready(), false);
    assert.equal((await post("/api/prompt", { agent: agent.id, text: "" })).status, 400);
    const refused = await post("/api/prompt", { agent: agent.id, text: "Hello", messageId: "first" });
    assert.equal(refused.status, 409);
    const error = await refused.json();
    assert.equal(error.code, "model-not-configured"); assert.match(error.error, /Settings → Model/);
    assert.deepEqual(new TaskStore(join(home, "tasks.jsonl")).list(), []);
    assert.deepEqual(registry.readTranscript(agent.id), []);
    const turns = join(home, "turns.jsonl");
    assert.equal(existsSync(turns) ? readFileSync(turns, "utf8") : "", "");
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const address = model.address() as { port: number };
    const configured = await post("/api/config", { provider: "openai", key: "fixture-not-real", model: "fixture",
      baseUrl: `http://127.0.0.1:${address.port}` });
    assert.equal(configured.status, 200);
    assert.equal(await ready(), true);
    assert.equal((await post("/api/prompt", { agent: agent.id, text: "Hello", messageId: "configured" })).status, 202);
    const deadline = Date.now() + 5000;
    while (!registry.readTranscript(agent.id).some(entry =>
      typeof entry === "object" && entry !== null && "text" in entry && entry.text === "Hello from Ada.")) {
      assert.ok(Date.now() < deadline, "configured model replied");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(readFileSync(turns, "utf8"), /executionId/);
  } finally {
    stop?.(); model.closeAllConnections(); model.close();
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetConfigEnvForTests(); rmSync(home, { recursive: true, force: true });
  }
});
