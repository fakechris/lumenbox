/** A shell result's words (INV-1461): a command past its window says it runs on as a job and shows no exit code. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatExec, stillRunningNote } from "./exec-format.ts";

test("a finished command reads as before; one still running names its job first and no exit code", () => {
  const done = formatExec({ stdout: "ok\n", stderr: "", exit_code: 0, timed_out: false });
  assert.match(done, /exit code: 0[\s\S]*stdout:\nok/);
  const running = formatExec({ stdout: "building…\n", stderr: "", exit_code: -1, timed_out: false, still_running: { job_id: "job-abcdef12", pid: 42, log_path: "/home/box/work/.jobs/job-abcdef12.log" } }, undefined, 10_000);
  assert.match(running, /^\[still running after 10s — continuing as job-abcdef12 \(pid 42\)/);
  assert.doesNotMatch(running, /exit code/);
  assert.match(running, /stdout:\nbuilding…/);
  // The default wakes only on failure, so the note says what to do when the result is needed now (INV-1613).
  assert.match(stillRunningNote({ job_id: "job-1", pid: 1, log_path: "/l" }, 10_000), /woken only if it fails[\s\S]*Jobs wait for it now/);
  assert.match(stillRunningNote({ job_id: "job-1", pid: 1, log_path: "/l" }, 10_000, "wake"), /do not wait for it or poll it/);
  assert.match(stillRunningNote({ job_id: "job-1", pid: 1, log_path: "/l" }, 10_000, "record"), /next turn opens with a note/);
  assert.match(stillRunningNote({ job_id: "job-1", pid: 1, log_path: "/l" }, 10_000, "record", true), /only waits[\s\S]*instead of a sleep/);
  assert.match(formatExec({ stdout: "", stderr: "", exit_code: -1, timed_out: false, still_running: { job_id: "job-2", pid: 3, log_path: "/l" } }, undefined, 10_000, { onEnd: "record", waitOnly: true }), /only waits/);
});
