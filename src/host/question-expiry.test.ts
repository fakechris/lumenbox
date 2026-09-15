/**
 * Questions that expire (INV-526): answered clears silently; expired with a default wakes
 * the agent to proceed on it and tells the chat; expired without one is a skip; the window
 * is bounded; a second question in the same conversation replaces the first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTION_EXPIRED_CUE, QUESTION_TTL_MAX_MS, QUESTION_TTL_MIN_MS, QUESTION_TTL_MS, QuestionWatch } from "./question-expiry.ts";

const T0 = Date.parse("2026-09-14T09:00:00Z");

test("an answered question clears; an expired one goes to its default and says so; one without a default is skipped", () => {
  const watch = new QuestionWatch();
  watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "EU or US region?", fallback: "EU, as last quarter", now: T0 });
  watch.ask({ agentId: "a2", agentName: "Bob", conversation: "feishu-x", question: "Which account?", now: T0 });
  watch.ask({ agentId: "a3", agentName: "Cy", conversation: "main", question: "Ship Friday?", fallback: "yes", now: T0 });
  assert.equal(watch.list().length, 3);

  // Before the window: nothing due, except the one that was answered.
  const early = watch.sweep(q => q.agentId === "a3", T0 + 60_000);
  assert.deepEqual(early.map(e => [e.question.agentId, e.verdict]), [["a3", "answered"]]);
  assert.equal(watch.list().length, 2);

  const due = watch.sweep(() => false, T0 + QUESTION_TTL_MS + 1);
  assert.deepEqual(due.map(e => [e.question.agentId, e.verdict]), [["a1", "default"], ["a2", "skipped"]]);
  const byDefault = due[0]!;
  assert.ok(byDefault.verdict === "default");
  assert.ok(byDefault.cue.startsWith(QUESTION_EXPIRED_CUE));
  assert.match(byDefault.cue, /No answer in 4 hours to your question "EU or US region\?"\. Proceed on the default you named — EU, as last quarter — and say in one line/);
  assert.match(byDefault.toChat, /^Ada: no answer to "EU or US region\?" in 4 hours — going with the default: EU, as last quarter$/);
  const skipped = due[1]!;
  assert.ok(skipped.verdict === "skipped");
  assert.match(skipped.cue, /The person has moved on; treat it as skipped: decide it yourself/);
  assert.equal(watch.list().length, 0, "settled either way");
  assert.deepEqual(watch.sweep(() => false, T0 + QUESTION_TTL_MS * 2), [], "nothing fires twice");
});

test("the window is bounded, and a second question in the same conversation replaces the first", () => {
  const watch = new QuestionWatch();
  const short = watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "q", ttlMs: 1, now: T0 });
  assert.equal(short.expiresAt - short.askedAt, QUESTION_TTL_MIN_MS);
  const long = watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "q2", ttlMs: 365 * 86_400_000, now: T0 });
  assert.equal(long.expiresAt - long.askedAt, QUESTION_TTL_MAX_MS);
  assert.deepEqual(watch.list().map(q => q.question), ["q2"], "one open question per conversation");
});
