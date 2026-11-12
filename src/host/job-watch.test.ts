/** The watch on a command a turn let go of (INV-1461): its end wakes the agent under the job's policy (INV-1613), ends close together share one wake, the cap kills it, a chosen job is never touched. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_WATCH_CAP_MS, JobWatch, jobEndedNote, mergedEndsNote, type JobWatchBox } from "./job-watch.ts";

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

/**
 * Waits for what the test expects, then a little longer. A fixed 40 ms was enough on an idle machine
 * and not under a loaded suite (INV-1829): what should happen is waited for, up to two seconds; the
 * pause after it is what shows something happening that should not.
 */
async function settle(reached?: () => boolean, ms = 40): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (reached !== undefined && !reached() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, ms));
}

test("a failed job wakes the agent once in its conversation with the exit and the tail; the watch is then closed", async () => {
  const box = fakeBox([{ running: true }, { running: false, exit_code: 2, tail: "3 tests failed" }]);
  const woken: { agentId: string; conversation: string; text: string }[] = [];
  const watch = new JobWatch({ box: () => box, wake: async (agentId, conversation, text) => { woken.push({ agentId, conversation, text }); }, log: () => {}, pollMs: 5, mergeMs: 5 });
  watch.watch({ agentId: "a1", conversation: "feishu-oc_1", jobId: "job-aaaaaaaa", command: "npm test" });
  assert.equal(watch.openJobs("a1", "feishu-oc_1").length, 1);
  await settle(() => woken.length >= 1);
  assert.equal(woken.length, 1);
  assert.deepEqual([woken[0]!.agentId, woken[0]!.conversation], ["a1", "feishu-oc_1"]);
  assert.match(woken[0]!.text, /finished with exit code 2: job-aaaaaaaa[\s\S]*3 tests failed/);
  assert.equal(box.waits, 2);
  assert.deepEqual(box.killed, []);
  assert.equal(watch.openJobs("a1", "feishu-oc_1").length, 0);
});

test("by default an exit 0 does not wake: it is recorded for the next turn, and taking the record clears it", async () => {
  const box = fakeBox([{ running: false, exit_code: 0, tail: "all green" }]);
  const woken: string[] = [];
  const logged: string[] = [];
  const watch = new JobWatch({ box: () => box, wake: async (_a, _c, text) => { woken.push(text); }, log: line => logged.push(line), pollMs: 5, mergeMs: 5 });
  watch.watch({ agentId: "a1", conversation: "main", jobId: "job-ok", command: "sleep 20; curl -s http://host/api" });
  await settle(() => watch.openJobs("a1", "main").length === 0);
  assert.deepEqual(woken, []);
  const recorded = watch.takeRecorded("a1", "main");
  assert.equal(recorded.length, 1);
  assert.deepEqual([recorded[0]!.jobId, recorded[0]!.exit_code, recorded[0]!.log_path], ["job-ok", 0, "/jobs/job-ok.log"]);
  assert.deepEqual(watch.takeRecorded("a1", "main"), []);
  assert.deepEqual(watch.takeRecorded("a1", "other"), []);
  assert.ok(logged.some(line => /job-ok: ended \(exit 0\); recorded for a1's next turn \(on_end wake_on_failure\)/.test(line)));
});

test("on_end wake wakes on exit 0; record never wakes, even on failure; wake_when wakes on a matching line", async () => {
  const woken: string[] = [];
  const watch = new JobWatch({ box: () => fakeBox([{ running: false, exit_code: 0, tail: "ok" }]), wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, mergeMs: 5 });
  watch.watch({ agentId: "a1", conversation: "c1", jobId: "job-w", command: "make", onEnd: "wake" });
  await settle(() => woken.length >= 1);
  assert.equal(woken.length, 1);
  assert.match(woken[0]!, /exit code 0: job-w/);

  const failing = fakeBox([{ running: false, exit_code: 1, tail: "boom" }]);
  const quiet = new JobWatch({ box: () => failing, wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, mergeMs: 5 });
  quiet.watch({ agentId: "a1", conversation: "c2", jobId: "job-r", command: "make", onEnd: "record" });
  await settle(() => quiet.openJobs("a1", "c2").length === 0);
  assert.equal(woken.length, 1);
  assert.equal(quiet.takeRecorded("a1", "c2").length, 1);

  const ready = fakeBox([{ running: false, exit_code: 0, tail: "listening on 8080" }]);
  const named = new JobWatch({ box: () => ready, wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, mergeMs: 5 });
  named.watch({ agentId: "a1", conversation: "c3", jobId: "job-l", command: "serve", onEnd: "wake_on_failure", wakeWhen: "listening" });
  await settle(() => woken.length >= 2);
  assert.equal(woken.length, 2);
  assert.match(woken[1]!, /job-l/);
});

test("ends that wake within one window are merged into a single wake; a different conversation gets its own", async () => {
  const woken: { conversation: string; text: string }[] = [];
  const watch = new JobWatch({ box: () => fakeBox([{ running: false, exit_code: 1, tail: "x" }]), wake: async (_a, conversation, text) => { woken.push({ conversation, text }); }, log: () => {}, pollMs: 5, mergeMs: 30 });
  for (let i = 0; i < 5; i++) watch.watch({ agentId: "a1", conversation: "main", jobId: `job-${i}`, command: `step ${i}` });
  watch.watch({ agentId: "a1", conversation: "fork-1", jobId: "job-f", command: "other" });
  await settle(() => woken.length >= 2, 80);
  assert.equal(woken.length, 2);
  const main = woken.find(w => w.conversation === "main")!;
  assert.match(main.text, /^\[5 commands you started earlier ended within a few seconds of each other; all of them follow.\]/);
  for (let i = 0; i < 5; i++) assert.match(main.text, new RegExp(`exit code 1: job-${i}`));
  assert.match(woken.find(w => w.conversation === "fork-1")!.text, /^\[A command you started earlier/);
  assert.equal(mergedEndsNote(["one"]), "one");
});

test("past the cap the job is killed and the agent told so; watching the same job twice watches it once; an uncapped job is left alone", async () => {
  let clock = 0;
  const box = fakeBox([{ running: true }, { running: true }, { running: false, exit_code: 137 }]);
  const woken: string[] = [];
  const watch = new JobWatch({ box: () => box, wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, capMs: 100, mergeMs: 5, now: () => clock });
  watch.watch({ agentId: "a1", conversation: "c", jobId: "job-bbbbbbbb", command: "sleep 999" });
  watch.watch({ agentId: "a1", conversation: "c", jobId: "job-bbbbbbbb", command: "sleep 999" });
  assert.equal(watch.openJobs("a1", "c").length, 1);
  clock = 1_000;
  await settle(() => woken.length >= 1);
  assert.deepEqual(box.killed, ["job-bbbbbbbb"]);
  assert.equal(woken.length, 1);
  assert.match(woken[0]!, /was stopped after 30 minutes/);
  assert.match(jobEndedNote({ agentId: "a", conversation: "c", jobId: "job-x", command: "x", startedAt: 0 }, { log_path: "/l", tail: "" }, true), new RegExp(`${Math.round(JOB_WATCH_CAP_MS / 60_000)} minutes`));

  // A background job the agent asked to hear about: past the cap it is still running and still not killed.
  const server = fakeBox([{ running: true }, { running: true }, { running: true }, { running: false, exit_code: 0 }]);
  const uncapped = new JobWatch({ box: () => server, wake: async (_a, _c, text) => { woken.push(text); }, log: () => {}, pollMs: 5, capMs: 100, mergeMs: 5, now: () => clock });
  uncapped.watch({ agentId: "a1", conversation: "c", jobId: "job-srv", command: "node server.js", onEnd: "wake", capped: false });
  clock = 5_000;
  await settle(() => woken.length >= 2, 60);
  assert.deepEqual(server.killed, []);
  assert.equal(woken.length, 2);
  assert.match(woken[1]!, /exit code 0: job-srv/);
});
