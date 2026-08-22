/**
 * Tests for the host runner and the door it opens.
 *
 * The claims that matter are the safety ones: off by default the tool does not exist,
 * on it always asks, and a command is a single argument to the shell (so a filename
 * with a space or a semicolon in it is data, not more command).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRunner, hostRunnerConfig } from "./host-runner.ts";
import { buildTools } from "./tools.ts";
import { PolicyGate } from "./policy.ts";

test("config floors and caps the ceilings, and refuses a default working directory", () => {
  const config = hostRunnerConfig({ enabled: true, timeoutMs: 1, maxOutputBytes: 1 });
  assert.equal(config.enabled, true);
  assert.equal(config.cwd, undefined, "no cwd is invented");
  assert.ok(config.timeoutMs >= 1000, "timeout floored");
  assert.ok(config.maxOutputBytes >= 1000, "output floored");

  const big = hostRunnerConfig({ enabled: true, timeoutMs: 999_999_999 });
  assert.ok(big.timeoutMs <= 1_800_000, "timeout capped");
});

test("disabled means the tool is not offered at all — absent, not refused", () => {
  const without = buildTools(true, true, undefined, false).map(tool => tool.name);
  assert.ok(!without.includes("RunOnHost"), "an agent on a box without host exec never sees it");

  const withIt = buildTools(true, true, undefined, true).map(tool => tool.name);
  assert.ok(withIt.includes("RunOnHost"), "offered only when enabled");
});

test("host execution always needs approval, whatever the approval list says", () => {
  const gate = new PolicyGate({
    path: join(mkdtempSync(join(tmpdir(), "hostrun-policy-")), "policy.jsonl"),
    limits: {
      budgetWindowHours: 24,
      wakesPerWindow: 30,
      wakeWindowMinutes: 10,
      approvalRequiredTools: [],
      approvalRequiredCommands: [],
    },
  });
  const decision = gate.check({
    kind: "tool",
    agentId: "a1",
    agentName: "Ada",
    tool: "RunOnHost",
    input: { command: "echo hi" },
  });
  assert.ok(!decision.allow && decision.approval !== undefined, "it asked despite an empty list");
});

test("a disabled runner refuses to run, with a reason a person can act on", async () => {
  const runner = new HostRunner(hostRunnerConfig({ enabled: false }));
  assert.equal(runner.enabled, false);
  assert.match(runner.unavailableReason() ?? "", /turned off/);
  await assert.rejects(runner.run("echo hi"), /turned off/);
});

test("an enabled runner runs under its directory and returns output and code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hostrun-"));
  writeFileSync(join(dir, "marker.txt"), "here");
  try {
    const runner = new HostRunner(hostRunnerConfig({ enabled: true, cwd: dir }));
    assert.equal(runner.unavailableReason(), undefined);

    const ok = await runner.run("ls");
    assert.match(ok.stdout, /marker\.txt/, "ran in the configured directory");
    assert.equal(ok.code, 0);

    const bad = await runner.run("exit 3");
    assert.equal(bad.code, 3, "a non-zero exit is reported, not thrown");

    // The command is one argument to the shell: a filename with a space is data. If it
    // were interpolated into a command string, this would create two files.
    await runner.run('touch "a b.txt"');
    const listed = await runner.run("ls");
    assert.match(listed.stdout, /a b\.txt/);
    assert.ok(!/^a$/m.test(listed.stdout) && !/^b\.txt$/m.test(listed.stdout), "not split into two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output past the cap is truncated with a count, not dropped silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hostrun-cap-"));
  try {
    const runner = new HostRunner(hostRunnerConfig({ enabled: true, cwd: dir, maxOutputBytes: 1000 }));
    const result = await runner.run("head -c 5000 /dev/zero | tr '\\0' 'x'");
    assert.ok(result.stdout.length <= 1000, "capped");
    assert.ok(result.truncatedBytes > 0, "and said how much went");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
