/** The shell guard names boundary probes from their text (INV-1553), using the commands agents actually ran. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProbeKeeper, probeOf } from "./boundary-probe.ts";

// From the box's job list on 2026-11-03, shortened; tokens replaced.
const RAN = {
  "process-environment": [`sudo cat /proc/1/environ | tr '\\0' '\\n' | grep BOXD_TOKEN`, `cat /proc/$PID/environ`],
  "browser-cookies": [`python3 -c "key=hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt', 1, 16)"`, `sqlite3 /tmp/ck.db "select name,hex(encrypted_value) from cookies" # Cookies`],
  "identity-headers": [`curl -H "x-agentbox-user: 45598bfa" -H "x-agentbox-role: owner" http://example.com/x`],
  "host-ui": [`curl -s -m 20 "http://host.docker.internal:7777/api/tasks?token=REDACTED"`, `curl -H "Host: localhost" http://0.250.250.254:7777/api/config`, `python3 -c "urllib.request.urlopen('http://host.docker.internal:7777/')"`],
  "credential-search": [`grep -rhoE '[0-9a-f]{64}' .spool/*.out.log`, `timeout 60 grep -rl lmbx_ /home/box /tmp /opt/boxd /etc /var`, `grep -rn AGENTBOX_UI_TOKEN /proc`],
};

test("every probe the agents ran is named, and named for what it does", () => {
  for (const [kind, commands] of Object.entries(RAN)) {
    for (const command of commands) assert.equal(probeOf(command)?.kind, kind, command);
  }
});

test("ordinary work is not a probe", () => {
  for (const command of [
    "grep -rn TODO src/", "rg 'export function' -g '*.ts'", "curl -s https://api.github.com/repos/fakechris/lumenbox",
    "cat /home/box/work/notes.md", "find . -name '*.py' | head", "sha256sum report.pdf", "echo $HOME",
    "python3 -c \"print(hashlib.sha256(b'x').hexdigest())\"", "ps aux | grep chromium",
    // The agents' own MCP face is how a delegate reaches LumenBox, by design.
    `curl -X POST http://host.docker.internal:7777/mcp/r/${"a".repeat(32)} -H "content-type: application/json"`,
  ]) assert.equal(probeOf(command), undefined, command);
});

test("each probe is said to admins; the third in an hour pauses the agent; a paused one is not paused again", async () => {
  let clock = 0;
  const said: string[] = [], paused: string[] = [];
  const keeper = new ProbeKeeper({ nameOf: () => "Bob", notify: t => said.push(t), pause: async id => { paused.push(id); }, isPaused: id => paused.includes(id), log: () => {}, now: () => clock });
  const probe = probeOf("sudo cat /proc/1/environ")!;
  await keeper.report("bob", probe); clock += 60_000;
  await keeper.report("bob", probe); clock += 60_000;
  assert.deepEqual(paused, []);
  const third = await keeper.report("bob", probe);
  assert.equal(third.paused, true);
  assert.deepEqual(paused, ["bob"]);
  assert.match(said[2] ?? "", /3 in an hour, so Bob is paused until someone resumes them/);
  await keeper.report("bob", probe);
  assert.deepEqual(paused, ["bob"], "already paused: not again");
  clock += 2 * 3_600_000;
  assert.equal((await keeper.report("eve", probe)).count, 1, "per agent");
  assert.deepEqual(keeper.recent().map(i => i.agentId), ["eve", "bob"], "newest first, one per agent, from the last day");
  clock += 24 * 3_600_000;
  assert.deepEqual(keeper.recent(), [], "a day later the list is clear");
});
