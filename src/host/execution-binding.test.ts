import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import { TurnLedger } from "./resume.ts";
import { admittedTaskBinding } from "./execution-binding.ts";
import type { InboundMessage } from "../agents/bus.ts";

test("ordinary admission binds the exact source task, never another doing task in the conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "execution-binding-"));
  try {
    const tasks = new TaskStore(join(dir, "tasks.jsonl"));
    const wrong = tasks.create({ title: "Other job", requester: "p", assigneeId: "a", conversation: "chat" })!;
    tasks.update(wrong.id, { status: "doing" }, "a");
    const right = tasks.create({ title: "New job", requester: "p", assigneeId: "a", conversation: "chat", sourceMessageId: "message-A" })!;
    const inbound = [{ id: "message-A" }] as InboundMessage[];
    assert.equal(admittedTaskBinding({ agentId: "a", conversation: "chat", inbound, tasks })?.taskId, right.id);
    assert.equal(admittedTaskBinding({ agentId: "a", conversation: "chat", inbound: [{ id: "unrelated" }] as InboundMessage[], tasks }), undefined);
    assert.equal(admittedTaskBinding({ agentId: "a", conversation: "other", inbound, tasks }), undefined);
    assert.equal(admittedTaskBinding({ agentId: "a", conversation: "chat", inbound: [...inbound, { id: "other", taskBinding: { taskId: wrong.id, role: "executor" } } as InboundMessage], tasks }), undefined);
    const child = admittedTaskBinding({ agentId: "a", conversation: "fork/one", tasks,
      inbound: [{ id: "child", taskBinding: { taskId: right.id, role: "child", parent: { conversation: "chat", turnId: "parent", workId: "parent-work", forkId: "pw-one" } } }] as InboundMessage[] });
    assert.equal(child?.taskId, right.id);
    assert.equal(child?.role, "child");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a selection boundary survives restart and in-place attempts keep their own observation identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "execution-record-"));
  try {
    const path = join(dir, "turns.jsonl"), turns = new TurnLedger(path);
    turns.begin({ id: "turn", agentId: "a", about: "unbound", attempt: 1, executionId: "first" });
    turns.selectExecution({ event: "selection", id: "turn", recordId: "selection", executionId: "first", attempt: 1,
      taskBinding: { taskId: "task-B", role: "executor", selection: { turnId: "turn", toolUseId: "take" } }, toolUseId: "take", at: new Date().toISOString() });
    const resumed = new TurnLedger(path).interrupted()[0]!;
    assert.equal(resumed.taskBinding?.taskId, "task-B");
    turns.begin({ id: "turn", agentId: "a", about: "same logical turn", attempt: 2, executionId: "second", taskBinding: resumed.taskBinding });
    assert.equal(new TurnLedger(path).interrupted()[0]!.attempt, 2);
    const begins = turns.executionRecords().records.filter(r => r.event === "begin");
    assert.deepEqual(begins.map(b => b.executionId), ["first", "second"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Goal continuation and verifier attribution require the registered work and verification conversation", async () => {
  const { newPursuit } = await import("./goal-mode.ts");
  const dir = mkdtempSync(join(tmpdir(), "execution-goal-binding-"));
  try {
    const tasks = new TaskStore(join(dir, "tasks.jsonl"));
    const task = tasks.create({ title: "Goal", requester: "p", assigneeId: "a", conversation: "chat",
      pursuit: newPursuit({ objective: "check objects", workId: "work", chatKey: "chat" }) })!;
    const goal = { taskId: task.id, workId: "work", seq: 2, personSeq: 1 };
    const context = { agentId: "a", conversation: "chat", inbound: [], tasks, goal };
    assert.equal(admittedTaskBinding(context)?.taskId, task.id);
    assert.equal(admittedTaskBinding({ ...context, goal: { ...goal, workId: "stale" } }), undefined);
    tasks.setPursuit(task.id, p => ({ ...p, status: "verifying", verifying: {
      startedAt: new Date().toISOString(), conversation: "verify/one", agentId: "reviewer", attempt: 2,
    } }), "verification admission");
    const verification = { ...context, agentId: "reviewer", conversation: "verify/one",
      goal: { ...goal, verify: { attempt: 2, confirmedCommands: [] } } };
    assert.equal(admittedTaskBinding(verification)?.role, "verifier");
    assert.equal(admittedTaskBinding({ ...verification, conversation: "chat" }), undefined);
    assert.equal(admittedTaskBinding({ ...verification, agentId: "stranger" }), undefined);
    assert.equal(admittedTaskBinding({ ...verification, goal: { ...verification.goal, workId: "stale" } }), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
