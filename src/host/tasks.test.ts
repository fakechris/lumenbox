/**
 * Tests for the task board.
 *
 * The claims that matter: the review gate holds against self-acceptance (the one
 * enforced rule), the board survives a restart, ids are never reused after
 * compaction lets a task go, and history records who moved what in which run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, describeTask } from "./tasks.ts";

function tempStore(): { path: string; store: TaskStore; reopen: () => TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-"));
  const path = join(dir, "tasks.jsonl");
  return {
    path,
    store: new TaskStore(path),
    reopen: () => new TaskStore(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a task moves through its life, and every move is on the record", () => {
  const { store, cleanup } = tempStore();
  try {
    const task = store.create({ title: "  Fix   the flaky test  ", requester: "web" })!;
    assert.equal(task.id, "t1");
    assert.equal(task.title, "Fix the flaky test", "whitespace collapsed");
    assert.equal(task.status, "open");

    store.update("t1", { assigneeId: "ada", status: "doing", note: "on it" }, "ada", "turn-9");
    store.update("t1", { status: "done" }, "ada", "turn-9");
    const done = store.get("t1")!;
    assert.equal(done.status, "done", "no reviewer, so the assignee may finish it");
    const moves = done.history.map(h => `${h.by}:${h.status ?? "-"}`);
    assert.deepEqual(moves, ["web:open", "ada:doing", "ada:done"]);
    assert.equal(done.history[1]!.run, "turn-9", "the run is on the change");
  } finally {
    cleanup();
  }
});

test("the review gate: a named reviewer means the assignee cannot self-accept", () => {
  const { store, cleanup } = tempStore();
  try {
    store.create({ title: "Ship the release", requester: "web", assigneeId: "ada", reviewerId: "bob" });
    const attempt = store.update("t1", { status: "done" }, "ada")!;
    assert.equal(attempt.task.status, "review", "coerced, not obeyed");
    assert.match(attempt.coerced ?? "", /cannot mark it done/);

    // The reviewer accepting is what done means.
    const accepted = store.update("t1", { status: "done" }, "bob")!;
    assert.equal(accepted.task.status, "done");
    assert.equal(accepted.coerced, undefined);

    // And a reviewer sending it back works like anything else.
    store.create({ title: "Another", requester: "web", assigneeId: "ada", reviewerId: "bob" });
    store.update("t2", { status: "review" }, "ada");
    const back = store.update("t2", { status: "doing", note: "the header is wrong" }, "bob")!;
    assert.equal(back.task.status, "doing");
  } finally {
    cleanup();
  }
});

test("the board survives a restart; a torn last line costs one snapshot, not the board", () => {
  const { path, store, reopen, cleanup } = tempStore();
  try {
    store.create({ title: "First", requester: "web" });
    store.create({ title: "Second", requester: "web", assigneeId: "ada" });
    store.update("t2", { status: "doing" }, "ada");

    appendFileSync(path, '{"kind":"task","task":{"id":"t3"');

    const later = reopen();
    assert.equal(later.list().length, 2);
    assert.equal(later.get("t2")!.status, "doing");
    assert.deepEqual(later.forAgent("ada").map(t => t.id), ["t2"]);
  } finally {
    cleanup();
  }
});

test("ids are never reused: the counter marker outlives the tasks it counted", () => {
  const { store, reopen, cleanup } = tempStore();
  try {
    // Old, closed work far past retention…
    store.create({ title: "Ancient", requester: "web", now: new Date("2020-01-01T00:00:00Z") });
    store.update("t1", { status: "done" }, "web", undefined, new Date("2020-01-02T00:00:00Z"));
    // …then enough churn to trip the (module-constant) compaction threshold.
    for (let i = 0; i < 6000; i++) store.update("t1", { note: `n${i}` }, "web");
    // Compaction ran inside update; the ancient task may be gone. A new task must not be t1.
    const fresh = reopen();
    const created = fresh.create({ title: "New work", requester: "web" })!;
    assert.notEqual(created.id, "t1", "an id from a dropped task is never reused");
  } finally {
    cleanup();
  }
});

test("describeTask reads like a board row", () => {
  const { store, cleanup } = tempStore();
  try {
    store.create({ title: "Write the brief", requester: "web", assigneeId: "a1", reviewerId: "b2" });
    const line = describeTask(store.get("t1")!, id => (id === "a1" ? "Ada" : "Bob"));
    assert.equal(line, "t1 [open] @Ada Write the brief · review by Bob");
  } finally {
    cleanup();
  }
});
