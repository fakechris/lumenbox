/** The agent's case travels beside a decision, labelled as its claim and outside the fingerprint (INV-1651). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCaseText, questionLeanText, splitWhy, WHY_FIELD } from "./consent-case.ts";
import { describeRequest, fingerprintOf } from "./policy-describe.ts";

test("why is lifted off the input and bounded; the action text and fingerprint do not change with it", () => {
  const plain = splitWhy({ action: "click", ref: "e4" });
  assert.deepEqual(plain, { input: { action: "click", ref: "e4" } });
  const said = splitWhy({ action: "click", ref: "e4", why: "  the form is complete and this submits it  " });
  assert.deepEqual(said.input, { action: "click", ref: "e4" });
  assert.equal(said.why, "the form is complete and this submits it");
  assert.equal(splitWhy({ command: "ls", why: "" }).why, undefined);
  assert.equal(splitWhy({ command: "ls", why: "x".repeat(400) }).why!.length, 300);
  const base = { kind: "tool" as const, agentId: "a1", agentName: "Ada", tool: "browser_act", input: said.input };
  const reworded = describeRequest({ ...base, input: splitWhy({ ...said.input, why: "because" }).input });
  assert.equal(describeRequest(base), reworded);
  assert.equal(fingerprintOf("a1", describeRequest(base)), fingerprintOf("a1", reworded));
  assert.equal(WHY_FIELD.why.type, "string");
});

test("the case is labelled as the agent's own words; nothing when it said nothing", () => {
  assert.equal(agentCaseText("Ada", "the report is due today"), "Ada says (its own words, not checked): the report is due today");
  assert.equal(agentCaseText("Ada", undefined), undefined);
  assert.equal(agentCaseText("Ada", "   "), undefined);
  assert.equal(questionLeanText("Ada", "the work account"), "Ada leans to: the work account");
  assert.equal(questionLeanText("Ada", undefined), undefined);
});
