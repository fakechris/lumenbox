/** The speaking right of a host-initiated message (INV-1459): each purpose allowed only when its claim holds. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describePurpose, outboundVerdict, type OutboundWorld } from "./outbound.ts";

const world: OutboundWorld = {
  taskStatus: id => ({ t1: "doing", t2: "review", t3: "done", t4: "dropped" })[id],
  pendingQuestion: ref => ({ q1: "Which account?", t9: "Deploy now or wait?" })[ref],
  answerOwed: id => id === "d1",
};

test("a result goes out only for finished work", () => {
  assert.deepEqual(outboundVerdict({ kind: "result", taskId: "t2" }, world, new Set()), { allow: true });
  assert.deepEqual(outboundVerdict({ kind: "result", taskId: "t3" }, world, new Set()), { allow: true });
  assert.deepEqual(outboundVerdict({ kind: "result", taskId: "t4" }, world, new Set()), { allow: true });
  const doing = outboundVerdict({ kind: "result", taskId: "t1" }, world, new Set());
  assert.equal(doing.allow, false);
  assert.match(!doing.allow ? doing.reason : "", /t1 is doing, not finished/);
  assert.match((outboundVerdict({ kind: "result", taskId: "nope" }, world, new Set()) as { reason: string }).reason, /does not exist/);
});

test("attention carries the pending question word for word, from a watched question or a blocked task", () => {
  assert.deepEqual(outboundVerdict({ kind: "attention", ref: "q1", question: "Which account?" }, world, new Set()), { allow: true });
  assert.deepEqual(outboundVerdict({ kind: "attention", ref: "t9", question: " Deploy now or wait? " }, world, new Set()), { allow: true });
  assert.match((outboundVerdict({ kind: "attention", ref: "q1", question: "Which region?" }, world, new Set()) as { reason: string }).reason, /not this one/);
  assert.match((outboundVerdict({ kind: "attention", ref: "q7", question: "x" }, world, new Set()) as { reason: string }).reason, /no question is pending/);
});

test("an answer needs a reply still owed; an ack happens once per message; a notice always passes", () => {
  assert.deepEqual(outboundVerdict({ kind: "answer", deliveryId: "d1" }, world, new Set()), { allow: true });
  assert.match((outboundVerdict({ kind: "answer", deliveryId: "d2" }, world, new Set()) as { reason: string }).reason, /nothing is owed/);
  const acked = new Set<string>();
  assert.deepEqual(outboundVerdict({ kind: "ack", messageId: "m1" }, world, acked), { allow: true });
  assert.match((outboundVerdict({ kind: "ack", messageId: "m1" }, world, acked) as { reason: string }).reason, /already acknowledged/);
  assert.deepEqual(outboundVerdict({ kind: "notice", about: "digest" }, world, new Set()), { allow: true });
  assert.equal(describePurpose({ kind: "notice", about: "digest" }), "notice: digest");
  assert.equal(describePurpose({ kind: "result", taskId: "t2" }), "result for t2");
});
