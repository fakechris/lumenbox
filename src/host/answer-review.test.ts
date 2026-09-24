import assert from "node:assert/strict";
import test from "node:test";
import { AnswerReviewer, buildAnswerReviewPrompt, parseAnswerVerdict, recoverySuggestion, sampledForReview } from "./answer-review.ts";

test("answer review parses typed verdicts and suggests recovery only for high-confidence failures", () => {
  const bad = parseAnswerVerdict('{"category":"NON_ANSWER","confidence":0.96,"reason":"only delegated"}')!;
  assert.equal(bad.category, "NON_ANSWER");
  assert.match(recoverySuggestion(bad)!, /\/retry/);
  assert.equal(recoverySuggestion({ ...bad, confidence: 0.5 }), undefined);
  assert.equal(recoverySuggestion({ category: "PASS", confidence: 1, reason: "direct" }), undefined);
  assert.equal(parseAnswerVerdict("not json"), undefined);
  assert.equal(parseAnswerVerdict('{"category":"WRONG","confidence":1}'), undefined);
});

test("the review prompt contains only the current request and final answer labels", () => {
  const prompt = buildAnswerReviewPrompt({ agentName: "Nova", messageId: "m1", conversation: "c1", request: "CURRENT_REQUEST", answer: "FINAL_REPLY" });
  assert.match(prompt, /CURRENT_REQUEST/);
  assert.match(prompt, /FINAL_REPLY/);
  assert.doesNotMatch(prompt, /history|memory/i);
});

test("sampling is stable and honours zero and full rollout", () => {
  assert.equal(sampledForReview("m1", 0), false);
  assert.equal(sampledForReview("m1", 100), true);
  assert.equal(sampledForReview("stable", 17), sampledForReview("stable", 17));
});

test("an unavailable reviewer fails open as UNKNOWN and records hashes rather than answer text", async () => {
  const records: unknown[] = [];
  const reviewer = new AnswerReviewer({ ask: async () => { throw new Error("down"); }, mode: () => "shadow", record: record => records.push(record) });
  const verdict = await reviewer.review({ agentName: "Nova", messageId: "m1", conversation: "c1", request: "secret request", answer: "secret answer" });
  assert.equal(verdict.category, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(records), /secret request|secret answer/);
  assert.match(JSON.stringify(records), /"unavailable":true/);
});
