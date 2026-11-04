/** Stopping a job stops everything it started, `timeout`'s own group included (INV-1556). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "./job-service.ts";
import { readProcessTable, treeOf } from "./process-tree.ts";

test("the tree is everything under the job, and only groups led from inside it are signalled", () => {
  // 100 = the job's shell (its own group); 101 = `timeout`, which made group 101; 102 = the scan under it;
  // 103 = a grandchild that joined boxd's group 1 — the process is killed, the group is not; 200 = someone else's.
  const table = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 101, ppid: 100, pgid: 101 },
    { pid: 102, ppid: 101, pgid: 101 },
    { pid: 103, ppid: 102, pgid: 1 },
    { pid: 200, ppid: 1, pgid: 200 },
  ];
  const { pids, groups } = treeOf(100, table);
  assert.deepEqual(pids.sort(), [101, 102, 103]);
  assert.deepEqual(groups.sort(), [100, 101]);
});

const linux = existsSync("/proc/self/stat");

/** Running, as opposed to gone or a zombie waiting for whoever adopted it to reap it. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

test("killing a job stops a scan `timeout` moved into its own group", { skip: linux ? false : "needs /proc (Linux; CI runs it)" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-jobs-tree-"));
  const jobs = new JobService(dir);
  try {
    const started = jobs.start({ command: "timeout 60 sleep 617; echo after", nice: 0, scrubbedEnv: process.env });
    let sleeper: number | undefined;
    for (let i = 0; i < 100 && sleeper === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      sleeper = treeOf(started.pid, readProcessTable()).pids.find(pid => {
        try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep\u0000617"); } catch { return false; }
      });
    }
    assert.ok(sleeper !== undefined, "the sleep under timeout started");
    jobs.kill(started.job_id);
    const ended = await jobs.wait({ job_id: started.job_id, timeout_ms: 5_000 });
    assert.equal(ended?.running, false);
    for (let i = 0; i < 40 && alive(sleeper); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(sleeper), false, "the sleep timeout was running is gone too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
