import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { Principals } from "../host/principals.ts";

test("bootstrap HTTP flow uses only vendor identity, never leaks the code and admits one concurrent callback", async () => {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-http-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = "http://127.0.0.1:7890";
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  try {
    writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", name: "Fixture", type: "feishu", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "app", FIXTURE_APP_SECRET: "secret" } }));
    const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("oauth/token")) return Response.json({ access_token: JSON.parse(String(init!.body)).code });
      const subject = new Headers(init?.headers).get("authorization")!.slice(7);
      return Response.json({ code: 0, data: { open_id: subject, name: subject } });
    }) as typeof fetch;
    let base = "";
    const start = async () => startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch, onLog: line => logs.push(line), onReady: url => { base = url; } });
    stop = await start();
    const code = readFileSync(join(home, "bootstrap-code"), "utf8").trim();
    assert.equal((await fetch(base + "/bootstrap")).status, 200);
    const begin = async (bootstrapCode: string) => fetch(base + "/auth/fixture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapCode, identity: "attacker:chosen", role: "admin" }), redirect: "manual" });
    assert.equal((await begin("wrong")).status, 400);
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await begin(code); assert.equal(response.status, 200);
      const data = await response.json() as { url: string };
      assert.equal(data.url.includes(code), false);
      states.push(new URL(data.url).searchParams.get("state")!);
    }
    const results = await Promise.all(states.map((state, i) => fetch(base + `/auth/fixture/callback?state=${state}&code=person${i}`, { redirect: "manual" })));
    assert.deepEqual(results.map(response => response.status).sort(), [302, 409]);
    const roster = new Principals().list();
    assert.equal(roster.length, 1); assert.match(roster[0]!.id, /^fixture:person[01]$/); assert.equal(roster[0]!.role, "admin");
    assert.equal((await begin(code)).status, 400);
    assert.equal((await fetch(base + "/bootstrap")).status, 404);
    assert.equal(logs.some(line => line.includes(code)), false);
    stop(); stop = await start();
    assert.equal((await fetch(base + "/bootstrap")).status, 404);
    assert.equal((await begin(code)).status, 400);
  } finally {
    stop?.();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  }
});
