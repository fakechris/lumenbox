import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRunResult, planResult, routineResult } from "./run-result.ts";

test("a plan is done, partial or failed by its items, with the counts (INV-1404)", () => {
  const items = (statuses: string[]) => statuses.map(status => ({ status }));
  assert.deepEqual(planResult(items(["done", "done", "done"])), { result: "done", doneCount: 3, notDoneCount: 0 });
  assert.deepEqual(planResult(items(["done", "failed", "done", "unknown", "done"])), { result: "partial", doneCount: 3, notDoneCount: 2 }, "3 of 5 is partial, not done");
  assert.deepEqual(planResult(items(["failed", "aborted"])), { result: "failed", doneCount: 0, notDoneCount: 2 });
  assert.deepEqual(planResult([]), { result: "done", doneCount: 0, notDoneCount: 0 }, "nothing to do is done");
  assert.equal(describeRunResult(planResult(items(["done", "failed", "done", "unknown", "done"]))), "partial (3 done, 2 not done)");
  assert.equal(describeRunResult(planResult(items(["done"]))), "done (1 of 1)");
  assert.equal(describeRunResult(planResult(items(["failed"]))), "failed (none of 1 done)");
});

test("a routine's result is read off how its turns ended: a stop of its own is partial, a failure fails, nothing to say is done", () => {
  assert.equal(routineResult([{ how: "done" }]), "done");
  assert.equal(routineResult([{ how: "silent" }]), "done", "a run with nothing to say ran");
  assert.equal(routineResult([{ how: "incomplete", category: "turn_budget" }]), "partial", "the call budget stopped it");
  assert.equal(routineResult([{ how: "done" }, { how: "incomplete", category: "rounds" }]), "partial", "a continuation the loop detector stopped");
  assert.equal(routineResult([{ how: "incomplete" }, { how: "failed", category: "provider" }]), "failed", "a failure outranks a partial");
  assert.equal(routineResult([{ how: "aborted" }]), "failed");
  assert.equal(routineResult([]), "done", "no turn recorded: nothing is known to have gone wrong");
});
