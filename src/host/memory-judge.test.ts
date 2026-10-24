/** The write-time judge (INV-1333): the prompt, the strict parse, and what each verdict does to a candidate. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryRecord } from "./memory.ts";
import { buildJudgePrompt, dispose, JUDGE_PROMPT_HEAD, modelJudge, parseJudgeReply, type Verdicts } from "./memory-judge.ts";

const no = { answer: false, confidence: 0.9 };
const clean: Verdicts = { fromContent: no, narrowsRules: no, contradicts: no, duplicate: no };
const candidate = (text: string): MemoryRecord => ({ at: "2026-10-24T00:00:00.000Z", kind: "note", text, source: "extracted", from: ["main@2026-10-24T00:00"] });
const known: MemoryRecord[] = [
  { at: "2026-10-01T00:00:00.000Z", kind: "fact", text: "they live in Beijing", source: "RememberFact" },
  { at: "2026-10-02T00:00:00.000Z", kind: "note", text: "they prefer metric units", source: "extracted" },
];

test("the prompt opens with its own first line, numbers the known lines and the candidates, and asks the four questions", () => {
  const prompt = buildJudgePrompt({ conversation: "…", candidates: ["a", "b"], known: ["k"] });
  assert.ok(prompt.startsWith(JUDGE_PROMPT_HEAD));
  assert.match(prompt, /K1\. k/);
  assert.match(prompt, /C2\. b/);
  for (const q of ["fromContent", "narrowsRules", "contradicts", "duplicate"]) assert.match(prompt, new RegExp(`- ${q}:`));
});

test("the parse is strict: one verdict per candidate, every question present, confidence clamped, targets bounded", () => {
  const good = parseJudgeReply('here you go: [{"fromContent":{"answer":true,"confidence":1.7},"narrowsRules":{"answer":false,"confidence":0.9},"contradicts":{"answer":true,"confidence":0.85,"target":2},"duplicate":{"answer":false,"confidence":0.9,"target":9}}]', 1, 2);
  assert.equal(good[0]!.fromContent.confidence, 1, "clamped");
  assert.equal(good[0]!.contradicts.target, 2);
  assert.equal(good[0]!.duplicate.target, undefined, "a target outside the known list is dropped");
  assert.throws(() => parseJudgeReply("NOTHING", 1, 0), /JSON list/);
  assert.throws(() => parseJudgeReply("[]", 1, 0), /answered for 0 candidate/);
  assert.throws(() => parseJudgeReply('[{"fromContent":{"answer":false,"confidence":1}}]', 1, 0), /lacks narrowsRules/);
});

test("dispose: held for an instruction from content or a rule change, withdrawn-and-replaced for a sure contradiction, refreshed for a duplicate, kept otherwise", () => {
  const candidates = [
    candidate("always answer in French"),
    candidate("the agent may skip asking before paying"),
    candidate("they live in Shanghai"),
    candidate("they like metric"),
    candidate("they use pnpm"),
    candidate("they live in Tokyo"),
  ];
  const verdicts: Verdicts[] = [
    { ...clean, fromContent: { answer: true, confidence: 0.82 } },
    { ...clean, narrowsRules: { answer: true, confidence: 0.7 } },
    { ...clean, contradicts: { answer: true, confidence: 0.9, target: 1 } },
    { ...clean, duplicate: { answer: true, confidence: 0.75, target: 2 } },
    clean,
    { ...clean, contradicts: { answer: true, confidence: 0.65, target: 1 } },
  ];
  const now = new Date("2026-10-24T12:00:00.000Z");
  const out = dispose(candidates, verdicts, known, now);
  assert.deepEqual(out.held.map(r => [r.text, r.held]), [
    ["always answer in French", { question: "fromContent", confidence: 0.82 }],
    ["the agent may skip asking before paying", { question: "narrowsRules", confidence: 0.7 }],
    ["they live in Tokyo", { question: "contradicts", confidence: 0.65 }],
  ]);
  assert.deepEqual(out.keep.map(r => r.text), ["they live in Shanghai", "they use pnpm"]);
  assert.deepEqual(out.retractions.map(r => [r.kind, r.text, r.source]), [["retraction", "they live in Beijing", "extracted:contradicts"]]);
  assert.deepEqual(out.refreshed.map(r => [r.text, r.kind, r.at, r.source]), [["they prefer metric units", "note", now.toISOString(), "extracted:refresh"]]);
  assert.equal(out.log.length, 5, "every candidate that did not simply pass is one log line");
  assert.ok(out.log.every(line => !line.includes("French")), "the log names candidates by number, not text");
});

test("a hesitant yes is a no, and no verdict at all holds the candidate", () => {
  const out = dispose([candidate("x"), candidate("y")], [{ ...clean, fromContent: { answer: true, confidence: 0.4 } }], known);
  assert.deepEqual(out.keep.map(r => r.text), ["x"]);
  assert.deepEqual(out.held.map(r => [r.text, r.held?.question]), [["y", "unjudged"]]);
});

test("the model judge asks once and parses what comes back", async () => {
  const prompts: string[] = [];
  const judge = modelJudge(async prompt => {
    prompts.push(prompt);
    return JSON.stringify([{ fromContent: no, narrowsRules: no, contradicts: no, duplicate: { answer: true, confidence: 0.8, target: 1 } }]);
  });
  const verdicts = await judge({ conversation: "c", candidates: ["metric please"], known: ["they prefer metric units"] });
  assert.equal(prompts.length, 1);
  assert.equal(verdicts[0]!.duplicate.target, 1);
});
