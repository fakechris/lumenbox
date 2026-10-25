/** The turn's own budget (INV-1354): counted calls, one warning, replayed repeats, and the report. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetReport, budgetWarning, replayNote, TurnBudget } from "./turn-budget.ts";

test("calls are counted to the ceiling: ok, one warning at 80%, then hit — and hit does not consume", () => {
  const budget = new TurnBudget({ calls: 10, repeats: 3 });
  const outcomes = Array.from({ length: 12 }, () => budget.call());
  assert.deepEqual(outcomes.slice(0, 7), ["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.equal(outcomes[7], "warn", "the eighth call of ten is 80%");
  assert.deepEqual(outcomes.slice(8, 10), ["ok", "ok"]);
  assert.deepEqual(outcomes.slice(10), ["hit", "hit"]);
  assert.equal(budget.callsUsed, 10, "a refused call is not counted");
  assert.match(budgetWarning(budget, false), /10 of 10 model calls used, 0 left/);
  assert.match(budgetWarning(budget, true), /已用 10\/10/);
});

test("the identical call is run `repeats` times and replayed after; a different argument is a different call", () => {
  const budget = new TurnBudget({ calls: 60, repeats: 2 });
  const result = [{ type: "text" as const, text: "contents of a.txt" }];
  assert.equal(budget.replayFor("read_file", { path: "a.txt" }), undefined);
  budget.ran("read_file", { path: "a.txt" }, result);
  assert.equal(budget.replayFor("read_file", { path: "a.txt" }), undefined, "one run is not a repeat");
  budget.ran("read_file", { path: "a.txt" }, result);
  assert.deepEqual(budget.replayFor("read_file", { path: "a.txt" }), result, "the third identical call is answered from the second");
  assert.equal(budget.replayFor("read_file", { path: "b.txt" }), undefined);
  assert.equal(budget.replayFor("read_file", { path: "a.txt", extra: 1 }), undefined);
  assert.equal(budget.repeatsOf("read_file", { path: "a.txt" }), 2);
  assert.match(replayNote("read_file", 3, false), /made 3 times; it was not run again/);
});

test("the report says what ran and hands the rest back, in the person's language", () => {
  const budget = new TurnBudget({ calls: 5, repeats: 3 });
  for (let i = 0; i < 5; i += 1) budget.call();
  const calls = ["read_file a", "read_file b", "bash ls", "read_file c", "WebFetch x"];
  assert.match(budgetReport(budget, calls, false), /budget of 5 model calls.*5 tool calls, mostly read_file ×3, bash ×1, WebFetch ×1/);
  assert.match(budgetReport(budget, calls, true), /用完了 5 次模型调用的预算.*read_file ×3/);
});
