/** task_status as data (INV-1506): the record beside the unchanged text, for a plain task, a goal, and the list. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { newPursuit } from "../host/goal-mode.ts";
import { TaskStore } from "../host/tasks.ts";
import { describeTask } from "../host/tasks.ts";
import { describeOutcome, outcomeOf, SIDE_DOOR_CAPABILITIES } from "./mcp-contract.ts";
import { RECORD_EXPERIMENTS, RECORD_HISTORY, taskRecord } from "./mcp-record.ts";
import { mcpServerTools } from "./mcp-tools.ts";

const names: Record<string, string> = { a1: "Ada" };
const nameOf = (id: string) => names[id] ?? id;

function door(board: TaskStore, stageWorld?: Parameters<typeof mcpServerTools>[0]["stageWorld"]) {
  const registry = { tryGet: (id: string) => (names[id] !== undefined ? { profile: { name: names[id] } } : undefined) };
  const tools = mcpServerTools({
    registry: registry as never,
    orchestrator: { tasks: board } as never,
    principals: { resolve: (id: string) => ({ name: id }) },
    workDir: "/work",
    log: () => {},
    listen: () => () => {},
    ...(stageWorld !== undefined ? { stageWorld } : {}),
  });
  return tools.find(tool => tool.name === "task_status")!;
}

test("a plain task: outcome, stage, mandate, history as data; the text is what it always was", async () => {
  const board = new TaskStore(null);
  const task = board.create({ title: "Count the October sales", requester: "p1", assigneeId: "a1" })!;
  board.update(task.id, { status: "doing", note: "started" }, "a1");
  for (let i = 0; i < 14; i++) board.update(task.id, { note: `step ${i}` }, "a1");
  board.deliveryCommand(task.id, "submit", "a1", { note: "incomplete (turn_budget): 60 model calls, handed back" });
  const status = door(board, () => ({ undelivered: false, questionPending: false, active: false }));
  const now = board.get(task.id)!;
  const expectedText = `${describeOutcome(outcomeOf(now))}\n${describeTask(now, nameOf)}\n${now.history.map(change => `  ${change.at} ${nameOf(change.by)} ${change.status ?? ""} ${change.note ?? ""}`.trimEnd()).join("\n")}`;
  assert.equal(await status.run({ task_id: task.id }, "p1"), expectedText, "the text is byte-identical");
  const both = await status.runWithRecord!({ task_id: task.id }, "p1");
  assert.equal(both.text, expectedText);
  const [record] = both.structured.tasks as ReturnType<typeof taskRecord>[];
  assert.equal(record!.id, task.id);
  assert.deepEqual(record!.outcome, { status: "incomplete", reason: "turn_budget" });
  assert.equal(record!.stage, "person/review");
  assert.equal(record!.assignee, "Ada");
  assert.deepEqual(record!.mandate, { by: "p1", strength: "explicit", state: "valid" });
  assert.equal(record!.history.length, RECORD_HISTORY, "the last moves, not all of them");
  assert.equal(record!.history.at(-1)!.by, "Ada");
  assert.equal(record!.pursuit, undefined);
});

test("a goal: the gate's own numbers — checklist verdicts, spend against limits, the ledger's tail, the last verdict", () => {
  const board = new TaskStore(null);
  const pursuit = newPursuit({ objective: "Ship the weekly digest", workId: "w1", budget: 5000 });
  const task = board.create({ title: "Ship the weekly digest", requester: "p1", assigneeId: "a1", conversation: "c1", pursuit })!;
  board.setPursuit(task.id, current => ({
    ...current,
    status: "paused",
    pausedReason: "repeating",
    checklist: [{ id: "i1", text: "digest sent", verdict: "proven" }, { id: "i2", text: "links work" }],
    spent: { ...current.spent, continuations: 7, cost: 4321.6 },
    experiments: Array.from({ length: 8 }, (_, n) => ({ n, kind: "new" as const, hypothesis: `h${n}`, action: `a${n}`, outcome: `o${n}`, at: "2026-11-02T00:00:00.000Z" })),
    lastVerdict: { at: "2026-11-02T00:00:00.000Z", passed: false, items: [], nextAction: "fix the links" },
  }), "test");
  const record = taskRecord(board.get(task.id)!, { nameOf });
  assert.equal(record.pursuit?.status, "paused");
  assert.equal(record.pursuit?.pausedReason, "repeating");
  assert.deepEqual(record.pursuit?.checklist, [{ id: "i1", text: "digest sent", verdict: "proven" }, { id: "i2", text: "links work" }]);
  assert.deepEqual([record.pursuit?.spent.continuations, record.pursuit?.spent.cost, record.pursuit?.limits.budget], [7, 4322, 5000]);
  assert.equal(record.pursuit?.experiments.length, RECORD_EXPERIMENTS);
  assert.equal(record.pursuit?.experiments.at(-1)?.hypothesis, "h7", "newest last");
  assert.deepEqual(record.pursuit?.lastVerdict, { at: "2026-11-02T00:00:00.000Z", passed: false, nextAction: "fix the links" });
  assert.equal(record.stage, undefined, "no world to read the stage against: no stage rather than a guess");
});

test("the list: my open tasks as an array; a stale or withdrawn mandate says so; ended tasks read ended without a world", async () => {
  const board = new TaskStore(null);
  const open = board.create({ title: "mine, open", requester: "p1" })!;
  board.create({ title: "someone else's", requester: "p2" });
  const closed = board.create({ title: "mine, done", requester: "p1" })!;
  board.update(closed.id, { status: "done", note: "ok" }, "p1");
  const status = door(board);
  const both = await status.runWithRecord!({}, "p1");
  assert.deepEqual((both.structured.tasks as { id: string }[]).map(task => task.id), [open.id], "only my live tasks, like the text");
  assert.equal(both.text, await status.run({}, "p1"));
  assert.equal(taskRecord(board.get(closed.id)!, { nameOf }).stage, "ended");
  const stale = { ...board.get(open.id)!, mandate: { ...board.get(open.id)!.mandate!, stale: { at: "t", reasons: ["rules-changed" as const] } } };
  assert.deepEqual(taskRecord(stale, { nameOf }).mandate, { by: "p1", strength: "explicit", state: "stale", staleReasons: ["rules-changed"] });
  const withdrawn = { ...stale, mandate: { ...stale.mandate, withdrawn: { at: "t", by: "p1", reason: "stop" } } };
  assert.equal(taskRecord(withdrawn, { nameOf }).mandate?.state, "withdrawn");
  assert.deepEqual((await status.runWithRecord!({ task_id: "t999" }, "p1")).structured, { tasks: [] });
  assert.equal(SIDE_DOOR_CAPABILITIES.structured, true);
});
