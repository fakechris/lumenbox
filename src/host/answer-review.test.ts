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

test("with the decision model on, the review is one choice, falls back to the model when it fails, and samples every reply", async () => {
  const { answerReviewPercent } = await import("./answer-review.ts");
  const jevAnswer = { model: "m", ms: 1, answers: { category: { type: "choice" as const, choice: "NON_ANSWER", confidence: 0.91, probabilities: { NON_ANSWER: 0.91, PASS: 0.09 } } } };
  let modelCalls = 0;
  let asked: import("./jev.ts").JevRequest | undefined;
  const on = (ok: boolean): import("./jev.ts").SwitchDeps => ({
    mode: () => "on",
    client: () => async request => { asked = request; if (!ok) throw new Error("down"); return jevAnswer; },
    record: () => {},
    log: () => {},
  });
  const reviewer = (ok: boolean) => new AnswerReviewer({ ask: async () => { modelCalls += 1; return '{"category":"PASS","confidence":0.8,"reason":"fine"}'; }, jev: on(ok) });
  const input = { agentName: "Ada", messageId: "m1", conversation: "main", request: "what is the deploy date?", answer: "I'll look into it." };

  const verdict = await reviewer(true).review(input);
  assert.equal(verdict.category, "NON_ANSWER");
  assert.equal(verdict.confidence, 0.91);
  assert.equal(modelCalls, 0);
  assert.deepEqual(Object.keys((asked!.questions.category as { criteria: Record<string, string> }).criteria), ["PASS", "NON_ANSWER", "PROCESS_OVER_RESULT", "CONTEXT_BLEED", "UNKNOWN"]);
  assert.ok(recoverySuggestion(verdict) !== undefined, "the suggestion threshold is unchanged");

  assert.equal((await reviewer(false).review(input)).category, "PASS", "a failed decision model leaves the model's review");
  assert.equal(modelCalls, 1);

  assert.equal(answerReviewPercent(on(true)), 100);
  assert.equal(answerReviewPercent({ ...on(true), mode: () => "off" }), 5);
});
