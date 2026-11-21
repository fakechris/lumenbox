/**
 * Calibration: a judge against a person's labels (INV-1772).
 *
 * Every label in this file is synthetic — written by the test to have a known agreement with a
 * scripted judge — so the arithmetic can be checked. None of it measures any judge.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { calibrate, type HumanLabel, loadLabels, parseLabels, selectForLabelling } from "./calibration.ts";
import { loadCorpus, taskVersion } from "./corpus.ts";
import { type JudgeSection, type JudgeVerdict, outputDigestOf } from "./judges.ts";
import { renderReport } from "./report.ts";
import type { EvalRun } from "./runner.ts";
import { scorecardModelSection, summarise } from "./summary.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tasks = loadCorpus(join(root, "evals/corpus")).test;
const BY = "synthetic test labeller";

/** `cells` per question: [both present, person present only, judge present only, both absent, judge invalid while person said absent]. */
function scripted(cells: Record<string, [number, number, number, number, number?]>): { judges: JudgeSection; labels: HumanLabel[] } {
  const verdicts: JudgeVerdict[] = [];
  const labels: HumanLabel[] = [];
  for (const [question, [both, humanOnly, judgeOnly, neither, invalid = 0]] of Object.entries(cells)) {
    const add = (count: number, human: HumanLabel["label"], verdict: JudgeVerdict["verdict"]) => {
      for (let i = 0; i < count; i += 1) {
        const outputDigest = outputDigestOf(`${question}/${human}/${verdict}/${i}`);
        verdicts.push({ task: `t.${question}`, attempt: i + 1, question, verdict, outputDigest });
        labels.push({ question, outputDigest, label: human, by: BY });
      }
    };
    add(both, "present", "present");
    add(humanOnly, "present", "absent");
    add(judgeOnly, "absent", "present");
    add(neither, "absent", "absent");
    add(invalid, "absent", "invalid");
  }
  return { judges: { model: { provider: "p", model: "judge-model" }, promptVersion: "v1", verdicts, skipped: 0, calls: { made: 0, cached: 0 }, use: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, labels };
}
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("fewer than thirty matched labels calibrate nothing, however well the few agree", () => {
  const { judges, labels } = scripted({ sharp: [10, 0, 0, 19] });
  const result = calibrate(judges, labels);
  assert.equal(result.matched, 29);
  assert.equal(result.calibrated, false);
  assert.deepEqual(result.questions.map(one => [one.mayGate, one.why]), [[false, "29 of 30 labels"]]);
});

test("per question: kappa and catch rate from the table, and under 0.6 — or too few labels, or one answer throughout — may not gate", () => {
  const { judges, labels } = scripted({ loose: [20, 5, 10, 15], sharp: [12, 1, 0, 17], thin: [2, 0, 0, 3], flat: [0, 0, 0, 12] });
  const result = calibrate(judges, labels);
  assert.equal(result.calibrated, true);
  assert.deepEqual(result.labellers, [BY]);
  const by = Object.fromEntries(result.questions.map(one => [one.question, one]));
  // The textbook table: agreement 0.7, chance 0.5.
  near(by.loose!.kappa, 0.4);
  near(by.loose!.catchRate, 20 / 25);
  near(by.loose!.falseKillRate, 10 / 25);
  assert.deepEqual([by.loose!.measured, by.loose!.mayGate, by.loose!.why], [true, false, "kappa 0.40 is under 0.6"], "measured, and measured low: a hint, not a gate");
  // 29 of 30 agree; chance = (13/30)(12/30) + (17/30)(18/30).
  near(by.sharp!.kappa, (29 / 30 - (13 * 12 + 17 * 18) / 900) / (1 - (13 * 12 + 17 * 18) / 900));
  near(by.sharp!.catchRate, 12 / 13);
  assert.deepEqual([by.sharp!.mayGate, by.sharp!.mayReleaseUnattended], [true, true], "kappa 0.93: may gate, and may release where nobody watches");
  assert.deepEqual([by.thin!.mayGate, by.thin!.why], [false, "5 labels on this question; 10 needed"], "perfect agreement on five outputs is still five outputs");
  assert.equal(by.flat!.kappa, undefined);
  assert.equal(by.flat!.catchRate, undefined, "the person found no failure, so nothing says whether the judge would catch one");
  assert.match(by.flat!.why, /one answer throughout/);
  assert.deepEqual([by.flat!.measured, by.flat!.mayGate], [false, false], "one answer throughout is no measurement at all");
});

test("a verdict with no valid quote counts against the judge; two people disagreeing, or a label for another output, is left out and counted", () => {
  const clean = scripted({ q: [15, 0, 0, 15] });
  near(calibrate(clean.judges, clean.labels).questions[0]!.kappa, 1);
  const dodging = scripted({ q: [15, 0, 0, 10, 5] });
  const dodged = calibrate(dodging.judges, dodging.labels).questions[0]!;
  near(dodged.agreement, 25 / 30);
  assert.ok(dodged.kappa! < 0.7, "declining the hard ones does not raise agreement");

  const second: HumanLabel = { ...clean.labels[0]!, label: "absent", by: "another synthetic labeller" };
  const stray: HumanLabel = { question: "q", outputDigest: outputDigestOf("an output this record does not hold"), label: "present", by: BY };
  const result = calibrate(clean.judges, [...clean.labels, second, stray]);
  assert.deepEqual([result.matched, result.conflicting, result.unmatched], [29, 1, 1]);
  assert.equal(result.calibrated, false, "the disputed output does not count towards thirty");
});

test("the label file: an unfilled row is not a label yet, an unsigned or misspelt one is refused with its line", () => {
  const digest = outputDigestOf("x");
  const sheet = [
    JSON.stringify({ task: "t", attempt: 1, question: "q", asks: "…", context: "…", output: "x", outputDigest: digest, label: null, by: null }),
    JSON.stringify({ task: "t", attempt: 2, question: "q", output: "x", outputDigest: digest, label: "present", by: ` ${BY} `, note: "clear" }),
    "",
  ].join("\n");
  assert.deepEqual(parseLabels(sheet, "labels.jsonl"), [{ question: "q", outputDigest: digest, label: "present", by: BY, task: "t", attempt: 2, note: "clear" }]);
  assert.throws(() => parseLabels(JSON.stringify({ question: "q", outputDigest: digest, label: "yes", by: BY }), "f"), /f:1: label must be "present" or "absent"/);
  assert.throws(() => parseLabels(JSON.stringify({ question: "q", outputDigest: digest, label: "absent", by: "" }), "f"), /by is required/);
  assert.throws(() => parseLabels(JSON.stringify({ question: "q", outputDigest: "short", label: "absent", by: BY }), "f"), /outputDigest/);
  const dir = mkdtempSync(join(tmpdir(), "inv1772-labels-"));
  try {
    assert.deepEqual(loadLabels(join(dir, "none")), [], "no directory is no labels");
    writeFileSync(join(dir, "a.jsonl"), sheet);
    writeFileSync(join(dir, "notes.txt"), "not labels");
    assert.equal(loadLabels(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(loadLabels(join(root, "evals/labels")), [], "no person has labelled anything yet, and nothing in the repository pretends otherwise");
});

/** A record over real test tasks with a scripted judge: every third verdict says the failure is present. */
function judgedRecord(more: Partial<EvalRun> = {}): EvalRun {
  const judged = tasks.filter(task => task.subject === "steward" || task.subject === "auto-review");
  const verdicts: JudgeVerdict[] = [];
  const results = judged.map((task, index) => {
    const attempts = [1, 2, 3].map(attempt => {
      const output = `the written check for ${task.id}, attempt ${attempt}`;
      verdicts.push({ task: task.id, attempt, question: task.failureType, verdict: (index + attempt) % 3 === 0 ? "present" : "absent", quote: "the written check", outputDigest: outputDigestOf(output) });
      return { attempt, pass: true, graders: [], labels: [], state: {}, output, model: "m", use: { calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });
    return { id: task.id, version: taskVersion(task), subject: task.subject, source: task.source, failureType: task.failureType, attempts };
  });
  return {
    format: "lumenbox-eval/1", at: "2026-11-19T10:00:00.000Z", commit: "abc1234", dirty: false, split: "test", corpus: { version: "v", tasks: results.length }, k: 3, fake: false,
    models: { summary: { provider: "p", model: "m" } }, calls: { made: 0, cached: 0 }, tasks: results,
    judges: { model: { provider: "p", model: "judge-model" }, promptVersion: "v1", verdicts, skipped: 0, calls: { made: verdicts.length, cached: 0 }, use: { calls: verdicts.length, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ...more,
  };
}

test("the sheet a person fills in: thirty outputs of the test split, spread over the questions and both verdicts, the same every time, without the judge's answer", () => {
  const run = judgedRecord();
  const sheet = selectForLabelling(run, tasks);
  assert.equal(sheet.length, 30);
  assert.deepEqual(selectForLabelling(run, tasks), sheet, "the same record gives the same sheet");
  const perQuestion = new Map<string, number>();
  for (const row of sheet) perQuestion.set(row.question, (perQuestion.get(row.question) ?? 0) + 1);
  assert.equal(perQuestion.size, 4);
  assert.ok(Math.max(...perQuestion.values()) - Math.min(...perQuestion.values()) <= 1, JSON.stringify([...perQuestion]));
  const verdictOf = new Map(run.judges!.verdicts.map(v => [`${v.question}:${v.outputDigest}`, v.verdict]));
  const present = sheet.filter(row => verdictOf.get(`${row.question}:${row.outputDigest}`) === "present").length;
  assert.ok(present >= 10, `${present} of 30 are ones the judge called present: a third of the pool, but as near half the sheet as the pool allows`);
  for (const row of sheet) {
    assert.deepEqual([row.label, row.by], [null, null]);
    assert.ok(!("verdict" in row) && !("quote" in row), "a person shown the verdict agrees with it");
    assert.equal(row.outputDigest, outputDigestOf(row.output));
    assert.ok(row.asks.endsWith("?") && row.context.length > 0);
  }
  assert.deepEqual(parseLabels(sheet.map(row => JSON.stringify(row)).join("\n"), "sheet"), [], "an unfilled sheet holds no labels");

  assert.throws(() => selectForLabelling(judgedRecord({ split: "dev" }), tasks), /drawn from the test split/);
  assert.throws(() => selectForLabelling(judgedRecord({ fake: true }), tasks), /no judged output of a real model/);
  const { judges: _none, ...unjudged } = run;
  assert.throws(() => selectForLabelling(unjudged, tasks), /nothing to label/);
});

test("the page and the scorecard entry say 'not calibrated — may not gate' until thirty real labels match, then give each question its kappa and its standing", () => {
  const run = judgedRecord();
  const page = (labels: HumanLabel[]) => renderReport(run, summarise(run, { labels }), { name: "REPORT-2026-11-19" });
  assert.match(page([]), /\*\*Judge not calibrated — may not gate\.\*\* 0 of the 30 labels/);
  // Synthetic: the person agrees with the scripted judge on every output but those of one question, where they always say "absent".
  const synthetic = (count: number): HumanLabel[] => run.judges!.verdicts.slice(0, count).map(verdict => ({
    question: verdict.question, outputDigest: verdict.outputDigest, by: BY, label: verdict.question === "missed-stopping-point" ? "absent" : (verdict.verdict as "present" | "absent"),
  }));
  assert.match(page(synthetic(29)), /\*\*Judge not calibrated — may not gate\.\*\* 29 of the 30 labels/);
  const calibrated = page(synthetic(run.judges!.verdicts.length));
  assert.doesNotMatch(calibrated, /Judge not calibrated/);
  assert.match(calibrated, new RegExp(`Checked against ${run.judges!.verdicts.length} outputs labelled by ${BY}`));
  assert.match(calibrated, /\| needless-fresh-context \| \d+ \| \d+ \| 0 \| \d+ \| 1\.00 \| 100\.0% \| may gate — kappa 1\.00/);
  // The person never found that failure: the judge's "present" verdicts there are all disagreements, and no catch rate can be told.
  assert.match(calibrated, /\| missed-stopping-point \|[^\n]*\| 0\.00 \| — \| \*\*may not gate\*\* — kappa 0\.00 is under 0\.6/);

  const entry = (labels: HumanLabel[]) => scorecardModelSection(run, summarise(run, { labels }), "eval-test.json").eval!.judges;
  assert.deepEqual(entry([]), { calibrated: false, note: "0 of 30 labels" });
  const full = entry(synthetic(run.judges!.verdicts.length));
  assert.equal(full.calibrated, true);
  assert.ok(full.mayGate!.includes("needless-fresh-context") && !full.mayGate!.includes("missed-stopping-point"));
  assert.equal(full.kappa!["needless-fresh-context"], 1);

  const standIn = judgedRecord({ fake: true });
  assert.match(renderReport(standIn, summarise(standIn, { labels: synthetic(60) }), { name: "REPORT-2026-11-19" }), /Judge not calibrated — may not gate\.\*\* The judge here is the stand-in/, "no label calibrates a stand-in");
});
