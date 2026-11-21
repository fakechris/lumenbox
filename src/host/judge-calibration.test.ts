/**
 * The product's judges against a person's labels (INV-1773).
 *
 * Every verdict and every label here is synthetic, written by the test into a temporary home to
 * have a known agreement with a scripted judge. None of it measures any judge, and none of it is
 * read from or written to a real installation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnswerReviewer } from "./answer-review.ts";
import { AutoReviewer, REVIEW_QUESTION, type ReviewInput } from "./auto-review.ts";
import { appendLine } from "./jsonl.ts";
import { appendProductLabel, computeStandings, handsBack, judgeBooksAt, releasesUnattended } from "./judge-calibration.ts";
import { JUDGE_LEDGERS, readVerdicts } from "./judge-record.ts";
import type { SwitchDeps } from "./jev.ts";
import { dispose, type Verdicts } from "./memory-judge.ts";

const BY = "synthetic test labeller";

function home(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "inv1773-judges-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const call = (n: number): ReviewInput => ({ agentName: "Ada", trusted: ["tidy the repo"], untrusted: [], tool: "bash", input: { command: `git push origin b${n}` }, why: "reaches out", callId: `toolu_${n}`, conversation: "main" });

/**
 * Writes auto-review verdicts through the reviewer itself, and labels a person would have given:
 * `cells` = [both said failure, person only, judge only, neither], as calibration.test.ts counts them.
 */
async function reviewed(dir: string, [both, personOnly, judgeOnly, neither]: [number, number, number, number], label = true): Promise<void> {
  let n = 0;
  const one = async (judge: "BLOCK" | "ALLOW", person: "present" | "absent") => {
    n += 1;
    const reviewer = new AutoReviewer({
      ask: async () => JSON.stringify({ verdict: judge, reason: "scripted" }), mode: () => "shadow", model: () => "scripted-model",
      record: entry => appendLine(join(dir, JUDGE_LEDGERS["auto-review"]), JSON.stringify(entry)),
    });
    await reviewer.review(call(n));
    const written = readVerdicts(dir).at(-1)!;
    if (label) appendProductLabel(dir, { question: REVIEW_QUESTION, outputDigest: written.digest, label: person, by: BY, at: "2026-11-20T00:00:00.000Z" });
  };
  for (let i = 0; i < both; i += 1) await one("BLOCK", "present");
  for (let i = 0; i < personOnly; i += 1) await one("ALLOW", "present");
  for (let i = 0; i < judgeOnly; i += 1) await one("BLOCK", "absent");
  for (let i = 0; i < neither; i += 1) await one("ALLOW", "absent");
}

const enforcing = (dir: string) => new AutoReviewer({
  ask: async () => JSON.stringify({ verdict: "BLOCK", reason: "nobody asked for a push" }), mode: () => "enforce",
  handsBack: (judge, question) => judgeBooksAt(dir).handsBack(judge, question),
});

const clean = { answer: false, confidence: 0.9 };
const sure: Verdicts = { fromContent: clean, narrowsRules: clean, contradicts: { answer: true, confidence: 0.92, target: 1 }, duplicate: clean };
const memory = { at: "2026-11-01T00:00:00.000Z", kind: "fact" as const, text: "they live in Shanghai" };
const knownLine = { at: "2026-10-01T00:00:00.000Z", kind: "fact" as const, text: "they live in Beijing" };

test("a fresh installation: every judge reads not calibrated, and every gate decides exactly as it did", async () => {
  const { dir, done } = home();
  try {
    // Verdicts, but no label: as on any installation where nobody has labelled yet.
    await reviewed(dir, [20, 5, 10, 15], false);
    const standings = computeStandings(dir);
    assert.deepEqual(standings.judges.map(one => one.judge), ["auto-review", "answer-review", "memory-judge", "jev"]);
    for (const judge of standings.judges) {
      assert.equal(judge.calibration.calibrated, false, `${judge.judge} is not calibrated`);
      for (const question of judge.calibration.questions) {
        assert.equal(question.measured, false);
        assert.equal(handsBack(standings, judge.judge, question.question), false, `${question.question} decides as before`);
        assert.equal(releasesUnattended(standings, judge.judge, question.question), false, "and releases nothing alone");
      }
    }
    assert.ok(standings.judges.find(one => one.judge === "memory-judge")!.calibration.questions.length === 4, "a judge that has judged nothing yet is still listed");

    // The enforced BLOCK still refuses; the memory judge still withdraws what it is sure contradicts.
    const verdict = await enforcing(dir).review(call(99));
    assert.deepEqual(verdict, { verdict: "BLOCK", reason: "nobody asked for a push" });
    const books = judgeBooksAt(dir);
    const withBooks = dispose([memory], [sure], [knownLine], new Date(0), question => books.handsBack("memory-judge", `memory-judge:${question}`));
    assert.deepEqual(withBooks, dispose([memory], [sure], [knownLine], new Date(0)));
    assert.equal(withBooks.retractions.length, 1);
  } finally {
    done();
  }
});

test("measured under 0.6 a judge is a hint: the enforced BLOCK is handed to a person, and nothing is withdrawn on its word", async () => {
  const { dir, done } = home();
  try {
    // The textbook table: agreement 0.7, chance 0.5, kappa 0.4.
    await reviewed(dir, [20, 5, 10, 15]);
    const standings = computeStandings(dir);
    const question = standings.judges.find(one => one.judge === "auto-review")!.calibration.questions.find(one => one.question === REVIEW_QUESTION)!;
    assert.ok(Math.abs(question.kappa! - 0.4) < 1e-9);
    assert.ok(Math.abs(question.catchRate! - 20 / 25) < 1e-9);
    assert.ok(Math.abs(question.falseKillRate! - 10 / 25) < 1e-9);
    assert.deepEqual([question.measured, question.mayGate], [true, false]);

    const verdict = await enforcing(dir).review(call(99));
    assert.deepEqual(verdict, { verdict: "BLOCK", reason: "nobody asked for a push", handBack: true }, "not refused by the reviewer: the turn hands it to the policy gate, which asks a person");
    // The other judges are unmeasured and keep their gates.
    const books = judgeBooksAt(dir);
    assert.equal(dispose([memory], [sure], [knownLine], new Date(0), q => books.handsBack("memory-judge", `memory-judge:${q}`)).retractions.length, 1);
    assert.equal(books.handsBack("jev", REVIEW_QUESTION), false, "a label checks the decision model too, but it has given no verdict on these outputs");
  } finally {
    done();
  }
});

test("between 0.6 and 0.8 a judge may gate with a person about, and may not release anything alone where nobody watches", async () => {
  const { dir, done } = home();
  try {
    // 26 of 30 agree, chance 0.5: kappa ≈ 0.73.
    await reviewed(dir, [13, 2, 2, 13]);
    const standings = computeStandings(dir);
    const kappa = standings.judges.find(one => one.judge === "auto-review")!.calibration.questions[0]!.kappa!;
    assert.ok(kappa > 0.6 && kappa < 0.8, String(kappa));
    assert.equal(handsBack(standings, "auto-review", REVIEW_QUESTION), false, "its BLOCK still refuses");
    assert.equal(releasesUnattended(standings, "auto-review", REVIEW_QUESTION), false);
    assert.equal((await enforcing(dir).review(call(99))).handBack, undefined);
  } finally {
    done();
  }
});

test("every verdict names its judge where it is written; the answer review is a satisfaction measure; the decision model's shadow answer is its own verdict", async () => {
  const { dir, done } = home();
  try {
    const answers: Record<string, unknown>[] = [];
    const shadow: Record<string, unknown>[] = [];
    const jev: SwitchDeps = {
      mode: () => "shadow", log: () => {}, record: entry => { shadow.push(entry as unknown as Record<string, unknown>); appendLine(join(dir, JUDGE_LEDGERS.shadow), JSON.stringify(entry)); },
      client: () => async request => ({ model: "jev-synthetic", ms: 1, answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "choice", choice: "PASS", confidence: 0.9, probabilities: {} }])) }),
    };
    const reviewer = new AnswerReviewer({
      ask: async () => JSON.stringify({ category: "NON_ANSWER", confidence: 0.9, reason: "scripted" }), mode: () => "shadow", model: () => "scripted-model", jev,
      record: record => { answers.push(record as unknown as Record<string, unknown>); appendLine(join(dir, JUDGE_LEDGERS["answer-review"]), JSON.stringify(record)); },
    });
    await reviewer.review({ source: "member", agentName: "Ada", messageId: "m1", conversation: "main", request: "what is the plan", answer: "I am looking into it" });
    await new Promise(resolve => setTimeout(resolve, 20)); // the shadow answer is written after the reply goes out
    const [line] = answers;
    assert.deepEqual([line!.judge, line!.judgeModel, line!.question, line!.judged, line!.measures], ["answer-review", "scripted-model", "answer-review:not-answered", "present", "satisfaction"]);
    assert.deepEqual((line!.evidence as { read: string[] }).read, ["the request", "the reply"]);
    assert.ok(typeof line!.judgeVersion === "string" && !JSON.stringify(line).includes("looking into it"), "hashes and names, never the words");
    assert.deepEqual([shadow[0]!.judgeModel, (shadow[0]!.judged as { verdict: string }[])[0]!.verdict], ["jev-synthetic", "absent"]);
    const verdicts = readVerdicts(dir);
    assert.deepEqual(verdicts.map(one => [one.judge, one.verdict]), [["answer-review", "present"], ["jev", "absent"]]);
    assert.equal(verdicts[0]!.digest, verdicts[1]!.digest, "one output: one label checks both judges");

    // A guest's answer leaves no digest outside the guest's own record (INV-1721).
    shadow.length = 0;
    await reviewer.review({ source: "guest", agentName: "Ada", messageId: "g1", conversation: "guest:x", request: "price?", answer: "ten", guest: { knowledge: "", turnId: "t", door: "d" } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(shadow[0]?.judged, undefined);
    assert.equal(answers.length, 1);
    assert.match(readFileSync(join(dir, JUDGE_LEDGERS.shadow), "utf8"), /jev-synthetic/);
  } finally {
    done();
  }
});
