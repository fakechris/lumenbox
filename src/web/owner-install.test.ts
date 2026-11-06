/**
 * The desktop app's first start on a temporary home (INV-1685): the Owner exists, the unsigned
 * operator is them, an MCP token and the watchdog install need no person named, and letting a
 * second person in waits for the confirmed conversion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { OWNER_ID } from "../host/installation.ts";
import { installWatchdog } from "../watchdog/install.ts";

test("desktop first start: one Owner, tokens and the watchdog are theirs, a second person needs the conversion", async () => {
  const home = mkdtempSync(join(tmpdir(), "owner-install-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  try {
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: ui, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    };

    assert.equal(existsSync(join(home, "bootstrap-code")), false, "the desktop app arms no bootstrap code");
    assert.equal((await fetch(`${base}/bootstrap`)).status, 404);
    assert.ok(logs.some(line => line.startsWith("Owner created for this computer")));
    const me = await call("/api/me");
    assert.equal(me.body.role, "admin");
    assert.equal(me.body.label, "owner", "the unsigned operator is the Owner");
    assert.equal(typeof me.body.name, "string");

    const issued = await call("/api/mcp/tokens", { label: "my editor" });
    assert.equal(issued.status, 200, "no person named: the Owner's");
    const tokens = (await call("/api/mcp")).body.tokens as { principalId: string; mine: boolean }[];
    assert.deepEqual(tokens.map(t => [t.principalId, t.mine]), [[OWNER_ID, true]]);

    const watchdog = await installWatchdog({ url: base, judge: false }, {
      home, launchAgentsDir: join(home, "LaunchAgents"), uid: 501, platform: "linux", uiToken: () => "t0k", fetch,
      run: () => ({ code: 0, stdout: "" }), program: { execPath: process.execPath, execArgv: [], script: "cli.ts", env: {} },
    });
    assert.match(watchdog[0]!, /Token issued/);
    assert.equal(JSON.parse(readFileSync(join(home, "watchdog", "install.json"), "utf8")).principalId, OWNER_ID, "agentbox watchdog install needs no --principal");

    const channels = await call("/api/channels");
    assert.deepEqual(channels.body.installation, { mode: "single-machine", ownerId: OWNER_ID, createdAt: (channels.body.installation as { createdAt: number }).createdAt });
    const people = channels.body.principals as unknown[];
    const ann = { id: "feishu:ann", name: "Ann", role: "driver", identities: ["feishu:ann"] };
    const refused = await call("/api/principals", { principals: [...people, ann] });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.needs, "owner-conversion");
    assert.equal((await call("/api/channels/invite", { role: "driver" })).status, 409, "an invite for a new person asks too");
    assert.equal((await call("/api/channels/invite", { role: "driver", principalId: OWNER_ID })).status, 200, "a code linking the Owner's own phone does not");
    assert.equal((await call("/api/installation/convert", {})).status, 400, "only an explicit yes converts");
    assert.equal((await call("/api/me")).body.label, "owner");

    const converted = await call("/api/installation/convert", { confirm: true });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.converted, true);
    assert.equal((await call("/api/principals", { principals: [...people, ann] })).status, 200);
    assert.equal((await call("/api/me")).body.label, "admin", "the Owner is now an Admin, and nobody is both");
    const file = JSON.parse(readFileSync(join(home, "principals.json"), "utf8")) as { installation: { mode: string; conversion: { by: string } } };
    assert.equal(file.installation.mode, "organisation");
    assert.equal(file.installation.conversion.by, "the operator", "the audit record says who confirmed");
    assert.ok(logs.some(line => line.startsWith("installation converted")));

    // A restart of the desktop app on this roster creates nothing.
    stop(); stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } });
    assert.equal(((await call("/api/channels")).body.principals as unknown[]).length, 2);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
