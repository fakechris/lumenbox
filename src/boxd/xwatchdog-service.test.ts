import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XWatchdogService } from "./xwatchdog-service.ts";

test("XWatchdogService handles missing files gracefully in fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xwatchdog-test-"));
  try {
    const service = new XWatchdogService({
      execLogPath: join(dir, "nonexistent-exec.log"),
      guiLogPath: join(dir, "nonexistent-gui.log"),
      daemonUrl: "http://127.0.0.1:49999", // non-existent
    });

    const result = await service.events(0, 50);
    assert.equal(result.events.length, 0);
    assert.equal(result.next_seq, 0);
    assert.equal(result.has_more, false);
    // The daemon did not answer: on a box that can sudo, that is a high-risk signal, not silence.
    assert.equal(result.daemon_up, false);
    assert.equal(result.at_risk, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("XWatchdogService parses exec commands and window-focus, and carries no typed content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xwatchdog-test-"));
  try {
    const execPath = join(dir, "exec.log");
    const guiPath = join(dir, "gui.log");

    writeFileSync(
      execPath,
      [
        "time=2026-09-09 09:30:00 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=101 | ppid=100 | cmd=ls -la",
        "time=2026-09-09 09:30:10 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=105 | ppid=100 | cmd=git status",
      ].join("\n") + "\n"
    );

    writeFileSync(
      guiPath,
      [
        JSON.stringify({
          time: "2026-09-09T09:30:05.000Z",
          type: "window_focus",
          display: 1,
          window: "Terminal",
          detail: { from: "Desktop" },
        }),
        // A leftover keystroke line from an older, content-capturing build must be dropped on read,
        // so a rebuilt box stops surfacing anything that was typed.
        JSON.stringify({
          time: "2026-09-09T09:30:06.000Z",
          type: "gui_input",
          display: 1,
          window: "Terminal",
          detail: { text: "hunter2" },
        }),
        JSON.stringify({
          time: "2026-09-09T09:30:15.000Z",
          type: "window_focus",
          display: 1,
          window: "Chromium",
          detail: { from: "Terminal" },
        }),
      ].join("\n") + "\n"
    );

    const service = new XWatchdogService({
      execLogPath: execPath,
      guiLogPath: guiPath,
      daemonUrl: "http://127.0.0.1:49998", // unreachable daemon
    });

    // The dropped gui_input line leaves four accepted events: two exec, two window_focus.
    const all = await service.events(0, 10);
    assert.equal(all.events.length, 4);
    assert.equal(all.has_more, false);
    const types = all.events.map(e => e.type).sort();
    assert.deepEqual(types, ["exec", "exec", "window_focus", "window_focus"]);
    // Nothing typed survives: no event carries a text/keystroke field.
    for (const e of all.events) {
      assert.ok(!("text" in e.detail), `event ${e.type} must not carry typed text`);
    }
    const cmds = all.events.filter(e => e.type === "exec").map(e => e.detail["cmd"]).sort();
    assert.deepEqual(cmds, ["git status", "ls -la"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("XWatchdogService proxies to native Go daemon if running", async () => {
  const fakeDaemon = createServer((req, res) => {
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          events: [
            {
              seq: 1,
              type: "exec",
              time: "2026-09-09T09:30:00Z",
              detail: { cmd: "uname -a" },
            },
          ],
          next_seq: 1,
          has_more: false,
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => fakeDaemon.listen(0, "127.0.0.1", resolve));
  const port = (fakeDaemon.address() as { port: number }).port;

  try {
    const service = new XWatchdogService({
      daemonUrl: `http://127.0.0.1:${port}`,
    });

    const result = await service.events(0, 10);
    assert.equal(result.events.length, 1);
    assert.ok(result.events[0]);
    assert.equal(result.events[0].detail["cmd"], "uname -a");
    assert.equal(result.next_seq, 1);
  } finally {
    fakeDaemon.close();
  }
});

test("XWatchdogService classifies sources (user, agent, system) and detects supervisor probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xwatchdog-source-test-"));
  try {
    const execPath = join(dir, "exec.log");
    const guiPath = join(dir, "gui.log");

    writeFileSync(
      execPath,
      [
        // User command from interactive terminal (pts)
        "time=2026-09-09 09:30:00 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=101 | ppid=100 | cmd=vim main.ts",
        // System supervisor probes
        "time=2026-09-09 09:30:01 | uid=1000 | user=box | tty=none | pwd=/home/box | pid=102 | ppid=100 | cmd=pgrep -f -- pcmanfm --desktop",
        "time=2026-09-09 09:30:02 | uid=1000 | user=box | tty=none | pwd=/home/box | pid=103 | ppid=100 | cmd=tr \\0 \\n",
        "time=2026-09-09 09:30:03 | uid=1000 | user=box | tty=none | pwd=/home/box | pid=104 | ppid=100 | cmd=grep -Fqx DISPLAY=:1",
        // Agent shell execution and child command
        "time=2026-09-09 09:30:04 | uid=1000 | user=box | tty=none | pwd=/home/box/work | pid=200 | ppid=100 | cmd=nice -n 19 /bin/bash -lc echo hello",
        "time=2026-09-09 09:30:05 | uid=1000 | user=box | tty=none | pwd=/home/box/work | pid=201 | ppid=200 | cmd=git commit -m done",
      ].join("\n") + "\n"
    );

    writeFileSync(
      guiPath,
      [
        JSON.stringify({
          time: "2026-09-09T09:30:00.500Z",
          type: "window_focus",
          display: 1,
          window: "Terminal",
          detail: { to: "Terminal" },
        }),
      ].join("\n") + "\n"
    );

    const service = new XWatchdogService({
      execLogPath: execPath,
      guiLogPath: guiPath,
      daemonUrl: "http://127.0.0.1:49997",
    });

    const res = await service.events(0, 20);
    assert.equal(res.events.length, 7);

    const userEvents = res.events.filter(e => e.source === "user");
    assert.equal(userEvents.length, 2); // vim main.ts (pts) and Terminal window_focus

    const systemEvents = res.events.filter(e => e.source === "system");
    assert.equal(systemEvents.length, 3); // pgrep pcmanfm, tr \0 \n, grep DISPLAY
    for (const se of systemEvents) {
      assert.equal(se.probe, true);
    }

    const agentEvents = res.events.filter(e => e.source === "agent");
    assert.equal(agentEvents.length, 2); // nice -n 19 bash, and child git commit
    assert.equal(agentEvents[0]?.detail["cmd"], "nice -n 19 /bin/bash -lc echo hello");
    assert.equal(agentEvents[1]?.detail["cmd"], "git commit -m done");
    for (const ae of agentEvents) {
      assert.notEqual(ae.probe, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
