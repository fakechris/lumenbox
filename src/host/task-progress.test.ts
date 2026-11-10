import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import { newPursuit } from "./goal-mode.ts";
import { progressScope, summarizeTaskProgress, type ProgressContext } from "./task-progress.ts";
import { admittedTaskBinding } from "./execution-binding.ts";
import { progressLines } from "./task-progress-view.ts";
import { compileSurface } from "./show-ui.ts";
import { admitProgressMessage } from "./progress-admission.ts";
import type { InboundMessage } from "../agents/bus.ts";

function setup(path: string | null = null, goal = true) {
  const tasks = new TaskStore(path);
  const task = tasks.create({ title: "Inspect objects", requester: "p", assigneeId: "a", conversation: "chat", contract: { acceptance: "A person reviews the evidence" }, ...(goal ? { pursuit: newPursuit({ objective: "Inspect the collection", workId: "work" }) } : {}) })!;
  const open = (role: "executor" | "verifier" = "executor") => {
    const admission = tasks.progress.reserve(task.id, "work", goal ? role === "verifier" ? "verifier" : "continuation" : "new", progressScope(tasks.get(task.id)!))!;
    return tasks.progress.open({ taskId: task.id, admission, agentId: "a", conversation: role === "verifier" ? "verify" : "chat", turnId: role + "-turn", executionId: Math.random().toString(), workId: "work", role })!;
  };
  return { tasks, task, open };
}
function report(tasks: TaskStore, context: ProgressContext, objects: unknown[], extra: Record<string, unknown> = {}) {
  return { ...tasks.progress.info(context), reportId: Math.random().toString(), observedAt: new Date().toISOString(), unit: "objects", total: 70, objects, ...extra };
}

test("70 processed, 3 failed and 8 version-matched independent checks remain distinct", () => {
  const { tasks, task, open } = setup(), executor = open();
  const objects = Array.from({ length: 70 }, (_, n) => ({ id: "object-" + n, state: n < 3 ? "failed" : "succeeded", version: "v1" }));
  const input = report(tasks, executor, objects, { source: "independent-verifier", verified: 70 });
  tasks.progress.receive(executor, input, "tool:executor:report");
  tasks.progress.receive(executor, input, "tool:executor:retry");
  let current = summarizeTaskProgress(tasks.get(task.id)!)!;
  assert.deepEqual([current.sources[0]!.processed, current.sources[0]!.failed, current.sources[0]!.source], [70, 3, "agent-reported"]);
  assert.equal(current.sources[0]!.revision, 1, "same immutable report is idempotent");
  assert.equal(tasks.get(task.id)!.status, "doing", "progress never accepts or completes the task");
  tasks.setPursuit(task.id, p => ({ ...p, status: "verifying", verifying: { agentId: "a", taskConversation: "chat", conversation: "verify", attempt: 1, startedAt: new Date().toISOString() } }), "verify");
  const verifier = open("verifier"), sourceId = current.sources[0]!.id;
  const checked = tasks.progress.objects(verifier, sourceId).objects.slice(0, 8);
  tasks.progress.receive(verifier, report(tasks, verifier, [], { stage: "sample", total: null, checks: checked.map(row => ({ sourceId, id: row.id, version: row.version })) }), "tool:verifier:report");
  current = summarizeTaskProgress(tasks.get(task.id)!)!;
  assert.equal(current.sources.find(source => source.source === "independent-verifier")!.verified, 8);
  tasks.setPursuit(task.id, p => ({ ...p, status: "active", verifying: undefined }), "continue");
  const next = open();
  tasks.progress.receive(next, report(tasks, next, [{ id: "object-0", state: "succeeded", version: "v2" }]), "tool:executor:retry");
  current = summarizeTaskProgress(tasks.get(task.id)!)!;
  assert.equal(current.sources.find(source => source.source === "agent-reported")!.processed, 70, "retry upserts rather than adds an object");
  assert.equal(current.sources.find(source => source.source === "agent-reported")!.failed, 2);
  assert.equal(current.sources.find(source => source.source === "independent-verifier")!.verified, 7, "a changed version requires re-verification");
  assert.equal(current.sources.find(source => source.source === "independent-verifier")!.verificationUnmatched, 1);
});

test("old revisions, late files, paused work and closed physical grants cannot overwrite progress", () => {
  const { tasks, task, open } = setup(), context = open();
  const input = report(tasks, context, [{ id: "x", state: "failed", version: "v1" }]);
  tasks.progress.receive(context, input, "tool:first");
  assert.throws(() => tasks.progress.receive(context, { ...input, reportId: "out-of-order" }, "tool:old"), /Stale/);
  assert.throws(() => tasks.progress.receive(context, { ...input, objects: [] }, "tool:changed"), /cannot change content/);
  const next = report(tasks, context, [{ id: "x", state: "succeeded", version: "v2" }]);
  assert.equal(tasks.progress.file(JSON.stringify(next), { agentId: "other", conversation: "chat" }), false);
  assert.equal(tasks.progress.file('{"current":70,"total":70}', { agentId: "a", conversation: "chat" }), false, "legacy files have no execution authority");
  tasks.setPursuit(task.id, p => ({ ...p, status: "paused", pausedReason: "person" }), "pause");
  tasks.setPursuit(task.id, p => ({ ...p, status: "active", pausedReason: undefined }), "resume");
  assert.equal(tasks.progress.file(JSON.stringify(next), { agentId: "a", conversation: "chat" }), false);
  assert.throws(() => tasks.progress.receive(context, next, "tool:late"), /no longer current/);
  const fresh = open(), final = report(tasks, fresh, [{ id: "y", state: "succeeded", version: "v1" }]);
  tasks.progress.close(fresh);
  assert.equal(tasks.progress.file(JSON.stringify(final), { agentId: "a", conversation: "chat" }), false);
  assert.throws(() => tasks.progress.info(fresh), /no longer current/);
});

test("durable admission orders cannot reactivate an older root after a crash; reserved gaps do not replace current work", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-progress-order-")), path = join(dir, "tasks.jsonl");
  try {
    const { tasks, task } = setup(path, false);
    const a = tasks.progress.reserve(task.id, "work-a", "new")!, b = tasks.progress.reserve(task.id, "work-b", "new")!;
    const input = { taskId: task.id, agentId: "a", conversation: "chat", turnId: "t", executionId: "e", role: "executor" as const };
    assert.ok(tasks.progress.open({ ...input, admission: a, workId: "work-a" }));
    assert.ok(tasks.progress.open({ ...input, admission: b, workId: "work-b" }));
    tasks.progress.reserve(task.id, "never-admitted", "new");
    const restarted = new TaskStore(path);
    assert.equal(restarted.progress.open({ ...input, admission: a, workId: "work-a" }), undefined);
    assert.ok(restarted.progress.open({ ...input, admission: b, workId: "work-b" }));
    assert.equal(restarted.get(task.id)!.progress!.active!.workId, "work-b");
    const messages = [a, b].map(progressAdmission => ({ id: progressAdmission.id, taskBinding: { taskId: task.id, role: "executor", progressAdmission } })) as InboundMessage[];
    for (const inbound of [messages, [...messages].reverse()]) assert.equal(admittedTaskBinding({ agentId: "a", conversation: "chat", tasks: restarted, inbound })!.progressAdmission!.id, b.id);
    const prior = restarted.get(task.id)!;
    restarted.update(task.id, { title: "A different title-only target" }, "p");
    assert.notEqual(restarted.get(task.id)!.progress!.epoch, prior.progress!.epoch);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("producer snapshots survive context loss, page their versions and keep overlapping sources separate", () => {
  const { tasks, task, open } = setup(), context = open();
  tasks.progress.receive(context, report(tasks, context, Array.from({ length: 220 }, (_, n) => ({ id: "x" + n, state: "succeeded", version: "v1" })), { total: null }), "tool:objects");
  const sourceId = tasks.progress.info(context).sourceId, first = tasks.progress.objects(context, sourceId);
  assert.equal(first.objects.length, 100); assert.ok(first.nextCursor);
  assert.equal(tasks.progress.objects(context, sourceId, first.nextCursor!).objects.length, 100);
  tasks.progress.receive(context, report(tasks, context, [{ id: "x0", state: "failed", version: "v2" }], { total: null }), "tool:retry-after-compaction");
  assert.throws(() => tasks.progress.objects(context, sourceId, first.nextCursor!), /expired/);
  const parent = context.admission;
  const child = tasks.progress.open({ taskId: task.id, admission: { ...parent, kind: "child" }, role: "child", sourceIdentity: "fork-1", agentId: "a", conversation: "fork/1", turnId: "child", executionId: "ce", workId: "child-work" })!;
  tasks.progress.receive(child, report(tasks, child, [{ id: "x0", state: "failed", version: "v1" }], { total: null }), "tool:child");
  const summary = summarizeTaskProgress(tasks.get(task.id)!)!;
  assert.deepEqual(summary.sources.map(source => source.processed).sort((a, b) => a - b), [1, 220], "overlapping producers are not summed into 221");
  assert.throws(() => tasks.progress.objects(child, sourceId), /unavailable/);
});

test("progress commits fail before acknowledgement and compaction bounds repeated snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-progress-storage-")), path = join(dir, "tasks.jsonl");
  try {
    const { tasks, task, open } = setup(path), context = open();
    const initial = report(tasks, context, Array.from({ length: 1000 }, (_, n) => ({ id: "object-" + n, state: "succeeded", version: "v1" })), { total: null });
    tasks.progress.receive(context, initial, "tool:first");
    const before = tasks.get(task.id)!.progress!.revision, next = report(tasks, context, [{ id: "object-0", state: "failed", version: "v2" }], { total: null });
    renameSync(path, path + ".saved"); mkdirSync(path);
    assert.throws(() => tasks.progress.receive(context, next, "tool:unwritten"));
    assert.equal(tasks.get(task.id)!.progress!.revision, before, "an unwritten report does not appear in canonical state");
    rmSync(path, { recursive: true }); renameSync(path + ".saved", path);
    tasks.progress.receive(context, next, "tool:durable");
    for (let n = 0; n < 50; n++) tasks.progress.receive(context, report(tasks, context, [], { total: null }), "tool:update-" + n);
    assert.ok(statSync(path).size < 4_600_000, "the existing task journal is checkpointed by bytes, not allowed to grow with every full snapshot");
    const restarted = new TaskStore(path), summary = summarizeTaskProgress(restarted.get(task.id)!)!;
    assert.equal(summary.sources[0]!.processed, 1000); assert.equal(summary.sources[0]!.failed, 1);
    assert.equal(restarted.progress.file(JSON.stringify(next), { agentId: "a", conversation: "chat" }), false, "physical file grants die with their host");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queued callbacks inherit the captured epoch; a later resume cannot upgrade their authority", () => {
  const { tasks, task } = setup(), snapshot = tasks.get(task.id)!;
  tasks.setPursuit(task.id, p => ({ ...p, status: "paused", pausedReason: "person" }), "pause");
  tasks.setPursuit(task.id, p => ({ ...p, status: "active", pausedReason: undefined }), "resume");
  const message = { id: "old-callback", fromId: "user", fromName: "host", text: "continue", priority: false, receivedAt: new Date().toISOString(), conversation: "chat", goal: { taskId: task.id, workId: "work", seq: 1, personSeq: 0, progressScope: progressScope(snapshot) } } as InboundMessage;
  const admitted = admitProgressMessage(tasks, "a", message);
  assert.equal(admitted.taskBinding?.progressAdmission, undefined, "the delayed callback is not restamped with the current epoch");
  const fresh = admitProgressMessage(tasks, "a", { ...message, id: "fresh", goal: { ...message.goal!, progressScope: progressScope(tasks.get(task.id)!) } });
  assert.ok(fresh.taskBinding?.progressAdmission);
});


test("unknown totals remain unknown, count claims cannot go backwards, and capacity failures retain the prior snapshot", () => {
  const { tasks, task, open } = setup(), context = open();
  const counts = { processed: 70, succeeded: 67, failed: 3, skipped: 0, unknown: 0 };
  const input = { ...tasks.progress.info(context), unit: "objects", total: null, reportId: "counts-1", observedAt: new Date().toISOString(), counts };
  tasks.progress.receive(context, input, "tool:counts");
  const summary = summarizeTaskProgress(tasks.get(task.id)!)!;
  assert.match(progressLines(summary, "en").join("\n"), /total unknown/);
  assert.equal(progressLines(summary, "en").join("\n").includes("%"), false);
  assert.throws(() => tasks.progress.receive(context, { ...input, ...tasks.progress.info(context), reportId: "backwards", counts: { ...counts, processed: 69, succeeded: 66 } }, "tool:backwards"), /inconsistent/);
  const before = tasks.get(task.id)!.progress!.revision;
  const data = Array.from({ length: 1000 }, (_, n) => ({ id: "x".repeat(100) + n, state: "succeeded", version: "v1" }));
  const large = tasks.progress.info(context, "large collection");
  tasks.progress.receive(context, { ...large, unit: "objects", total: null, reportId: "large-1", observedAt: new Date().toISOString(), objects: data }, "tool:large");
  assert.throws(() => tasks.progress.receive(context, { ...tasks.progress.info(context, "large collection"), unit: "objects", total: null, reportId: "large-2", observedAt: new Date().toISOString(), objects: data.map(row => ({ ...row, id: "y" + row.id })) }, "tool:capacity"), /capacity/);
  assert.equal(tasks.get(task.id)!.progress!.revision, before + 1);
  assert.equal(tasks.progress.objects(context, large.sourceId).objects.length, 100);
  assert.equal(compileSurface({ surface: "p", components: [{ id: "root", component: "TaskProgress", taskId: task.id }] }, undefined).ok, true);
  assert.equal(compileSurface({ surface: "p", components: [{ id: "root", component: "TaskProgress", taskId: task.id, value: 100 }] }, undefined).ok, false, "canonical TaskProgress accepts no numeric props");
});
