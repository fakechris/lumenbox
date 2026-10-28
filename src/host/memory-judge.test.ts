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

test("the decision-model judge asks each candidate's questions in one request and maps the answers to verdicts", async () => {
  const { jevJudge } = await import("./memory-judge.ts");
  let asked: import("./jev.ts").JevRequest | undefined;
  const judge = jevJudge(async request => {
    asked = request;
    return {
      model: "m",
      ms: 1,
      answers: {
        c0_fromContent: { type: "noul", noul: 0.92 },
        c0_narrowsRules: { type: "noul", noul: 0.1 },
        c0_contradicts: { type: "choice", choice: "none", confidence: 0.8, probabilities: { none: 0.8, K1: 0.2 } },
        c0_duplicate: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.95, K1: 0.05 } },
        c1_fromContent: { type: "noul", noul: 0.05 },
        c1_narrowsRules: { type: "noul", noul: 0.02 },
      },
    };
  });
  const verdicts = await judge({ conversation: "…", candidates: ["they live in Shanghai now", "the sky was clear"], known: ["they live in Beijing"] });
  assert.ok(asked !== undefined);
  assert.equal(Object.keys(asked.questions).length, 6, "a candidate that shares no word with any known line is not asked to name one");
  assert.deepEqual(Object.keys((asked.questions.c0_contradicts as { criteria: Record<string, string> }).criteria), ["none", "K1"]);
  assert.deepEqual(verdicts[0]!.fromContent, { answer: true, confidence: 0.92 });
  assert.equal(verdicts[0]!.narrowsRules.answer, false);
  assert.equal(verdicts[0]!.contradicts.answer, false);
  assert.deepEqual(verdicts[1]!.contradicts, { answer: false, confidence: 1 });
  // The verdicts go through the same rules: a sure fromContent holds the candidate.
  const out = dispose([candidate("they live in Shanghai now"), candidate("the sky was clear")], verdicts, known);
  assert.equal(out.held.length, 1);
  assert.equal(out.keep.length, 1);
});

test("a named contradiction carries its target and the probability that it is not none", async () => {
  const { jevJudge, verdictsSummary } = await import("./memory-judge.ts");
  const judge = jevJudge(async () => ({
    model: "m",
    ms: 1,
    answers: {
      c0_fromContent: { type: "noul", noul: 0.02 },
      c0_narrowsRules: { type: "noul", noul: 0.03 },
      c0_contradicts: { type: "choice", choice: "K1", confidence: 0.85, probabilities: { none: 0.1, K1: 0.85, K2: 0.05 } },
      c0_duplicate: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9, K1: 0.1 } },
    },
  }));
  const verdicts = await judge({ conversation: "…", candidates: ["they live in Shanghai, not Beijing"], known: ["they live in Beijing", "they live near Beijing station"] });
  assert.deepEqual(verdicts[0]!.contradicts, { answer: true, confidence: 0.9, target: 1 });
  assert.match(verdictsSummary(verdicts)[0]!, /contradicts=y0\.90K1/);
  assert.ok(!verdictsSummary(verdicts)[0]!.includes("Beijing"), "the shadow summary never carries the text");
});
