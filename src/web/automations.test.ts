import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "../agents/registry.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

test("new routines stay paused until explicitly turned on, then reach preflight (INV-1969)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-automations-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const files = new Map<string, string>();
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = String(body.path ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/fs/read") {
      const content = files.get(path);
      if (content === undefined) res.statusCode = 404;
      res.end(JSON.stringify({ content }));
      return;
    }
    if (req.url === "/fs/write") files.set(path, body.content);
    if (req.url === "/fs/list") {
      const entries = [...files.keys()].flatMap(file => {
        if (dirname(file) === path) return [{ name: basename(file), type: "file" }];
        if (dirname(dirname(file)) === path) return [{ name: basename(dirname(file)), type: "directory" }];
        return [];
      });
      res.end(JSON.stringify({ entries }));
      return;
    }
    res.end(JSON.stringify({ stdout: "", stderr: "", exit_code: 0 }));
  });
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const provisioner = new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-daemon" });
    new AgentRegistry().create({ name: "Nova" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "test-ui", boxProvisioner: provisioner, onReady: url => { base = url; } });
    const headers = { authorization: "Bearer test-ui" };
    const post = (path: string, data: object) => fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(data) });
    const routines = async () => {
      const response = await fetch(base + "/api/schedules", { headers });
      assert.equal(response.status, 200);
      return (await response.json()).schedules as { slug: string; kind: string; paused: boolean }[];
    };
    await routines(); // Warm the cache before writing; the next read must already reflect the write.
    for (const [triggerType, options] of [["schedule", { schedule: "0 9 * * *" }], ["webhook", {}], ["message", { match: "report" }]] as const) {
      const name = `${triggerType} report`;
      const response = await post("/api/automations", { name, body: "Summarize the report.", triggerType, timezone: "America/New_York", ...options });
      assert.equal(response.status, 200);
      const { slug } = await response.json();
      const entry = (await routines()).find(row => row.slug === slug);
      assert.equal(entry?.kind, triggerType);
      assert.equal(entry?.paused, true);
      const path = [...files.keys()].find(file => file.endsWith(`/${slug}/SKILL.md`))!;
      assert.match(files.get(path)!, /^paused: true$/m);
      if (triggerType === "schedule") assert.match(files.get(path)!, /^timezone: "America\/New_York"$/m);
      else assert.doesNotMatch(files.get(path)!, /^timezone:/m);

      const hook = triggerType === "webhook"
        ? (await (await fetch(base + "/api/hooks", { headers })).json()).hooks.find((row: { slug: string }) => row.slug === slug)
        : undefined;
      const fire = () => hook
        ? fetch(base + new URL(hook.url).pathname, { method: "POST", headers: { authorization: `Bearer ${hook.secret}` }, body: "Test event" })
        : post("/api/schedules/run", { slug });
      if (triggerType !== "message") {
        const refused = await fire();
        assert.equal(refused.status, hook ? 409 : 400);
        assert.match((await refused.json()).error, hook ? /paused.*Automations.*Turn on.*resend the webhook/ : /paused.*Automations.*Turn on.*Run now again/);
      }

      if (triggerType !== "message") {
        files.set(path, files.get(path)!.replace("paused: true", "paused: true\nsecrets: missing-routine-test-secret"));
      }
      const resumed = await post("/api/schedules/resume", { slug });
      assert.equal(resumed.status, 200);
      assert.equal((await routines()).find(row => row.slug === slug)?.paused, false);
      if (triggerType !== "message") {
        const preflight = await fire();
        assert.equal(preflight.status, hook ? 409 : 400);
        assert.match((await preflight.json()).error, /missing before it could start: .*missing-routine-test-secret/);
      }
    }
  } finally {
    stop?.();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
