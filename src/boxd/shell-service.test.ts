/**
 * Tests for shell session state.
 *
 * These run bash on the host rather than in the box, which is fine: the behaviour
 * under test is the session wrapper, not the container.
 *
 * The bug being pinned down is silent. With a fresh shell per call, `cd build`
 * followed by `make` runs the build somewhere else entirely and the model has no
 * way to notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedOutput, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, runShell } from "./shell-service.ts";

function cleanup(key: string): void {
  for (const suffix of ["cwd", "env"]) {
    rmSync(`/tmp/boxd-session-${key}.${suffix}`, { force: true });
  }
}

test("working directory persists across calls in a session", async () => {
  const session = "test-cwd";
  cleanup(session);
  try {
    const first = await runShell({ command: "cd /tmp && pwd", session });
    assert.equal(first.stdout.trim(), "/tmp");
    assert.equal(first.exit_code, 0);

    const second = await runShell({ command: "pwd", session });
    assert.equal(second.stdout.trim(), "/tmp", "the cd must still be in effect");
  } finally {
    cleanup(session);
  }
});

test("exported variables persist across calls in a session", async () => {
  const session = "test-env";
  cleanup(session);
  try {
    await runShell({ command: "export MARKER=hello", session });
    const result = await runShell({ command: 'echo "[$MARKER]"', session });
    assert.equal(result.stdout.trim(), "[hello]");
  } finally {
    cleanup(session);
  }
});

test("sessions are isolated from each other", async () => {
  const a = "test-iso-a";
  const b = "test-iso-b";
  cleanup(a);
  cleanup(b);
  try {
    await runShell({ command: "cd /tmp && export SECRET=fromA", session: a });

    const leak = await runShell({ command: 'pwd; echo "[$SECRET]"', session: b });
    assert.doesNotMatch(leak.stdout, /fromA/, "one agent must not see another's env");
    assert.doesNotMatch(
      leak.stdout.split("\n")[0] ?? "",
      /^\/tmp$/,
      "nor inherit its working directory"
    );
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("state is saved even when the command exits early", async () => {
  const session = "test-trap";
  cleanup(session);
  try {
    // An explicit `exit` would skip a trailing save; an EXIT trap does not.
    await runShell({ command: "cd /tmp; export KEPT=yes; exit 3", session });
    const result = await runShell({ command: 'pwd; echo "[$KEPT]"', session });
    assert.match(result.stdout, /\/tmp/);
    assert.match(result.stdout, /\[yes\]/);
  } finally {
    cleanup(session);
  }
});

test("an explicit cwd overrides the remembered directory", async () => {
  const session = "test-explicit";
  cleanup(session);
  try {
    await runShell({ command: "cd /tmp && pwd", session });
    const result = await runShell({ command: "pwd", session, cwd: "/" });
    assert.equal(result.stdout.trim(), "/");
  } finally {
    cleanup(session);
  }
});

test("a session key cannot escape its state path", async () => {
  // A traversal attempt must be sanitized rather than writing outside /tmp.
  const result = await runShell({
    command: "echo ok",
    session: "../../etc/passwd",
  });
  assert.equal(result.stdout.trim(), "ok");
  assert.equal(result.exit_code, 0);
  // The sanitized key keeps only safe characters, so nothing outside /tmp is touched.
  cleanup("etcpasswd");
});

test("sessionless calls still work and honour cwd", async () => {
  const result = await runShell({ command: "pwd", cwd: "/tmp" });
  // Compare resolved paths: on macOS /tmp is a symlink to /private/tmp, and
  // spawning with `cwd` yields the physical path while `cd` keeps the logical one.
  assert.equal(realpathSync(result.stdout.trim()), realpathSync("/tmp"));
});

test("a failing command reports its exit code without throwing", async () => {
  const result = await runShell({ command: "echo out; echo err >&2; exit 7" });
  assert.equal(result.exit_code, 7);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
  assert.equal(result.timed_out, false);
});

test("a hanging command is killed and reported as timed out", async () => {
  const result = await runShell({ command: "sleep 30", timeout_ms: 700 });
  assert.equal(result.timed_out, true);
  assert.notEqual(result.exit_code, 0);
});

test("a timeout longer than the box allows is capped, and the result says so", async () => {
  // It used to be clamped in silence: a caller asking for an hour was killed at ten minutes with
  // nothing to distinguish that from the command crashing on its own.
  const result = await runShell({ command: "true", timeout_ms: 60 * 60_000 });
  assert.equal(result.timeout_ms, MAX_TIMEOUT_MS);

  const asked = await runShell({ command: "true", timeout_ms: 700 });
  assert.equal(asked.timeout_ms, 700, "a timeout inside the cap is the one applied");

  const defaulted = await runShell({ command: "true" });
  assert.equal(defaulted.timeout_ms, 120_000);
});


test("output is capped as it arrives, not after the whole stream is held", () => {
  // The cap used to be applied at the end, over everything the process had written: every chunk was
  // retained, then concatenated and truncated. So it bounded the *result* and not the memory, and a
  // runaway logger could take the container's whole allowance and kill the daemon before it had
  // anything to return — which reads as the box crashing rather than as a command being too noisy.
  //
  // Asserted on what is retained rather than on process memory: a memory-delta measurement here
  // depends on when GC runs and was flaky enough to be worse than no test.
  const output = new BoundedOutput();
  const chunk = Buffer.alloc(1024 * 1024, 0x78); // 1 MiB at a time
  for (let index = 0; index < 64; index++) output.push(chunk);

  assert.ok(output.retained() <= MAX_OUTPUT_BYTES, `retained ${output.retained()} bytes`);
  assert.equal(output.retained() + output.discarded(), 64 * 1024 * 1024, "every byte is accounted for");

  const text = output.toString("stdout");
  assert.match(text, /\[stdout truncated: \d+ more bytes\]/);
  assert.ok(text.length < MAX_OUTPUT_BYTES + 200);

  // Under the cap nothing is dropped and nothing is appended.
  const small = new BoundedOutput();
  small.push(Buffer.from("hello"));
  assert.equal(small.discarded(), 0);
  assert.equal(small.toString("stdout"), "hello");
});

test("a descendant that escapes the kill does not wedge the request", async () => {
  // `close` fires when every inherited stdout/stderr descriptor is closed, not when the command
  // exits — and a descendant can leave the process group with setsid and keep those descriptors
  // open. The group kill does not reach it, so the request stayed pending far past its own ceiling:
  // measured in a real container, `setsid sh -c "sleep 30"` held /exec open for the full thirty
  // seconds after a kill at 1.5s.
  const started = Date.now();
  const result = await runShell({
    // A detached child inheriting stdout: `detached` is setsid, so it leaves the process group and
    // keeps the pipe open after the group is killed. Written through node because `setsid` as a
    // command is not portable, and this test has to run on a developer's machine too.
    command:
      `node -e "require('child_process').spawn('sleep',['30'],` +
      `{detached:true,stdio:['ignore','inherit','inherit']}).unref()"; sleep 30`,
    timeout_ms: 600,
  });
  const took = Date.now() - started;

  assert.equal(result.timed_out, true);
  assert.ok(took < 10_000, `it answered in ${took}ms rather than waiting on the escapee`);
  // And says so, because "timed out" alone would suggest everything it started is gone.
  assert.match(result.stderr, /left the process group and is still running/);
  assert.match(result.stderr, /it was not stopped/);
});

test("output too big to show is kept on disk, and the notice says where", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-spool-"));
  try {
    const out = new BoundedOutput(dir, "big.out.log");
    // Well past what a tool result shows, nowhere near the daemon's own memory cap —
    // the band where output used to be discarded upstream with nothing behind it.
    const line = Buffer.from(`${"x".repeat(999)}\n`);
    const pushes = 60;
    for (let n = 0; n < pushes; n++) out.push(line);
    out.close();

    assert.equal(out.discarded(), 0, "nothing was dropped here; it is simply unshowable");
    const notice = out.toString("stdout");
    assert.match(notice, /full output kept:/, "and it still says where the whole thing is");
    assert.equal(
      statSync(join(dir, "big.out.log")).size,
      pushes * line.length,
      "the spool is the whole output"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command small enough to show writes no spool file at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-spool-"));
  try {
    const out = new BoundedOutput(dir, "small.out.log");
    out.push(Buffer.from("two lines\nof output\n"));
    out.close();
    assert.equal(out.discarded(), 0);
    assert.doesNotMatch(out.toString("stdout"), /full output kept:/);
    assert.equal(existsSync(join(dir, "small.out.log")), false, "no fd for an ordinary ls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("yesterday's spool is reaped; today's is left alone", async () => {
  const { reapSpool } = await import("./shell-service.ts");
  const dir = mkdtempSync(join(tmpdir(), "agentbox-spool-"));
  try {
    writeFileSync(join(dir, "old.log"), "x");
    writeFileSync(join(dir, "new.log"), "x");
    const old = Date.now() / 1000 - 48 * 3600;
    utimesSync(join(dir, "old.log"), old, old);

    assert.equal(reapSpool(dir), 1);
    assert.equal(existsSync(join(dir, "old.log")), false);
    assert.equal(existsSync(join(dir, "new.log")), true, "evidence for a live turn stays");
    assert.equal(reapSpool(join(dir, "not-a-directory")), 0, "a missing spool is not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
