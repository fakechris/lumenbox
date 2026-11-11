/**
 * Dependencies between tasks (INV-1740): blockedBy set and cleared, unknown ids, the task itself and
 * cycles refused, "ready" computed from the board, and release — the waiting task's assignee woken
 * once, when the last open blocker closes or a person takes it off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrations, parsePlan } from "./orchestrate.ts";
import { PendingWork } from "./pending-work.ts";
import { planCards } from "./plan-cards.ts";
import { BlockerError, blockerProblem, dependencyLine, dependencyView, openBlockers, parseBlockers, watchDependencies } from "./task-deps.ts";
import { describeTask, TaskStore } from "./tasks.ts";
import { readHandoff } from "./tools.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T0 = new Date("2026-11-07T09:00:00Z");

function board() {
  const tasks = new TaskStore(null);
  const woken: { agent: string; task: string; text: string }[] = [];
  watchDependencies(tasks, (task, text) => woken.push({ agent: task.assigneeId!, task: task.id, text }));
  return { tasks, woken };
}

test("blockedBy is set, read and cleared; unknown ids, the task itself and a cycle are refused", () => {
  const { tasks } = board();
  const a = tasks.create({ title: "Draft", requester: "p" })!;
  const b = tasks.create({ title: "Review", requester: "p", blockedBy: [a.id] })!;
  const c = tasks.create({ title: "Publish", requester: "p" })!;
  assert.deepEqual(b.blockedBy, ["t1"]);
  assert.deepEqual(tasks.update(c.id, { blockedBy: ["t2"] }, "p")!.task.blockedBy, ["t2"]);
  assert.equal(tasks.get(c.id)!.history.at(-1)!.note, "waits on t2", "the edit is on the record");

  assert.throws(() => tasks.update(c.id, { blockedBy: ["t9"] }, "p"), (error: unknown) => error instanceof BlockerError && /No task t9/.test(error.message));
  assert.throws(() => tasks.update(c.id, { blockedBy: ["t3"] }, "p"), /cannot wait on itself/);
  // t1 ← t2 ← t3: making t1 wait on t3 closes the loop.
  assert.throws(() => tasks.update(a.id, { blockedBy: ["t3"] }, "p"), /cycle \(t1 → t3 → t2 → t1\)/);
  assert.deepEqual(blockerProblem(tasks, a.id, ["t3"]), { code: "task-blocker-cycle", vars: { task: "t3", path: "t1 → t3 → t2 → t1" } });
  assert.equal(tasks.get(a.id)!.blockedBy, undefined, "a refused edit changed nothing");

  assert.equal(tasks.update(c.id, { blockedBy: [] }, "p")!.task.blockedBy, undefined, "empty clears it");
  assert.deepEqual(parseBlockers("t2, T3，t2"), ["t2", "t3"]);
  assert.equal(parseBlockers(undefined), undefined);
});

test("ready: an open blocker keeps a task from starting, from closing with its turn and from being nudged", () => {
  const { tasks } = board();
  const a = tasks.create({ title: "Draft", requester: "p", assigneeId: "ada", now: T0 })!;
  const b = tasks.create({ title: "Review", requester: "p", assigneeId: "bob", blockedBy: [a.id], now: T0 })!;
  assert.deepEqual(openBlockers(tasks.get(b.id), tasks), ["t1"]);
  assert.match(describeTask(tasks.get(b.id)!, id => id, tasks), /blocked by t1 \(waiting on 1 of 1\)$/);

  const started = tasks.update(b.id, { status: "doing" }, "bob")!;
  assert.equal(started.task.status, "open", "not started");
  assert.match(started.coerced!, /blocked by t1/);
  assert.equal(tasks.turnFinished(b.id)!.task.status, "open", "a turn ending does not close what still waits");

  const weekLater = new Date(T0.getTime() + 9 * 86_400_000);
  const nudged = tasks.age(weekLater).map(event => event.task.id);
  assert.ok(nudged.includes("t1") && !nudged.includes("t2"), "idle a week: the blocker is asked about, the one waiting on it is not");

  tasks.update(a.id, { status: "done" }, "p");
  assert.equal(tasks.update(b.id, { status: "doing" }, "bob")!.task.status, "doing", "ready once the blocker is done");
  assert.match(describeTask(tasks.get(b.id)!, id => id, tasks), /after t1$/);
});

test("release: the last open blocker closing wakes the assignee once, with the reason on the record", () => {
  const { tasks, woken } = board();
  tasks.create({ title: "Copy", requester: "p" });
  tasks.create({ title: "Images", requester: "p" });
  const page = tasks.create({ title: "Page", requester: "p", assigneeId: "ada", conversation: "launch", blockedBy: ["t1", "t2"] })!;
  tasks.update("t1", { status: "done" }, "p");
  assert.equal(woken.length, 0, "one of two finished: still waiting");
  tasks.update("t2", { status: "dropped" }, "p");
  assert.deepEqual(woken.map(w => [w.agent, w.task]), [["ada", page.id]]);
  assert.match(woken[0]!.text, /t3 "Page" is ready: t1, t2 are finished/);
  assert.match(tasks.get(page.id)!.history.at(-1)!.note!, /is ready/);
  tasks.update("t2", { note: "a late remark" }, "p");
  tasks.update(page.id, { note: "noted" }, "ada");
  assert.equal(woken.length, 1, "released once, not on every later change");
});

test("release: a person taking the last blocker off wakes the assignee at once; a proposal and an unassigned task are not woken", () => {
  const { tasks, woken } = board();
  tasks.create({ title: "Legal sign-off", requester: "p" });
  tasks.create({ title: "Announce", requester: "p", assigneeId: "bob", blockedBy: ["t1"] });
  tasks.create({ title: "Follow-up idea", requester: "ada", proposedBy: "ada", assigneeId: "ada", blockedBy: ["t1"] });
  tasks.create({ title: "Nobody's", requester: "p", blockedBy: ["t1"] });
  tasks.update("t2", { blockedBy: [] }, "p-chris");
  assert.deepEqual(woken.map(w => w.task), ["t2"], "the person's edit took effect immediately");
  assert.equal(tasks.update("t2", { status: "doing" }, "bob")!.task.status, "doing");
  tasks.update("t1", { status: "done" }, "p");
  assert.deepEqual(woken.map(w => w.task), ["t2"], "the proposal and the unassigned task are released on the record only");
  assert.match(tasks.get("t3")!.history.at(-1)!.note!, /is ready/);
});

test("the card's view: each blocker with its status, and the live tasks waiting on this one", () => {
  const { tasks } = board();
  tasks.create({ title: "A", requester: "p" });
  tasks.create({ title: "B", requester: "p", blockedBy: ["t1"] });
  tasks.create({ title: "C", requester: "p", blockedBy: ["t1", "t2"] });
  tasks.update("t2", { status: "done" }, "p");
  assert.deepEqual(dependencyView(tasks.get("t3")!, tasks), { blockers: [{ id: "t1", status: "open" }, { id: "t2", status: "done" }] });
  assert.deepEqual(dependencyView(tasks.get("t1")!, tasks), { blocks: ["t3"] }, "t2 is closed, so only t3 still waits on t1");
  assert.equal(dependencyLine(tasks.get("t3")!, tasks), " · blocked by t1 (waiting on 1 of 2)");
});

test("an Orchestrate plan from a turn working a task: one card per item, the task waits on them, the plan's result is the wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-plan-cards-"));
  try {
    const { tasks, woken } = board();
    tasks.create({ title: "Survey the vendors", requester: "p", assigneeId: "ada", conversation: "main" });
    tasks.update("t1", { status: "doing" }, "ada");
    const delivered: string[] = [];
    const orchestrations = new Orchestrations({
      pendingWork: new PendingWork(join(dir, "pending-work.jsonl")),
      policy: { requestConfirmation: () => { throw new Error("not asked"); }, pending: () => [] },
      runChild: async (_agent, _conversation, brief) => (/Item 2 of/.test(brief) ? 'no page\nHANDOFF: {"status":"blocked","reason":"404"}' : 'a price\nHANDOFF: {"status":"done","reason":"ok"}'),
      readHandoff,
      deliver: (_agent, text) => { delivered.push(text); assert.equal(tasks.get("t1")!.blockedBy?.length, 3); return true; },
      resultsDir: join(dir, "orchestrations"),
      board: planCards(tasks),
    });
    const parsed = parsePlan({ brief: "Vendors", items: ["acme", "globex", "initech"], prompt: "Price of {{item}}" });
    assert.ok("plan" in parsed);
    orchestrations.submit({ taskId:"t1", agentId: "ada", agentName: "Ada", parent: "main", plan: parsed.plan });
    assert.deepEqual(tasks.get("t1")!.blockedBy, ["t2", "t3", "t4"]);
    assert.match(describeTask(tasks.get("t1")!, id => id, tasks), /waiting on 3 of 3/);
    assert.equal(tasks.get("t2")!.status, "doing");
    assert.equal(tasks.turnFinished("t1")!.task.status, "doing", "the parent's turn ending does not close it");
    await orchestrations.idle();
    assert.equal(delivered.length, 1);
    assert.deepEqual(["t2", "t3", "t4"].map(id => tasks.get(id)!.status), ["done", "dropped", "done"], "each card closed with its item");
    assert.match(tasks.get("t3")!.history.at(-1)!.note!, /plan item blocked: no page/);
    assert.equal(openBlockers(tasks.get("t1"), tasks).length, 0);
    assert.equal(woken.length, 0, "the plan's result already woke the parent; no second wake");
    assert.match(tasks.get("t1")!.history.at(-1)!.note!, /is ready/);

    // With no task in hand, a plan leaves no cards.
    orchestrations.submit({ agentId: "bob", agentName: "Bob", parent: "main", plan: parsed.plan });
    await orchestrations.idle();
    assert.equal(tasks.list().length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
