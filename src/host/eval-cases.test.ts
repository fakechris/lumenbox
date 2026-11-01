import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerReviewer } from "./answer-review.ts";
import { evalCasePath, parseEvalCase, readEvalCases, writeEvalCase } from "./eval-cases.ts";

test("a reply judged bad is kept once as a case with its labels and version, and reads back; a person's Expected survives (INV-1474)", () => {
  const dir = mkdtempSync(join(tmpdir(), "evals-"));
  try {
    const c = {
      agent: "Ada", messageId: "msg/1", conversation: "main", at: "2026-11-01T10:00:00.000Z",
      category: "NON_ANSWER", confidence: 0.91, reason: "describes a plan, gives no figure",
      request: "How much did we spend in October?", answer: "I will look into the ledger and get back to you.",
      version: { standing: { SOUL: "abcd" }, skills: { "data-brief": "ef01" }, parts: { conduct: "c0" } },
    };
    const path = writeEvalCase(dir, c);
    assert.equal(path, join(dir, "Ada", "2026-11-01-msg-1.md"));
    assert.equal(evalCasePath(dir, c), path);
    assert.equal(writeEvalCase(dir, { ...c, answer: "a second review of the same message" }), undefined, "one file per message");
    const text = readFileSync(path!, "utf8");
    assert.match(text, /"category": "NON_ANSWER"/);
    assert.match(text, /## Request\n\nHow much did we spend in October\?\n\n## Answer\n\nI will look into the ledger/);
    assert.match(text, /## Expected\n\n$/, "empty, for the person to fill");
    writeFileSync(path!, text.replace(/## Expected\n\n$/, "## Expected\n\n¥12,400 in October, 8% over September.\n"));
    const back = readEvalCases(dir, "Ada");
    assert.equal(back.length, 1);
    assert.equal(back[0]!.case.expected, "¥12,400 in October, 8% over September.");
    assert.deepEqual(back[0]!.case.version, c.version);
    assert.equal(back[0]!.case.request, c.request);
    assert.deepEqual(readEvalCases(dir, "Nobody"), []);
    assert.equal(parseEvalCase("not a case"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reviewer hands a non-PASS reply to the case keeper with its text, and a PASS or an unavailable review to nobody", async () => {
  const kept: { category: string; messageId: string; answer: string }[] = [];
  const verdicts = ['{"category":"NON_ANSWER","confidence":0.9,"reason":"no figure"}', '{"category":"PASS","confidence":0.9,"reason":"fine"}'];
  const reviewer = new AnswerReviewer({ ask: async () => verdicts.shift(), mode: () => "shadow", keepCase: c => kept.push(c) });
  await reviewer.review({ agentName: "Ada", messageId: "m1", conversation: "main", request: "how much?", answer: "later" });
  await reviewer.review({ agentName: "Ada", messageId: "m2", conversation: "main", request: "hi", answer: "hello" });
  await new AnswerReviewer({ ask: async () => { throw new Error("down"); }, mode: () => "shadow", keepCase: c => kept.push(c) })
    .review({ agentName: "Ada", messageId: "m3", conversation: "main", request: "x", answer: "y" });
  assert.deepEqual(kept.map(c => `${c.messageId} ${c.category}`), ["m1 NON_ANSWER"]);
  assert.equal(kept[0]!.answer, "later", "the keeper gets the text the record only hashes");
  const dir = mkdtempSync(join(tmpdir(), "evals-"));
  try {
    assert.ok(existsSync(writeEvalCase(dir, { ...kept[0]!, agent: "Ada", at: "2026-11-01T10:00:00.000Z", request: "how much?", confidence: 0.9, reason: "no figure" })!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
