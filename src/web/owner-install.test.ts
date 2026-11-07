/**
 * The desktop app's first start on a temporary home (INV-1685): the Owner exists, the unsigned
 * operator is them, an MCP token and the watchdog install need no person named, and no path lets
 * a second person in (INV-1689).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { OWNER_ID } from "../host/installation.ts";
import { installWatchdog } from "../watchdog/install.ts";

test("desktop first start: one Owner, tokens and the watchdog are theirs, and every add-person path is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "owner-install-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  try {
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const call = async (path: string, body?: unknown, lang = "en") => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...ui, "accept-language": lang }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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
    // The four ways a person is added: by hand, an invite code, a knock let in, a directory synced.
    const refusals = [
      await call("/api/principals", { principals: [...people, ann] }),
      await call("/api/channels/invite", { role: "driver" }),
      await call("/api/channels/approve", { identity: "feishu:ann", role: "driver" }),
      await call("/api/directories/sync", { channelId: "feishu" }),
    ];
    for (const refused of refusals) {
      assert.equal(refused.status, 409);
      assert.equal(refused.body.needs, "organisation");
      assert.equal(refused.body.error, "This is your personal installation; it has only you. To work with others, join or create an organisation.");
      assert.match(String(refused.body.manual), /docs\/manual\/channels\.md$/);
    }
    const zh = await call("/api/principals", { principals: [...people, ann] }, "zh-CN");
    assert.equal(zh.body.error, "这是你的个人安装，只有你一个人。要和别人协作，请加入或创建一个组织。");
    assert.match(String(zh.body.manual), /channels\.zh\.md$/);
    assert.equal((await call("/api/channels/invite", { role: "driver", principalId: OWNER_ID })).status, 200, "a code linking the Owner's own phone is not a second person");
    assert.equal((await call("/api/installation/convert", { confirm: true })).status, 404, "there is no conversion");
    assert.equal((await call("/api/me")).body.label, "owner");
    assert.equal(JSON.parse(readFileSync(join(home, "principals.json"), "utf8")).installation.mode, "single-machine");

    // A restart of the desktop app on this roster creates nothing, and an old allow list is not imported as people.
    writeFileSync(join(home, "config.json"), JSON.stringify({ channelAllow: ["feishu:bob"] }));
    stop(); stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } });
    assert.equal(((await call("/api/channels")).body.principals as unknown[]).length, 1);
    assert.ok(logs.some(line => line.startsWith("channel allow list: 1 id(s) kept in config, not imported")));
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
