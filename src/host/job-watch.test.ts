/** The watch on a command a turn let go of (INV-1461): its end wakes the agent, the cap kills it, a chosen job is never touched. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_WATCH_CAP_MS, JobWatch, jobEndedNote, type JobWatchBox } from "./job-watch.ts";

function fakeBox(script: { running: boolean; exit_code?: number; tail?: string }[]): JobWatchBox & { killed: string[]; waits: number } {
  const box = {
    killed: [] as string[],
    waits: 0,
    async waitForJob(request: { job_id: string }) {
      box.waits += 1;
      const step = script.shift() ?? { running: false, exit_code: 0 };
      return { ...step, log_path: `/jobs/${request.job_id}.log`, tail: step.tail ?? "", reason: step.running ? "timeout" : "exited" };
    },
    async killJob(jobId: string) { box.killed.push(jobId); },
  };
  return box;
}

test("when the job ends, the agent is woken once in its conversation with the exit and the tail; the watch is then closed", async () => {
  const box = fakeBox([{ running: true }, { running: false, exit_code: 2, tail: "3 tests failed" }]);
  const woken: { agentId: string; conversation: string; text: string }[] = [];
  const watch = new JobWatch({ box: () => box, wake: async (agentId, conversation, text) => { woken.push({ agentId, conversation, text }); }, log: () => {}, pollMs: 5 });
  watch.watch({ agentId: "a1", conversation: "feishu-oc_1", jobId: "job-aaaaaaaa", command: "npm test" });
  assert.equal(watch.openJobs("a1", "feishu-oc_1").length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(woken.length, 1);
  assert.deepEqual([woken[0]!.agentId, woken[0]!.conversation], ["a1", "feishu-oc_1"]);
  assert.match(woken[0]!.text, /finished with exit code 2: job-aaaaaaaa[\s\S]*3 tests failed/);
  assert.equal(box.waits, 2);
  assert.deepEqual(box.killed, []);
  assert.equal(watch.openJobs("a1", "feishu-oc_1").length, 0);
});

test("past the cap the job is killed and the agent told so; watching the same job twice watches it once", async () => {
  let clock = 0;
  const box = fakeBox([{ running: true }, { running: true }, { running: false, exit_code: 137 }]);
  const woken: string[] = [];
  const watch = new JobWatch({ box: () => box, wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, capMs: 100, now: () => clock });
  watch.watch({ agentId: "a1", conversation: "c", jobId: "job-bbbbbbbb", command: "sleep 999" });
  watch.watch({ agentId: "a1", conversation: "c", jobId: "job-bbbbbbbb", command: "sleep 999" });
  assert.equal(watch.openJobs("a1", "c").length, 1);
  clock = 1_000;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(box.killed, ["job-bbbbbbbb"]);
  assert.equal(woken.length, 1);
  assert.match(woken[0]!, /was stopped after 30 minutes/);
  assert.match(jobEndedNote({ agentId: "a", conversation: "c", jobId: "job-x", command: "x", startedAt: 0 }, { log_path: "/l", tail: "" }, true), new RegExp(`${Math.round(JOB_WATCH_CAP_MS / 60_000)} minutes`));
});
