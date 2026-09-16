/**
 * Who answers when the agent that was asked cannot (INV-556).
 *
 * The consumer's tests drive the loop; these pin the two refusals and the wording, which are
 * the parts that would otherwise erode into "close enough" one edit at a time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSuccessor, standInAttribution, standInCheck, standInPrompt, unansweredDetail } from "./successor.ts";

test("a stand-in is either an agent here or a person to go and ask", () => {
  assert.deepEqual(parseSuccessor("@iris"), { kind: "agent", handle: "iris" });
  assert.deepEqual(parseSuccessor("  Chris  "), { kind: "person", name: "Chris" });
  assert.equal(parseSuccessor(""), undefined);
  assert.equal(parseSuccessor(undefined), undefined, "not declaring one is allowed; pretending there is one is not");
});

test("an answer may only be posted by whoever it says it is from", () => {
  const standIn = { originalHandle: "ada", originalName: "Ada", handle: "iris", name: "Iris" };
  assert.deepEqual(standInCheck({ postingAs: "iris", standIn }), { ok: true });

  const refused = standInCheck({ postingAs: "ada", standIn });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.why : "", /an answer in the ledger carries an author/);
  assert.match(refused.ok === false ? refused.why : "", /worse than no answer at all/);
});

test("the stand-in is told, in the same breath as the question, not to invent the other one's reasons", () => {
  const prompt = standInPrompt(
    { body: "为什么当时选了轮询?", work: "INV-553" },
    { originalHandle: "ada", originalName: "Ada", handle: "iris", name: "Iris" },
    { item: "title: the consumer", receipts: "What was written down at the time:\n- 2026-09-10 Ada: no inbound port" }
  );
  assert.match(prompt, /You are @iris on Involute/);
  assert.match(prompt, /@ada \(Ada\) was asked this and did not answer within the deadline/);
  assert.match(prompt, /Open by saying you are not Ada/);
  assert.match(prompt, /You were not there/);
  assert.match(prompt, /mark anything you add as your reconstruction/);
  assert.match(prompt, /Do not guess why Ada did not answer/);
  assert.match(prompt, /2026-09-10 Ada: no inbound port/);
});

test("the attribution says the relation whether or not the model remembered to", () => {
  const standIn = { originalHandle: "ada", originalName: "Ada", handle: "iris", name: "Iris" };
  assert.equal(standInAttribution(standIn, "RUN-245 and PR#475"), "— Iris (@iris), standing in for @ada. Based on RUN-245 and PR#475.");
  assert.match(standInAttribution(standIn, undefined), /I did not make this decision/);
});

test("silence is reported as silence, and says who to ask", () => {
  const none = unansweredDetail({ originalName: "Ada", successor: undefined });
  assert.match(none, /Ada gave no answer within the deadline/);
  assert.match(none, /Nobody is named as its stand-in/);

  const person = unansweredDetail({ originalName: "Ada", successor: { kind: "person", name: "Chris" }, because: "its box does not answer" });
  assert.match(person, /From this side: its box does not answer\./, "what we saw is ours to report");
  assert.match(person, /Ask Chris/);

  // Never a claim about the other machine: we can see that no answer arrived, and that is all.
  for (const line of [none, person, unansweredDetail({ originalName: "Ada", successor: { kind: "agent", handle: "iris" } })]) {
    assert.doesNotMatch(line, /is not running|is offline|has crashed|gave up/);
  }
});
