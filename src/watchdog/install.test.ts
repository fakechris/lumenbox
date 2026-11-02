/** The resident watchdog (INV-1517): install writes a job and a token file, never the token into the job; uninstall takes it all back. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LABEL, type InstallDeps, installWatchdog, plistFor, uninstallWatchdog, watchdogStatus } from "./install.ts";
import { Watchdog } from "./main.ts";

const SECRET = "lmbx_0123456789abcdef0123456789abcdef0123456789abcdef";

function harness(people = [{ id: "feishu:ou_chris", name: "Chris", role: "admin" }, { id: "web:x", name: "songs", role: "driver" }]) {
  const home = mkdtempSync(join(tmpdir(), "wd-home-"));
  const agents = mkdtempSync(join(tmpdir(), "wd-agents-"));
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: people }));
  const requests: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const ran: string[] = [];
  let loaded = false;
  const deps: InstallDeps = {
    home, launchAgentsDir: agents, uid: 501, platform: "darwin", uiToken: () => "ui-secret",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify(url.endsWith("/revoke") ? { revoked: true } : { token: SECRET, label: "watchdog", createdAt: "2026-11-02T14:00:00.000Z" }), { status: 200 });
    }) as typeof fetch,
    run: (command, args) => {
      ran.push(`${command} ${args.join(" ")}`);
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return args[0] === "print" ? (loaded ? { code: 0, stdout: "state = running\n\tpid = 4242\n" } : { code: 113, stdout: "Could not find service" }) : { code: 0, stdout: "" };
    },
    sleep: async () => {},
    program: { execPath: "/Applications/LumenBox.app/Contents/MacOS/LumenBox", execArgv: ["--experimental-transform-types"], script: "/Applications/LumenBox.app/Contents/Resources/app/src/cli.ts", env: { ELECTRON_RUN_AS_NODE: "1" } },
  };
  return { deps, home, agents, requests, ran, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(agents, { recursive: true, force: true }); } };
}

test("install mints a token for the one admin, keeps it in a 0600 file, and registers a job that never holds it", async () => {
  const h = harness();
  try {
    const said = await installWatchdog({ url: "http://127.0.0.1:7777", judge: true }, h.deps);
    assert.match(said.join("\n"), /Installed com\.lumenbox\.watchdog/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual([h.requests[0]!.url, h.requests[0]!.body, h.requests[0]!.auth], ["http://127.0.0.1:7777/api/mcp/tokens", { principalId: "feishu:ou_chris", label: "watchdog" }, "Bearer ui-secret"]);
    const tokenFile = join(h.home, "watchdog", "token");
    assert.equal(readFileSync(tokenFile, "utf8").trim(), SECRET);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, "only its owner can read it");
    const plist = readFileSync(join(h.agents, `${DEFAULT_LABEL}.plist`), "utf8");
    assert.ok(!plist.includes(SECRET), "the job file never holds the token");
    assert.ok(!said.join("\n").includes(SECRET), "nor does anything install says");
    for (const piece of ["<string>/Applications/LumenBox.app/Contents/MacOS/LumenBox</string>", "<string>--experimental-transform-types</string>", "<string>watchdog</string>", "<string>--token-file</string>", `<string>${tokenFile}</string>`, "<string>--judge</string>", "<key>KeepAlive</key>", "<key>RunAtLoad</key>", "<key>ELECTRON_RUN_AS_NODE</key>", join(h.home, "watchdog", "watchdog.log")]) {
      assert.ok(plist.includes(piece), `the job has ${piece}`);
    }
    assert.deepEqual(h.ran, [`launchctl bootstrap gui/501 ${join(h.agents, `${DEFAULT_LABEL}.plist`)}`]);
    const again = await installWatchdog({ url: "http://127.0.0.1:7777", judge: true }, h.deps);
    assert.match(again[0]!, /already installed/);
    assert.equal(h.requests.length, 1, "a second install mints nothing");
  } finally {
    h.cleanup();
  }
});

test("status reads launchd and the log; uninstall stops the job, revokes the token by its creation time, and removes every file", async () => {
  const h = harness();
  try {
    await installWatchdog({ url: "http://127.0.0.1:7777", judge: false }, h.deps);
    writeFileSync(join(h.home, "watchdog", "watchdog.log"), "watchdog: watching http://127.0.0.1:7777\nwatchdog: stalled t4: Flagged t4 for Chris\n");
    const status = watchdogStatus(h.deps);
    assert.match(status[0]!, /com\.lumenbox\.watchdog: running \(pid 4242\)/);
    assert.match(status[1]!, /last flag: watchdog: stalled t4/);
    const said = await uninstallWatchdog(h.deps);
    assert.ok(said.includes("Its token is revoked."));
    assert.deepEqual(h.requests.at(-1)!.body, { createdAt: "2026-11-02T14:00:00.000Z" });
    assert.ok(h.ran.includes(`launchctl bootout gui/501/${DEFAULT_LABEL}`));
    for (const gone of [join(h.agents, `${DEFAULT_LABEL}.plist`), join(h.home, "watchdog", "token"), join(h.home, "watchdog", "install.json")]) assert.equal(existsSync(gone), false, `${gone} is gone`);
    assert.deepEqual(await uninstallWatchdog(h.deps), ["The watchdog is not installed."]);
  } finally {
    h.cleanup();
  }
});

test("an installation with no single admin asks whose token it is; a named person is found by name", async () => {
  const two = harness([{ id: "a", name: "A", role: "admin" }, { id: "b", name: "B", role: "admin" }]);
  try {
    await assert.rejects(installWatchdog({ url: "http://127.0.0.1:7777", judge: true }, two.deps), /--principal: the installation has 2 admins/);
    await installWatchdog({ url: "http://127.0.0.1:7777", judge: true, principal: "B" }, two.deps);
    assert.equal(two.requests[0]!.body.principalId, "b");
  } finally {
    two.cleanup();
  }
  assert.match(plistFor("x", ["a&b"], {}, "/l"), /<string>a&amp;b<\/string>/, "arguments are escaped");
});

test("a door without the record and the feed is too old: said once, and the watchdog waits rather than failing every tick", async () => {
  const logs: string[] = [];
  let caps: Record<string, boolean> = { tasks: true, task_status: true };
  const watchdog = new Watchdog({ door: { call: async () => ({ text: "", isError: false }), capabilities: async () => caps }, log: line => logs.push(line) });
  assert.equal(await watchdog.ready(), false);
  assert.equal(await watchdog.ready(), false);
  assert.equal(logs.filter(line => /too old for the watchdog \(it lacks structured and watch\)/.test(line)).length, 1, "said once");
  caps = { ...caps, structured: true, watch: true };
  assert.equal(await watchdog.ready(), true);
});
