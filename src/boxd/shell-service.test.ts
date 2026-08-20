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
import { realpathSync, rmSync } from "node:fs";
import { MAX_TIMEOUT_MS, runShell } from "./shell-service.ts";

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


test("a flood of output is bounded while it streams, not after", async () => {
  // The cap used to be applied at the end, over everything the process had written, so it bounded
  // the result and not the memory: a runaway logger could take the container's whole allowance and
  // kill the daemon before it had anything to return. Measured here by writing far more than the
  // cap and watching this process's own heap.
  // `external`, not `heapUsed`: a Buffer's bytes live outside the JS heap, so a heap measurement
  // here would have been vacuous and would have passed against the broken version too.
  const usage = () => process.memoryUsage().external + process.memoryUsage().arrayBuffers;
  const before = usage();
  const result = await runShell({
    // ~64 MiB, thirty-two times the 2 MiB cap.
    command: "head -c 67108864 /dev/zero | tr '\\0' 'x'",
    timeout_ms: 60_000,
  });
  const grew = usage() - before;

  assert.equal(result.exit_code, 0);
  assert.ok(result.stdout.length < 3 * 1024 * 1024, `result was ${result.stdout.length} bytes`);
  assert.match(result.stdout, /\[stdout truncated: \d+ more bytes\]/);
  assert.ok(
    grew < 32 * 1024 * 1024,
    `buffers grew by ${Math.round(grew / 1024 / 1024)} MiB for 64 MiB of output`
  );
});
