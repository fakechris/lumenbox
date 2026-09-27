import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import {
  checklistAdditions,
  GOAL_GATE_ACTOR,
  goalCommand,
  newPursuit,
  parseGoalCommand,
  pursuitBlockers,
  renderPursuit,
  taskStatusFor,
  type GoalCommandDeps,
} from "./goal-mode.ts";

const T0 = new Date("2026-09-27T09:00:00Z");

function board() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-goal-mode-"));
  return { tasks: new TaskStore(join(dir, "tasks.jsonl")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function deps(tasks: TaskStore, over: Partial<GoalCommandDeps> = {}): GoalCommandDeps {
  return { tasks, mayUse: () => true, contextMode: () => "normal", blockers: () => [], workId: () => "work-1", now: () => T0, ...over };
}

const input = { agentId: "nova", conversation: "feishu-private", requester: "principal-user", privateChat: true };

test("the command grammar: one-word subcommands, everything else is an objective", () => {
  assert.deepEqual(parseGoalCommand("/goal"), { kind: "status" });
  assert.deepEqual(parseGoalCommand("/goal   "), { kind: "status" });
  assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "pause" });
  assert.deepEqual(parseGoalCommand("/goal RESUME"), { kind: "resume" });
  assert.deepEqual(parseGoalCommand("/goal clear"), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("/goal confirm 3"), { kind: "confirm", index: 3 });
  assert.deepEqual(parseGoalCommand("/goal confirm x"), { kind: "usage" });
  assert.deepEqual(parseGoalCommand("/goal replace 把报告改成英文"), { kind: "replace", objective: "把报告改成英文" });
  assert.deepEqual(parseGoalCommand("/goal replace"), { kind: "usage" });
  assert.deepEqual(parseGoalCommand("/goal pause the build until Friday"), { kind: "create", objective: "pause the build until Friday" }, "a sentence starting with a subcommand word is an objective");
  assert.deepEqual(parseGoalCommand("/goal 写一份季度报告"), { kind: "create", objective: "写一份季度报告" });
});

test("a pursuit's board status follows its state, and only a running one holds the conversation", () => {
  assert.equal(taskStatusFor({ status: "active" }), "doing");
  assert.equal(taskStatusFor({ status: "verifying" }), "doing");
  assert.equal(taskStatusFor({ status: "paused" }), "blocked");
  assert.equal(taskStatusFor({ status: "complete" }), "review");
  assert.equal(taskStatusFor({ status: "cleared" }), "dropped");
  const running = { id: "t1", conversation: "c", pursuit: newPursuit({ objective: "x", workId: "w" }) };
  const paused = { id: "t2", conversation: "c", pursuit: { ...newPursuit({ objective: "y", workId: "w2" }), status: "paused" as const } };
  assert.deepEqual(pursuitBlockers([running, paused, { id: "t3", conversation: "other", pursuit: newPursuit({ objective: "z", workId: "w3" }) }], "c"), ["目标 t1 正在推进（active）：先 /goal pause 或 /goal clear"]);
});

test("checklist additions are clamped, typed, and never empty", () => {
  const added = checklistAdditions([], [{ text: "lint passes", command: "npm run lint", expect_exit: 0 }, { text: "report exists", artifact: "/home/box/work/report.md" }, { text: " judged  by reading " }]);
  assert.ok("items" in added);
  assert.deepEqual(added.items.map(item => [item.id, item.text, item.check?.kind]), [["c1", "lint passes", "command"], ["c2", "report exists", "artifact"], ["c3", "judged by reading", undefined]]);
  assert.deepEqual(checklistAdditions([], []), { refused: "items must be a non-empty array" });
  assert.deepEqual(checklistAdditions([], [{ text: "" }]), { refused: "every item needs text" });
  const rendered = renderPursuit({ id: "t9", pursuit: { ...newPursuit({ objective: "a <b> & c", workId: "w" }), checklist: added.items } });
  assert.match(rendered, /<objective>\na &lt;b&gt; &amp; c\n<\/objective>/, "the objective is data, escaped");
  assert.match(rendered, /1\. \[unverified\] lint passes — check: `npm run lint` exits 0 \(proposed; runs only once the person confirms\)/);
  assert.match(rendered, /Stopping is not finishing/);
});

test("/goal creates once per message, refuses a second objective, and the person pauses, resumes, confirms and clears", () => {
  const { tasks, cleanup } = board();
  try {
    const d = deps(tasks);
    const created = goalCommand(d, { ...input, operationId: "m1", text: "/goal 写一份季度报告，并把 lint 跑通" });
    assert.match(created.text, /目标 t1 已创建/);
    assert.equal(created.draft?.taskId, "t1");
    assert.match(created.draft?.prompt ?? "", /\[host\] 目标 t1 已由人创建/);
    const task = tasks.get("t1")!;
    assert.equal(task.status, "doing");
    assert.equal(task.pursuit?.status, "active");
    assert.equal(task.pursuit?.workId, "work-1");
    assert.equal(task.pursuit?.objective, "写一份季度报告，并把 lint 跑通");
    assert.equal(task.assigneeId, "nova");
    assert.equal(task.requester, "principal-user");

    assert.match(goalCommand(d, { ...input, operationId: "m1", text: "/goal 写一份季度报告，并把 lint 跑通" }).text, /已经创建了目标 t1，不会重复创建/, "a resent message is one goal");
    assert.match(goalCommand(d, { ...input, operationId: "m2", text: "/goal 另一个目标" }).text, /已有目标 t1（active）[\s\S]*\/goal replace/, "one goal per conversation");
    assert.match(goalCommand(d, { ...input, operationId: "", text: "/goal 无标识" }).text, /缺少消息标识/);
    assert.match(goalCommand(d, { ...input, operationId: "m3", text: "/goal" }).text, /目标 t1：active[\s\S]*清单：尚未起草/);

    // The checklist grows through the store; the person confirms a command.
    tasks.setPursuit("t1", pursuit => ({ ...pursuit, checklist: [{ id: "c1", text: "lint passes", check: { kind: "command", command: "npm run lint", expectExit: 0 } }, { id: "c2", text: "report reads well" }] }), "checklist: 2 added", "nova");
    assert.match(goalCommand(d, { ...input, operationId: "m4", text: "/goal confirm 2" }).text, /第 2 条没有命令/);
    assert.match(goalCommand(d, { ...input, operationId: "m5", text: "/goal confirm 1" }).text, /已确认第 1 条的命令：npm run lint/);
    assert.equal(tasks.get("t1")?.pursuit?.checklist[0]?.confirmed, true);
    assert.match(goalCommand(d, { ...input, operationId: "m6", text: "/goal confirm 1" }).text, /已经确认过/);

    assert.match(goalCommand(d, { ...input, operationId: "m7", text: "/goal pause" }).text, /已暂停/);
    assert.equal(tasks.get("t1")?.status, "blocked");
    assert.equal(tasks.get("t1")?.pursuit?.pausedReason, "person");
    assert.match(goalCommand(d, { ...input, operationId: "m8", text: "/goal resume" }).text, /继续推进/);
    assert.equal(tasks.get("t1")?.status, "doing");
    assert.equal(tasks.get("t1")?.pursuit?.pausedReason, undefined);

    const replaced = goalCommand(d, { ...input, operationId: "m9", text: "/goal replace 改写成英文版" });
    assert.match(replaced.text, /目标 t2 已创建/);
    assert.equal(tasks.get("t1")?.pursuit?.status, "cleared");
    assert.equal(tasks.get("t1")?.status, "dropped");
    assert.equal(tasks.pursuitIn("feishu-private")?.id, "t2");
    assert.match(goalCommand(d, { ...input, operationId: "m10", text: "/goal clear" }).text, /目标 t2 已清除/);
    assert.equal(tasks.pursuitIn("feishu-private"), undefined);
    assert.match(goalCommand(d, { ...input, operationId: "m11", text: "/goal" }).text, /当前会话没有目标/);
  } finally { cleanup(); }
});

test("/goal is refused outside a normal private chat, without permission, or while the conversation is busy", () => {
  const { tasks, cleanup } = board();
  try {
    assert.match(goalCommand(deps(tasks), { ...input, privateChat: false, operationId: "m1", text: "/goal x" }).text, /仅支持独立私聊/);
    assert.match(goalCommand(deps(tasks), { ...input, conversation: "main", operationId: "m1", text: "/goal x" }).text, /仅支持独立私聊/);
    assert.match(goalCommand(deps(tasks), { ...input, conversation: "fork/abc", operationId: "m1", text: "/goal x" }).text, /仅支持独立私聊/);
    assert.match(goalCommand(deps(tasks, { mayUse: () => false }), { ...input, operationId: "m1", text: "/goal x" }).text, /没有驱动这个 agent 的权限/);
    assert.match(goalCommand(deps(tasks, { contextMode: () => "clean" }), { ...input, operationId: "m1", text: "/goal x" }).text, /干净上下文，没有工具/);
    assert.match(goalCommand(deps(tasks, { blockers: () => ["仍有执行中的 turn"] }), { ...input, operationId: "m1", text: "/goal x" }).text, /暂未创建目标[\s\S]*仍有执行中的 turn/);
    assert.equal(tasks.list().length, 0, "nothing was created");
    assert.match(goalCommand(deps(tasks), { ...input, operationId: "m1", text: "/goal help" }).text, /用法/);
  } finally { cleanup(); }
});

test("the board moves a pursuit only for the gate or the requester, and a turn ending, the sweep and a close proposal leave it alone", () => {
  const { tasks, cleanup } = board();
  try {
    const task = tasks.create({ title: "quarterly report", requester: "principal-user", assigneeId: "nova", conversation: "feishu-private", pursuit: newPursuit({ objective: "quarterly report", workId: "w" }), now: T0 })!;
    assert.equal(task.status, "doing");

    // Review finding 1: three side doors to done.
    const byAssignee = tasks.update(task.id, { status: "done" }, "nova")!;
    assert.equal(byAssignee.task.status, "doing");
    assert.match(byAssignee.coerced ?? "", /moves only through the goal gate/);
    const byAssigneeReview = tasks.update(task.id, { status: "review" }, "nova")!;
    assert.equal(byAssigneeReview.task.status, "doing");
    const byChannel = tasks.update(task.id, { status: "done" }, "channel")!;
    assert.equal(byChannel.task.status, "doing", "a harness actor is not the gate either");
    assert.equal(tasks.turnFinished(task.id)?.task.status, "doing", "a turn ending says nothing about a goal");
    assert.equal(tasks.update(task.id, { note: "found the numbers in Q2.xlsx" }, "nova")?.task.history.at(-1)?.note, "found the numbers in Q2.xlsx", "notes still land");

    // The sweep and a silent close proposal do not end it.
    const day = 86_400_000;
    assert.deepEqual(tasks.age(new Date(T0.getTime() + 30 * day)), [], "never nudged or archived by the sweep");
    const proposal = tasks.proposeClose(task.id, "nova", "seems done to me", new Date(T0.getTime() + 2 * day));
    assert.ok("task" in proposal);
    assert.deepEqual(tasks.settleCloseProposals(new Date(T0.getTime() + 10 * day)), []);
    assert.equal(tasks.get(task.id)?.status, "doing");
    assert.equal(tasks.get(task.id)?.closeProposal, undefined);

    // The gate moves it to review; the requester's word is done; the requester may also clear it.
    tasks.setPursuit(task.id, pursuit => ({ ...pursuit, status: "complete" }), "verifier passed every item");
    assert.equal(tasks.get(task.id)?.status, "review");
    assert.equal(tasks.get(task.id)?.history.at(-1)?.by, GOAL_GATE_ACTOR);
    assert.equal(tasks.update(task.id, { status: "done" }, "nova")?.task.status, "review", "still not the assignee's word");
    assert.equal(tasks.update(task.id, { status: "done" }, "principal-user")?.task.status, "done");

    const other = tasks.create({ title: "second", requester: "principal-user", assigneeId: "nova", conversation: "feishu-private", pursuit: newPursuit({ objective: "second", workId: "w2" }), now: T0 })!;
    assert.equal(tasks.update(other.id, { status: "dropped" }, "nova")?.task.status, "doing");
    const cleared = tasks.update(other.id, { status: "dropped" }, "principal-user")!;
    assert.equal(cleared.task.status, "dropped");
    assert.equal(cleared.task.pursuit?.status, "cleared");
  } finally { cleanup(); }
});
