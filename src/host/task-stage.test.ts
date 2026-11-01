/** The task stage table (INV-1464): one row per fixture, and every combination of status and world lands on exactly one row. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPerson, STAGE_LABEL, type StageWorld, taskStage, type TaskStage } from "./task-stage.ts";
import { TASK_STATUSES, type Task, type TaskStatus } from "./tasks.ts";

const quiet: StageWorld = { undelivered: false, questionPending: false, active: false };
const fixture = (status: TaskStatus, over: Partial<Task> = {}): Pick<Task, "status" | "history" | "mandate" | "proposedBy"> => ({ status, history: [], ...over });

test("the table, row by row", () => {
  assert.equal(taskStage(fixture("done"), { ...quiet, undelivered: true }), "ended", "ended first: nothing about a closed task needs anyone");
  assert.equal(taskStage(fixture("doing"), { ...quiet, undelivered: true, questionPending: true }), "person/delivery", "undeliverable outranks everything live");
  assert.equal(taskStage(fixture("doing"), { ...quiet, questionPending: true }), "person/answer");
  assert.equal(taskStage(fixture("blocked", { history: [{ at: "t", by: "a1", status: "blocked", note: "which region?", options: ["us", "eu"] }] }), quiet), "person/answer", "a blocker with options is a question");
  assert.equal(taskStage(fixture("doing", { mandate: { by: "p", strength: "explicit", grantedAt: "t", stale: { at: "t", reasons: ["rules-changed"] } } }), quiet), "person/answer", "a stale mandate waits for its person");
  assert.equal(taskStage(fixture("review"), quiet), "person/review");
  assert.equal(taskStage(fixture("blocked", { history: [{ at: "t", by: "a1", status: "blocked", note: "needs the key" }] }), quiet), "person/blocked");
  assert.equal(taskStage(fixture("open"), quiet), "working/queued");
  assert.equal(taskStage(fixture("doing"), { ...quiet, active: true }), "working");
  assert.equal(taskStage(fixture("doing"), quiet), "idle");
  assert.equal(taskStage(fixture("dropped"), quiet), "ended");
  assert.equal(needsPerson("person/answer"), true);
  assert.equal(needsPerson("idle"), false);
});

test("every status × world combination lands on exactly one stage, and every stage has a label", () => {
  const seen = new Set<TaskStage>();
  for (const status of TASK_STATUSES) {
    for (const undelivered of [false, true]) {
      for (const questionPending of [false, true]) {
        for (const active of [false, true]) {
          for (const options of [undefined, ["a", "b"]]) {
            const stage = taskStage(fixture(status, { history: [{ at: "t", by: "x", ...(options !== undefined ? { options, note: "q" } : {}) }] }), { undelivered, questionPending, active });
            assert.ok(stage in STAGE_LABEL, `${status}/${undelivered}/${questionPending}/${active} → ${stage} has no label`);
            seen.add(stage);
          }
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(STAGE_LABEL).sort(), "every row of the table is reachable");
});
