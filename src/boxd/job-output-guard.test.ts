/** A job cannot write without end, nor fill the workspace (INV-1573). Against real processes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "./job-service.ts";
import { JobLimitError, jobLimitsFrom } from "./job-limits.ts";
import { logLimitsFrom } from "./log-retention.ts";
import { diskRefusal, outputLimitsFrom, outputRefusal, type DiskSpace } from "./job-output-guard.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

test("the waterline is the larger of 512 MiB and 5% of the volume; the quota is a ceiling on what one job writes", () => {
  const limits = outputLimitsFrom({});
  assert.equal(limits.outputBytes, 1024 * MB);
  assert.equal(diskRefusal({ free: 600 * MB, total: 4 * GB }, limits), undefined, "600 MB free of 4 GB: above 512 MiB");
  assert.match(diskRefusal({ free: 400 * MB, total: 4 * GB }, limits) ?? "", /400 MB free, below the 512 MB kept free/);
  assert.match(diskRefusal({ free: 3 * GB, total: 100 * GB }, limits) ?? "", /below the 5120 MB kept free/, "5% of 100 GB wins over 512 MiB");
  assert.equal(diskRefusal(undefined, limits), undefined, "unknown space refuses nothing");
  assert.equal(outputRefusal(1024 * MB, limits), undefined);
  assert.match(outputRefusal(1025 * MB, limits) ?? "", /wrote 1025 MB of output, past the 1024 MB/);
  assert.equal(outputRefusal(50 * GB, outputLimitsFrom({ BOXD_JOB_OUTPUT_MAX_MB: "0" })), undefined, "0 turns the quota off");
});

function service(output: { outputBytes: number }, space: () => DiskSpace | undefined = () => ({ free: 100 * GB, total: 200 * GB })) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-job-output-"));
  const jobs = new JobService(dir, jobLimitsFrom({}), logLimitsFrom({}), { ...outputLimitsFrom({}), outputBytes: output.outputBytes, checkEvery: 64 * 1024 }, space);
  const start = (command: string) => jobs.start({ command, nice: 0, scrubbedEnv: process.env });
  const cleanup = async () => {
    const running = jobs.list().filter(job => job.running);
    for (const job of running) jobs.kill(job.job_id);
    for (const job of running) await jobs.wait({ job_id: job.job_id, timeout_ms: 5_000 });
    rmSync(dir, { recursive: true, force: true });
  };
  return { jobs, start, cleanup };
}

test("a job that writes without end is stopped past its quota, says why, and another job runs on", async () => {
  const { jobs, start, cleanup } = service({ outputBytes: 2 * MB });
  try {
    const quiet = start("echo ready; sleep 30");
    const loud = start("yes 'a line of output that never ends'");
    const ended = await jobs.wait({ job_id: loud.job_id, timeout_ms: 15_000 });
    assert.equal(ended?.running, false, "the writer was stopped");
    assert.match(readFileSync(loud.log_path, "utf8"), /\[boxd\] stopped: this job wrote [\d.]+ MB of output, past the 2 MB one job may write/);
    assert.equal(jobs.get(quiet.job_id)?.running, true, "the quiet job is untouched");
  } finally {
    await cleanup();
  }
});

test("below the waterline a new job is refused with the reason, and a job already writing is stopped", async () => {
  let space: DiskSpace = { free: 100 * GB, total: 200 * GB };
  const { jobs, start, cleanup } = service({ outputBytes: 0 }, () => space);
  try {
    const writer = start("yes 'still writing'");
    await jobs.wait({ job_id: writer.job_id, until: "still writing", timeout_ms: 5_000 });
    space = { free: 300 * MB, total: 200 * GB };
    const ended = await jobs.wait({ job_id: writer.job_id, timeout_ms: 15_000 });
    assert.equal(ended?.running, false);
    assert.match(readFileSync(writer.log_path, "utf8"), /\[boxd\] stopped: the box's work volume has 300 MB free, below the 10240 MB kept free/);
    assert.throws(() => start("echo hi"), (error: unknown) => error instanceof JobLimitError && /work volume has 300 MB free/.test(error.message));
    space = { free: 100 * GB, total: 200 * GB };
    assert.doesNotThrow(() => start("echo hi"), "room again: jobs start");

    // A job that fills the disk through a file writes nothing to its output; what it wrote is measured.
    const filler = start("echo ready; sleep 30"), idle = start("echo ready; sleep 30");
    for (const job of [filler, idle]) await jobs.wait({ job_id: job.job_id, until: "ready", timeout_ms: 5_000 });
    const table = [filler, idle].map(job => ({ pid: job.pid, ppid: 1, pgid: job.pid }));
    let fillerWrote = 1_000;
    const written = (pid: number) => (pid === filler.pid ? fillerWrote : 500);
    assert.deepEqual(jobs.guardDisk(table, written), [], "the first look only takes the baseline");
    space = { free: 300 * MB, total: 200 * GB };
    fillerWrote = 900 * MB;
    assert.deepEqual(jobs.guardDisk(table, written), [filler.job_id], "below the waterline, the job that wrote since the last look is stopped; the idle one is not");
    await jobs.wait({ job_id: filler.job_id, timeout_ms: 5_000 });
    assert.match(readFileSync(filler.log_path, "utf8"), /\[boxd\] stopped: the box's work volume has 300 MB free/);
    assert.equal(jobs.get(idle.job_id)?.running, true);
  } finally {
    await cleanup();
  }
});
