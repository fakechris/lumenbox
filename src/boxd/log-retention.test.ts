/** The box keeps a bounded amount of its own output (INV-1558): one log has a ceiling, ended jobs' files age out. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "./job-service.ts";
import { jobLimitsFrom } from "./job-limits.ts";
import { logLimitsFrom, type LogLimits } from "./log-retention.ts";

function service(logs: Partial<LogLimits>) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-log-retention-"));
  const jobs = new JobService(dir, jobLimitsFrom({}), { ...logLimitsFrom({}), ...logs });
  return { dir, jobs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a log past its ceiling keeps its head and its end, and says how much was cut", async () => {
  const { jobs, cleanup } = service({ capBytes: 100_000, tailBytes: 20_000 });
  try {
    // 3000 numbered lines of ~100 bytes: 300 kB through a 100 kB ceiling.
    const started = jobs.start({ command: "for i in $(seq 1 3000); do printf 'line %05d %090d\\n' $i 0; done", nice: 0, scrubbedEnv: process.env });
    await jobs.wait({ job_id: started.job_id, timeout_ms: 20_000 });
    const log = readFileSync(started.log_path, "utf8");
    assert.ok(log.length < 110_000, `bounded: ${log.length} bytes`);
    assert.match(log.slice(0, 2_000), /^line 00001 /m, "the head is there");
    assert.match(log, /\[boxd\] this log reached \d+ MB: from here only the last \d+ MB are kept, written when the job ends/, "a marker where the cap was reached");
    assert.match(log, /\.\.\. \[\d+ bytes omitted\] \.\.\./);
    assert.match(log.trimEnd().split("\n").at(-1)!, /^line 03000 /, "the end is there");
  } finally {
    cleanup();
  }
});

test("a log under its ceiling is untouched", async () => {
  const { jobs, cleanup } = service({ capBytes: 100_000, tailBytes: 20_000 });
  try {
    const started = jobs.start({ command: "echo short", nice: 0, scrubbedEnv: process.env });
    await jobs.wait({ job_id: started.job_id, timeout_ms: 10_000 });
    const log = readFileSync(started.log_path, "utf8");
    assert.ok(log.endsWith("short\n") && !/bytes omitted|\[boxd\]/.test(log), log);
  } finally {
    cleanup();
  }
});

test("ended jobs' files age out and go oldest first past the total; running ones and other files stay", async () => {
  const { dir, jobs, cleanup } = service({ keepMs: 7 * 24 * 3_600_000, keepBytes: 2_500 });
  try {
    const now = Date.now();
    const age = (name: string, days: number) => utimesSync(join(dir, name), (now - days * 86_400_000) / 1000, (now - days * 86_400_000) / 1000);
    // Old and ended; recent and ended (two of them, oldest first past the total); an agent's own file in .jobs.
    for (const [id, days] of [["job-0000000a", 9], ["job-0000000b", 2], ["job-0000000c", 1]] as const) {
      writeFileSync(join(dir, `${id}.log`), Buffer.alloc(1000));
      writeFileSync(join(dir, `${id}.exit`), JSON.stringify({ job_id: id, exit_code: 0 }));
      age(`${id}.log`, days);
      age(`${id}.exit`, days);
    }
    writeFileSync(join(dir, "sources.json"), Buffer.alloc(5000));
    age("sources.json", 30);
    const running = jobs.start({ command: "echo ready; sleep 30", nice: 0, scrubbedEnv: process.env });
    await jobs.wait({ job_id: running.job_id, until: "ready", timeout_ms: 5_000 });
    utimesSync(running.log_path, (now - 30 * 86_400_000) / 1000, (now - 30 * 86_400_000) / 1000);

    const result = jobs.pruneLogs(now);
    assert.deepEqual(result.removedJobs.sort(), ["job-0000000a", "job-0000000b"], "the one past its age, then the oldest while over the total");
    assert.equal(existsSync(join(dir, "job-0000000c.log")), true);
    assert.equal(existsSync(running.log_path), true, "a running job's log is never removed, however old");
    assert.equal(existsSync(join(dir, "sources.json")), true, "not a name this daemon writes");
    assert.equal(jobs.get("job-0000000a"), undefined, "a removed job is forgotten, not listed with a missing log");
    assert.equal(JSON.parse(readFileSync(join(dir, ".retention.json"), "utf8")).removedFiles, 4, "the record box-doctor reads");
    const fresh = new JobService(join(dir, "not-yet"), jobLimitsFrom({}), logLimitsFrom({}));
    fresh.pruneLogs(now);
    assert.equal(existsSync(join(dir, "not-yet", ".retention.json")), true, "a fresh box, with no jobs directory yet, still leaves the record");
    jobs.kill(running.job_id);
    await jobs.wait({ job_id: running.job_id, timeout_ms: 5_000 });
  } finally {
    cleanup();
  }
});
