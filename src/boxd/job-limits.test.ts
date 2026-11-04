/**
 * One agent's background work cannot take the box (INV-1557): a cap on how many jobs it runs at
 * once, and a measured ceiling on what one job's processes hold. Against real processes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "./job-service.ts";
import { JobLimitError, jobLimitsFrom } from "./job-limits.ts";
import { runShell } from "./shell-service.ts";

function service(limits = { perAgent: 2, memoryBytes: 64 * 1024 * 1024 }) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-job-limits-"));
  const jobs = new JobService(dir, limits);
  const start = (actor: string | undefined, command = "sleep 30") => jobs.start({ command, nice: 0, scrubbedEnv: process.env, ...(actor !== undefined ? { actor } : {}) });
  const cleanup = async () => {
    const running = jobs.list().filter(job => job.running);
    for (const job of running) jobs.kill(job.job_id);
    for (const job of running) await jobs.wait({ job_id: job.job_id, timeout_ms: 5_000 });
    rmSync(dir, { recursive: true, force: true });
  };
  return { jobs, start, cleanup };
}

test("an agent at its limit is refused a new job with what it is running; another agent and the host are not", async () => {
  const { jobs, start, cleanup } = service();
  try {
    const first = start("agent:vic"), second = start("agent:vic");
    assert.throws(() => start("agent:vic", "rg -n t1290 .spool"), (error: unknown) =>
      error instanceof JobLimitError && error.message.includes("2 background jobs") && error.message.includes(first.job_id) && /Jobs → kill/.test(error.message));
    assert.doesNotThrow(() => start("agent:ada"), "another agent has its own allowance");
    assert.doesNotThrow(() => start("host:memory-mirror"), "the host's housekeeping is not an agent's job");
    assert.doesNotThrow(() => start(undefined), "an unlabelled caller is not counted");
    assert.deepEqual(jobs.list().filter(job => job.owner === "agent:vic").map(job => job.pid! > 0), [true, true], "status names owner and pid");
    jobs.kill(second.job_id);
  } finally {
    await cleanup();
  }
});

test("once one of its jobs ends, the agent may start another", async () => {
  const { jobs, start, cleanup } = service();
  try {
    const first = start("agent:vic");
    start("agent:vic");
    jobs.kill(first.job_id);
    await jobs.wait({ job_id: first.job_id, timeout_ms: 5_000 });
    assert.doesNotThrow(() => start("agent:vic"));
  } finally {
    await cleanup();
  }
});

test("a command that outlives its window while the agent is at its limit is stopped and told why, not waited on", async () => {
  const startedAt = Date.now();
  const result = await runShell({ command: "sleep 30", foreground_ms: 300, timeout_ms: 20_000 }, {}, () => {
    throw new JobLimitError("You already have 4 background jobs running");
  });
  assert.ok(Date.now() - startedAt < 5_000, "the turn is not held for the whole timeout");
  assert.equal(result.exit_code, 137);
  assert.match(result.stderr, /stopped after 0s instead of continuing as a background job: You already have 4 background jobs running/);
  assert.equal(result.still_running, undefined);
});

test("a job whose processes hold more than one job may is stopped, and its log ends saying why", async () => {
  const { jobs, start, cleanup } = service();
  try {
    const big = start("agent:vic", "echo ready; sleep 30"), small = start("agent:ada", "echo ready; sleep 30");
    // Running, as the guard's three-second tick finds a job — not mid-spawn, before it has its own group.
    for (const job of [big, small]) assert.equal((await jobs.wait({ job_id: job.job_id, until: "ready", timeout_ms: 5_000 }))?.reason, "matched");
    // The measurement is injected; the kill and the record are real.
    const table = [{ pid: big.pid, ppid: 1, pgid: big.pid }, { pid: small.pid, ppid: 1, pgid: small.pid }];
    const stopped = jobs.guardMemory(table, pid => (pid === big.pid ? 1800 * 1024 * 1024 : 10 * 1024 * 1024));
    assert.deepEqual(stopped, [big.job_id]);
    const ended = await jobs.wait({ job_id: big.job_id, timeout_ms: 5_000 });
    assert.equal(ended?.running, false);
    assert.match(readFileSync(big.log_path, "utf8"), /\[boxd\] stopped: this job's processes held 1800 MB, past the 64 MB one job may hold/);
    assert.equal(jobs.get(small.job_id)?.running, true, "the other agent's job is untouched");
  } finally {
    await cleanup();
  }
});

test("the limits come from the environment, default to four jobs and a gigabyte, and 0 turns one off", () => {
  assert.deepEqual(jobLimitsFrom({}), { perAgent: 4, memoryBytes: 1024 * 1024 * 1024 });
  assert.deepEqual(jobLimitsFrom({ BOXD_JOBS_PER_AGENT: "0", BOXD_JOB_MEMORY_MB: "0" }), { perAgent: 0, memoryBytes: 0 });
  assert.deepEqual(jobLimitsFrom({ BOXD_JOBS_PER_AGENT: "many" }).perAgent, 4, "a value that is not a number is ignored, not zero");
});
