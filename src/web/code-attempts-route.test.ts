/**
 * A sign-in code cannot be guessed through the browser login (INV-2078): past a few wrong codes the
 * source is refused before any code is compared, and the refusal says how long to wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { CODE_ATTEMPT_LIMITS } from "./code-attempts.ts";

const PORT = 7987;
const BASE = `http://127.0.0.1:${PORT}`;

test("past the limit of wrong codes, the login refuses with 429 before comparing — even a live code", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-code-attempts-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const logs: string[] = [];
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: line => logs.push(line) });
    const login = (code: string) => fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Eve" }) });
    const invite = await fetch(`${BASE}/api/channels/invite`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t0k" }, body: JSON.stringify({ role: "viewer", minutes: 7 * 24 * 60 }) });
    const live = ((await invite.json()) as { code: string }).code;
    for (let i = 0; i < CODE_ATTEMPT_LIMITS.perSource; i++) assert.equal((await login(`WRONG${i}`)).status, 400, "a wrong code is refused as not live");
    const refused = await login(live);
    assert.equal(refused.status, 429, "once over the limit, even the live code is not compared");
    const body = (await refused.json()) as { code: string; error: string };
    assert.equal(body.code, "code-attempts");
    assert.match(body.error, /\b\d+\b/, "and the refusal says how long to wait, in the reader's language");
    assert.equal(logs.filter(line => /too many wrong codes/.test(line)).length, 1, "the host logs reaching the limit once");
    assert.ok(!logs.some(line => line.includes(live) || /WRONG\d/.test(line)), "and never a code");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
