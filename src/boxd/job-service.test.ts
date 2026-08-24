/**
 * Background jobs, against real processes.
 *
 * The claims worth pinning: a job answers before it finishes, its output is complete
 * on disk rather than truncated into a tool result, a wait can end on a line appearing
 * instead of only on exit, and a killed job stops.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "./job-service.ts";

function service(): { jobs: JobService; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-jobs-"));
  return {
    jobs: new JobService(dir),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const start = (jobs: JobService, command: string) =>
  jobs.start({ command, nice: 0, scrubbedEnv: process.env });

test("a job answers immediately and its output lands in a file, whole", async () => {
  const { jobs, cleanup } = service();
  try {
    const began = Date.now();
    const started = start(jobs, "echo first; sleep 0.4; echo second; echo oops >&2");
    assert.ok(Date.now() - began < 300, "starting a job does not wait for it");
    assert.match(started.job_id, /^job-/);
    assert.ok(started.pid > 0);

    const waited = await jobs.wait({ job_id: started.job_id, timeout_ms: 5_000 });
    assert.equal(waited?.reason, "exited");
    assert.equal(waited?.exit_code, 0);
    assert.equal(waited?.running, false);

    // Both streams, interleaved, complete on disk — not a truncated tool result.
    const log = readFileSync(started.log_path, "utf8");
    assert.match(log, /first/);
    assert.match(log, /second/);
    assert.match(log, /oops/, "stderr rides in the same file, in order");
    assert.match(waited!.tail, /second/);
    assert.ok(waited!.log_bytes > 0);
  } finally {
    cleanup();
  }
});

test("a wait can end when the line appears, not only when the job does", async () => {
  const { jobs, cleanup } = service();
  try {
    // Prints its readiness, then keeps running — the shape of every dev server.
    const started = start(jobs, "echo starting; sleep 0.3; echo listening on 3000; sleep 30");
    const waited = await jobs.wait({
      job_id: started.job_id,
      until: "listening on 3000",
      timeout_ms: 8_000,
    });
    assert.equal(waited?.reason, "matched");
    assert.equal(waited?.running, true, "matched is not finished");

    // And it can be stopped, which is the other half of starting something endless.
    const killed = jobs.kill(started.job_id);
    assert.ok(killed !== undefined);
    const after = await jobs.wait({ job_id: started.job_id, timeout_ms: 5_000 });
    assert.equal(after?.running, false);
  } finally {
    cleanup();
  }
});

test("a wait that runs out of time says so, and the job carries on", async () => {
  const { jobs, cleanup } = service();
  try {
    const started = start(jobs, "sleep 5");
    const waited = await jobs.wait({ job_id: started.job_id, timeout_ms: 200 });
    assert.equal(waited?.reason, "timeout");
    assert.equal(waited?.running, true, "a wait ending is not the job ending");
    assert.equal(jobs.list().length, 1);
    assert.equal(jobs.get(started.job_id)?.running, true);
    jobs.kill(started.job_id);
  } finally {
    cleanup();
  }
});

test("asking about a job nobody started answers nothing, rather than inventing one", async () => {
  const { jobs, cleanup } = service();
  try {
    assert.equal(jobs.get("job-nope"), undefined);
    assert.equal(jobs.kill("job-nope"), undefined);
    assert.equal(await jobs.wait({ job_id: "job-nope" }), undefined);
  } finally {
    cleanup();
  }
});
