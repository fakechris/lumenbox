import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "./tasks.ts";
import { ResultChecks } from "./result-check-policy.ts";
import { workReading, workReference, workSource } from "./work-reading.ts";
import { evidenceDigest } from "./review-dispatch.ts";
import { attentionFor } from "./attention.ts";

test("an agent reviewer is not evidence that a check is running; the requester still sees the review decision", () => {
  const store = new TaskStore(null), checks = new ResultChecks();
  const task = store.create({ title: "Install the requested skill", requester: "person", assigneeId: "worker", reviewerId: "checker", origin: { kind: "user" } })!;
  store.deliveryCommand(task.id, "submit", "worker"); const current = store.get(task.id)!;
  const reading = workReading(current, { checks: checks.snapshot(current), stage: { active: false, questionPending: false, undelivered: false, reviewerIsAgent: true, checkPending: false } });
  assert.equal(reading.phase, "review"); assert.equal(reading.checks.state, "manual");
  assert.equal(reading.checks.result, "notChecked");
  const attention = attentionFor({ principalId: "person", identities: [], tasks: [current], questions: [], nameOf: id => id, agentIds: new Set(["worker", "checker"]), checkPending: () => false });
  assert.ok(attention.mine.some(row => row.ref === task.id && row.kind === "review"));
});

test("source is explicit provenance, never a title pattern or the current selected agent", () => {
  const store = new TaskStore(null), task = store.create({ title: "User task: not an internal probe", requester: "web" })!;
  assert.equal(workSource(task), "unknown");
  assert.equal(workSource({ ...task, origin: { kind: "internal" } }), "internal");
  assert.equal(workSource({ ...task, origin: { kind: "user", parentId: "parent" } }), "collaboration");
  const checks = new ResultChecks();
  const reading = workReading({ ...task, status: "doing" }, { checks: checks.snapshot(task), stage: { active: false, questionPending: false, undelivered: false } });
  const blocked = workReading({ ...task, workRoot: { state: { id: "work", owner: "worker", conversation: "main", generation: 1, epoch: 0, status: "waiting", wait: "capability", reason: "required tool unavailable: bash", unavailable: [{ participant: "worker", tool: "bash" }], messages: [], peers: [], awaiting: [] } } }, { checks: checks.snapshot(task), stage: { active: false, questionPending: false, undelivered: false } });
  assert.deepEqual(blocked.blocker, { kind: "capability", tools: ["bash"] });
  assert.equal(reading.reason, "historicalWaiting"); assert.equal(reading.boundary, "historical");
  assert.equal(reading.actions.some(action => action.kind === "conversation"), false);
});

test("unreadable and removed references have the same non-leaking boundary; readable work keeps a meaningful link", () => {
  const store = new TaskStore(null), privateTask = store.create({ title: "PRIVATE REQUEST", requester: "other" })!;
  const denied = workReference(privateTask.id, "dependency", id => store.get(id), () => false);
  const missing = workReference("deleted", "dependency", id => store.get(id), () => true);
  assert.deepEqual(denied, missing);
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE REQUEST|t1/);
  const readable = workReference(privateTask.id, "dependency", id => store.get(id), () => true);
  assert.equal(readable.title, privateTask.title); assert.equal(readable.id, privateTask.id);
});

test("collaboration references are bounded while retaining the original goal and evidence version", () => {
  const store = new TaskStore(null), task = store.create({ title: "Original user goal", requester: "person" })!, checks = new ResultChecks();
  const reading = workReading(task, { checks: checks.snapshot(task), stage: { active: false, questionPending: false, undelivered: false }, references: Array.from({ length: 1600 }, (_, n) => ({ title: "Related activity " + n, id: "child-" + n, availability: "available", relation: "collaboration" })) });
  assert.equal(reading.title, task.title); assert.equal(reading.references.length, 12); assert.equal(reading.moreReferences, 1588);
  assert.equal(reading.evidenceVersion.length, 16); assert.ok(JSON.stringify(reading).length < 4000);
});


test("check results retain their original reviewer threshold when future authorization changes", () => {
  const store = new TaskStore(null), task = store.create({ title: "Install skill", requester: "person" })!;
  const digest = evidenceDigest(task), stage = { active: false, questionPending: false, undelivered: false };
  const checks = { policy: { mode: "manual" as const }, rounds: 1, dispatches: 2, calls: 2, reservedCost: 0, plans: [{ id: "original-check", taskId: task.id, digest, goal: "goal", reviewers: ["a", "b"], at: "now", deadline: 1, phase: "stopped" as const }] };
  const verdicts = [{ taskId: task.id, digest, reviewerId: "a", verdict: "pass" as const, basis: "verified", at: "now" }, { taskId: task.id, digest, reviewerId: "b", verdict: "none" as const, basis: "incomplete", at: "now" }];
  assert.equal(workReading(task, { checks, stage, verdicts }).checks.result, "incomplete");
  assert.equal(workReading(task, { checks, stage, verdicts: [...verdicts, { ...verdicts[0]!, reviewerId: "unassigned" }] }).checks.result, "incomplete");
});
