import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type Task } from "./tasks.ts";
import { executionDisagreement, executionOf } from "./work-execution.ts";
import { followRoot } from "./work-root-store.ts";
import type { CurrentWork } from "../agents/work-attention.ts";

const rooted = (status: Task["status"], root: Partial<CurrentWork>, extra: Partial<Task> = {}): Task =>
  ({ id: "t1", title: "t", status, history: [], workRoot: { state: { id: "w1", owner: "a", conversation: "main", generation: 1, epoch: 0, messages: [], peers: [], awaiting: [], status: "running", ...root } as CurrentWork, automatic: true }, ...extra }) as unknown as Task;

test("the three records are read as one execution state, and a contradiction is named (docs/99 §4)", () => {
  assert.equal(executionOf(rooted("doing", { status: "running" })), "running");
  assert.equal(executionOf(rooted("doing", { status: "waiting", wait: "confirmation" })), "waiting");
  assert.equal(executionOf(rooted("open", { status: "waiting", wait: "queue" })), "queued");
  assert.equal(executionOf(rooted("done", { status: "answered" })), "finished");
  // Released is not finished: a paused goal's root was answered, and the goal still waits for its person.
  assert.equal(executionOf(rooted("blocked", { status: "answered" }, { pursuit: { status: "paused" } as Task["pursuit"] })), "waiting");
  assert.equal(executionDisagreement(rooted("open", { status: "running" })), "status open, root running");
  assert.equal(executionDisagreement(rooted("doing", { status: "running" }, { pursuit: { status: "cleared" } as Task["pursuit"] })), "status doing, pursuit cleared, root running");
});

test("a card follows its root: started is not open, stopped is not on the board; what somebody said of it stands", () => {
  const now = new Date("2026-11-12T00:00:00Z");
  const started = followRoot(rooted("open", { status: "running" }), now);
  assert.equal(started.status, "doing");
  assert.deepEqual(started.history.at(-1), { at: now.toISOString(), by: "host", status: "doing", note: "started" });
  const stopped = rooted("doing", { status: "cancelled" });
  stopped.workRoot!.cancellation = { id: "w1" } as never;
  assert.equal(followRoot(stopped, now).status, "dropped");
  for (const said of ["blocked", "review", "done"] as const) {
    const task = rooted(said, { status: "running" });
    assert.equal(followRoot(task, now), task, said);
  }
  const queued = rooted("open", { status: "waiting", wait: "queue" });
  assert.equal(followRoot(queued, now), queued, "behind another request, it has not started");
  const goal = rooted("doing", { status: "cancelled" }, { pursuit: { status: "active" } as Task["pursuit"] });
  assert.equal(followRoot(goal, now), goal, "a goal's card follows its pursuit");
});

test("a person's request is on the board as started once its turn begins, for every reader of the status", () => {
  const home = mkdtempSync(join(tmpdir(), "work-execution-"));
  try {
    const tasks = new TaskStore(join(home, "tasks.jsonl"));
    const task = tasks.create({ title: "Summarise the report", requester: "web:chris", assigneeId: "a", conversation: "main", origin: { kind: "user" } })!;
    const state = { id: "w1", owner: "a", conversation: "main", generation: 1, epoch: 0, messages: ["m1"], peers: [], awaiting: [], status: "running", taskId: task.id } as unknown as CurrentWork;
    tasks.workRoots.save([state], []);
    assert.equal(tasks.get(task.id)!.status, "doing");
    assert.equal(new TaskStore(join(home, "tasks.jsonl")).get(task.id)!.status, "doing", "and it is what a restart reads");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
