/** The side door's contract (INV-1358): terminal states from the board, ignored fields, the key a call carries. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOutcome, idempotencyKeyOf, ignoredFields, outcomeOf, SIDE_DOOR_CAPABILITIES } from "./mcp-contract.ts";

const task = (status: string, notes: string[] = []) => ({ status, history: notes.map(note => ({ at: "t", by: "a", note })) }) as never;

test("the board's six statuses read as the contract's five states, with the turn's own stop as incomplete and its reason", () => {
  assert.deepEqual(outcomeOf(task("open")), { status: "in_progress" });
  assert.deepEqual(outcomeOf(task("doing")), { status: "in_progress" });
  assert.deepEqual(outcomeOf(task("done")), { status: "completed" });
  assert.deepEqual(outcomeOf(task("blocked")), { status: "failed", reason: "blocked" });
  assert.deepEqual(outcomeOf(task("dropped")), { status: "cancelled", reason: "dropped" });
  assert.deepEqual(outcomeOf(task("review", ["turn ended; not closed because it has acceptance criteria"])), { status: "incomplete", reason: "held_for_review" });
  assert.deepEqual(outcomeOf(task("review", ["something", "incomplete (turn_budget): 60 model calls, handed back"])), { status: "incomplete", reason: "turn_budget" });
  assert.deepEqual(outcomeOf(task("review", ["incomplete (rounds): Stopping: the last 4 rounds…"])), { status: "incomplete", reason: "rounds" });
  assert.equal(describeOutcome({ status: "incomplete", reason: "turn_budget" }), "status: incomplete (turn_budget)");
  assert.equal(describeOutcome({ status: "completed" }), "status: completed");
});

test("fields the schema does not name are listed, sorted; the idempotency key is not one of them", () => {
  const schema = { type: "object", properties: { brief: { type: "string" }, agent: { type: "string" } } };
  assert.deepEqual(ignoredFields({ brief: "x", zeta: 1, alpha: 2, idempotency_key: "k" }, schema), ["alpha", "zeta"]);
  assert.deepEqual(ignoredFields({ brief: "x" }, schema), []);
  assert.deepEqual(ignoredFields({ anything: 1 }, { type: "object" }), ["anything"]);
});

test("the key comes from the header first, then _meta, then the arguments; every capability is stated, several as false", () => {
  assert.equal(idempotencyKeyOf({ "idempotency-key": "h-1" }, { _meta: { idempotencyKey: "m-1" }, arguments: { idempotency_key: "a-1" } }), "h-1");
  assert.equal(idempotencyKeyOf({}, { _meta: { idempotencyKey: "m-1" }, arguments: { idempotency_key: "a-1" } }), "m-1");
  assert.equal(idempotencyKeyOf({}, { arguments: { idempotency_key: "a-1" } }), "a-1");
  assert.equal(idempotencyKeyOf({}, undefined), undefined);
  const values = Object.values(SIDE_DOOR_CAPABILITIES);
  assert.ok(values.includes(false) && values.includes(true), "false capabilities are reported, not omitted");
  assert.equal(SIDE_DOOR_CAPABILITIES.cancel, false);
});
