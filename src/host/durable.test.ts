/**
 * Tests for the plan and todo list.
 *
 * The claim being tested is the one that matters for a long task: this state cannot be lost by
 * compaction. That is verified in turn.test.ts, where a summarised history still carries the plan.
 * Here: that absent renders as nothing rather than as an empty container, that refusals say what
 * would be accepted, and that the survival property comes from placement rather than from a
 * mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeTodos,
  isTodoStatus,
  MAX_PLAN_CHARS,
  MAX_TODOS,
  MAX_TODO_CHARS,
  renderDurableBlocks,
  validatePlan,
  validateTodos,
  type TodoItem,
} from "./durable.ts";

test("nothing renders as nothing, not as an empty plan", () => {
  // A heading with nothing under it tells the model a plan exists and is empty, which reads as
  // "there is no work to do" — worse than silence.
  assert.equal(renderDurableBlocks({}), "");
  assert.equal(renderDurableBlocks({ plan: "" }), "");
  assert.equal(renderDurableBlocks({ plan: "   \n  " }), "");
  assert.equal(renderDurableBlocks({ todos: [] }), "");
  assert.equal(renderDurableBlocks({ plan: "", todos: [] }), "");
});

test("a plan renders with the instruction that makes it useful after a summary", () => {
  const rendered = renderDurableBlocks({ plan: "Ship the parser.\n\n- read the spec" });
  assert.match(rendered, /## Your current plan/);
  assert.match(rendered, /Ship the parser/);
  // The cue that turns a stored plan into a resumable one: it says what this text is and what to do
  // when it no longer matches.
  assert.match(rendered, /survives summarisation/);
  assert.match(rendered, /update it with SetPlan/);
});

test("a todo list shows progress and how to read the markers", () => {
  const todos: TodoItem[] = [
    { text: "read the spec", status: "done" },
    { text: "write the parser", status: "doing" },
    { text: "handle escapes", status: "pending" },
    { text: "get the API key", status: "blocked" },
  ];
  const rendered = renderDurableBlocks({ todos });
  assert.match(rendered, /1\/4 done/, "progress is counted so a long task has a sense of movement");
  assert.match(rendered, /- \[x\] read the spec/);
  assert.match(rendered, /- \[>\] write the parser/);
  assert.match(rendered, /- \[ \] handle escapes/);
  assert.match(rendered, /- \[!\] get the API key/);
  // The instruction is about accuracy in *both* directions, which is the failure mode of a todo
  // list an agent keeps: stale items cause redone or skipped work.
  assert.match(rendered, /make you redo the work/);
  assert.match(rendered, /make you skip it/);
});

test("plan comes before todos, because the why precedes the what", () => {
  const rendered = renderDurableBlocks({
    plan: "PLAN TEXT",
    todos: [{ text: "TODO TEXT", status: "pending" }],
  });
  assert.ok(rendered.indexOf("PLAN TEXT") < rendered.indexOf("TODO TEXT"));
});

test("a refusal says what would be accepted", () => {
  // "Too long" teaches nothing; naming the alternative is what stops the model retrying the same
  // thing.
  const long = validatePlan("x".repeat(MAX_PLAN_CHARS + 1));
  assert.ok(long);
  assert.match(long.reason, /put detail in a file under \/home\/box\/work/);
  assert.match(long.reason, /paid for repeatedly/, "it says why the limit exists");

  const empty = validatePlan("  ");
  assert.ok(empty);
  assert.match(empty.reason, /reads as 'there is nothing to do'/);

  assert.equal(validatePlan("a real plan"), undefined);
});

test("a todo list is refused when it has become a plan", () => {
  const tooMany = validateTodos(
    Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      text: `item ${index}`,
      status: "pending" as const,
    }))
  );
  assert.ok(tooMany);
  assert.match(tooMany.reason, /is a plan; write it with SetPlan/);

  const tooLong = validateTodos([{ text: "y".repeat(MAX_TODO_CHARS + 1), status: "pending" }]);
  assert.ok(tooLong);
  assert.match(tooLong.reason, /really several items/);

  const blank = validateTodos([{ text: "  ", status: "pending" }]);
  assert.ok(blank);
  assert.match(blank.reason, /cannot be worked on or ticked off/);

  const badStatus = validateTodos([{ text: "x", status: "later" as unknown as "pending" }]);
  assert.ok(badStatus);
  assert.match(badStatus.reason, /pending, doing, done, blocked/);

  assert.equal(validateTodos([{ text: "fine", status: "doing" }]), undefined);
  assert.equal(validateTodos([]), undefined, "an empty list is allowed: it means finished");
});

test("the tool result echoes the whole list, which is what covers a mid-turn change", () => {
  // The system prompt is built once per turn, so an update at round 5 is not in the prompt at round
  // 300. The echo is in the message array, where in-turn pruning does not reach.
  const described = describeTodos([
    { text: "one", status: "done" },
    { text: "two", status: "pending" },
  ]);
  assert.match(described, /1\/2 done/);
  assert.match(described, /- \[x\] one/);
  assert.match(described, /- \[ \] two/);
  assert.equal(describeTodos([]), "The todo list is now empty.");
});

test("statuses are checked, not trusted", () => {
  for (const status of ["pending", "doing", "done", "blocked"]) {
    assert.equal(isTodoStatus(status), true);
  }
  assert.equal(isTodoStatus("later"), false);
  assert.equal(isTodoStatus(""), false);
  assert.equal(isTodoStatus("DONE"), false, "case matters: a near miss is a miss");
});
