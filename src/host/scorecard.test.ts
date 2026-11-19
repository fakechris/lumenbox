/**
 * The release scorecard's verdicts (INV-130): hard gates fail, a missing model section is
 * INCOMPLETE and never PASS, a regression against a comparable baseline is REVIEW until a
 * named person accepts it, a baseline from another model is refused, and the injected
 * failure closes the gate — through the script, not only the function.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScorecard, compareModelSections, describeScorecard, exitCodeFor, passRates, type EvalNumbers, type ModelSection, type ScorecardInput } from "./scorecard.ts";

const ran = (rates: Record<string, boolean[]>, extra: Partial<ModelSection> = {}): ModelSection => ({
  status: "ran",
  provider: "fixture",
  model: "fixture-model",
  fixtureVersion: "abc123",
  runs: 3,
  results: Object.entries(rates).flatMap(([key, values]) => {
    const [scenario, check] = key.split("/");
    return values.map((ok, i) => ({ scenario: scenario!, run: i + 1, seconds: 1, checks: { [check!]: ok } }));
  }),
  ...extra,
});

const base: ScorecardInput = {
  commit: "abc",
  dirty: false,
  node: "v22",
  startedAt: "2026-09-13T00:00:00Z",
  endedAt: "2026-09-13T00:10:00Z",
  deterministic: { status: "pass", pass: 1345, fail: 0, floor: 1345 },
  artifact: { status: "pass" },
  model: { status: "skipped", reason: "no credentials" },
};

test("hard gates: a failing suite or artifact is FAIL whatever else is true", () => {
  assert.equal(buildScorecard({ ...base, deterministic: { status: "fail", fail: 2 } }).verdict.status, "FAIL");
  assert.equal(buildScorecard({ ...base, artifact: { status: "fail", failures: ["the CLI runs and prints its usage"] } }).verdict.status, "FAIL");
  assert.equal(buildScorecard({ ...base, injectFailure: true }).verdict.status, "FAIL");
  assert.equal(exitCodeFor("FAIL"), 1);
});

test("no model results is INCOMPLETE and says SKIPPED, never PASS", () => {
  const card = buildScorecard(base);
  assert.equal(card.verdict.status, "INCOMPLETE");
  assert.ok(card.verdict.reasons.some(r => /SKIPPED: no credentials/.test(r)));
  assert.equal(exitCodeFor("INCOMPLETE"), 2);
  assert.ok(describeScorecard(card).some(line => /model: SKIPPED — no credentials/.test(line)));
});

test("a comparable baseline with no regression is PASS; a regression is REVIEW until a named person accepts it", () => {
  const now = ran({ "team/agents created": [true, true, true], "vague/≤1 question": [true, false, true] });
  const before = ran({ "team/agents created": [true, true, true], "vague/≤1 question": [true, true, true] });
  const review = buildScorecard({ ...base, model: now, baseline: { commit: "aaa", model: before } });
  assert.equal(review.verdict.status, "REVIEW");
  assert.ok(review.verdict.reasons.some(r => /vague\/≤1 question \(100% → 67%\)/.test(r)));
  assert.equal(exitCodeFor("REVIEW"), 3);
  const accepted = buildScorecard({ ...base, model: now, baseline: { commit: "aaa", model: before }, acceptedRegressions: [{ key: "vague/≤1 question", by: "chris", why: "new prompt asks once on purpose" }] });
  assert.equal(accepted.verdict.status, "PASS");
  assert.ok(accepted.verdict.reasons.some(r => /accepted by chris/.test(r)));
  const same = buildScorecard({ ...base, model: before, baseline: { commit: "aaa", model: before } });
  assert.equal(same.verdict.status, "PASS");
  assert.equal(exitCodeFor("PASS"), 0);
});

test("a baseline from another model or fixture version is refused, and the card is INCOMPLETE, not PASS", () => {
  const now = ran({ "team/agents created": [true, true, true] });
  const other = ran({ "team/agents created": [true, true, true] }, { model: "other-model" });
  const card = buildScorecard({ ...base, model: now, baseline: { commit: "aaa", model: other } });
  assert.equal(card.verdict.status, "INCOMPLETE");
  assert.equal(card.comparison?.comparable, false);
  assert.match(card.comparison?.why ?? "", /differs in model/);
  const noBaseline = buildScorecard({ ...base, model: now });
  assert.equal(noBaseline.verdict.status, "INCOMPLETE");
  assert.ok(noBaseline.verdict.reasons.some(r => /no baseline/.test(r)));
});

test("pass rates and comparison rows", () => {
  const rates = passRates(ran({ "a/x": [true, false, false] }).results!);
  assert.equal(rates.get("a/x"), 1 / 3);
  const rows = compareModelSections(ran({ "a/x": [true, true] }), ran({ "a/x": [true, false] })).rows;
  assert.deepEqual(rows.map(r => [r.key, r.regressed, Math.round(r.delta * 100)]), [["a/x", false, 50]]);
});

const numbers = (comparison: EvalNumbers["comparison"], judges: EvalNumbers["judges"] = { calibrated: false, note: "0 of 30 labels" }): ModelSection => ({
  status: "ran", provider: "fixture", model: "fixture-model", fixtureVersion: "corpus1", runs: 3,
  eval: { record: "eval-test.json", split: "test", tasks: 75, k: 3, passRate: { estimate: 0.84, low: 0.77, high: 0.9 }, passHatK: 0.72, passAtK: 0.92, detectableDifference: 0.17, comparison, judges },
});

test("an evaluation record fills the model section: REVIEW only for a drop beyond noise, INCOMPLETE when it settles nothing, and the judge's standing is said", () => {
  const steady = buildScorecard({ ...base, model: numbers({ verdict: "NO_CHANGE_DETECTED", why: "2 worse, 3 better of 75: no drop (p = 1.000)" }) });
  assert.equal(steady.verdict.status, "PASS");
  assert.ok(steady.verdict.reasons.some(reason => /judge not calibrated — may not gate \(0 of 30 labels\)/.test(reason)), "an unchecked judge is named on the card even when it passes");
  const text = describeScorecard(steady).join("\n");
  assert.match(text, /model: ran 3×75 on fixture fixture-model/);
  assert.match(text, /pass rate 84\.0% \[77\.0% – 90\.0%\]; pass\^3 72\.0%, pass@3 92\.0%/);
  assert.match(text, /smallest detectable difference 17\.0%; judges: not calibrated — may not gate/);

  const worse = { verdict: "REVIEW" as const, why: "12 worse, 1 better of 75: more than noise produces (p = 0.003)" };
  const review = buildScorecard({ ...base, model: numbers(worse) });
  assert.equal(review.verdict.status, "REVIEW");
  assert.equal(exitCodeFor(review.verdict.status), 3);
  assert.match(review.verdict.reasons.join(" "), /--accept "eval=<name>"/);
  const accepted = buildScorecard({ ...base, model: numbers(worse), acceptedRegressions: [{ key: "eval", by: "Chris" }] });
  assert.equal(accepted.verdict.status, "PASS");
  assert.match(accepted.verdict.reasons.join(" "), /accepted by Chris/);

  for (const verdict of ["INCOMPLETE", "NO_BASELINE", "NOT_COMPARABLE"] as const) {
    const card = buildScorecard({ ...base, model: numbers({ verdict, why: "1 worse, 0 better of 3: a drop this size cannot be told from noise here" }) });
    assert.equal(card.verdict.status, "INCOMPLETE", `${verdict}: three tasks are not a regression, and not a pass either`);
  }
  const calibrated = buildScorecard({ ...base, model: numbers({ verdict: "IMPROVED", why: "better" }, { calibrated: true, note: "34 labels; may gate: unusable-skill-draft", mayGate: ["unusable-skill-draft"] }) });
  assert.deepEqual([calibrated.verdict.status, calibrated.verdict.reasons], ["PASS", []]);
});

test("the script reads --eval: a stand-in's record leaves the model section SKIPPED and says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-scorecard-eval-"));
  try {
    const record = { format: "lumenbox-eval/1", at: "2026-11-19T10:00:00.000Z", commit: "abc", dirty: false, split: "test", corpus: { version: "v", tasks: 0 }, k: 3, fake: true, models: {}, calls: { made: 0, cached: 0 }, tasks: [] };
    writeFileSync(join(dir, "eval.json"), JSON.stringify(record));
    const script = new URL("../../scripts/scorecard.mjs", import.meta.url).pathname;
    const run = spawnSync(process.execPath, ["--experimental-transform-types", script, "--skip-tests", "--skip-artifact", "--out", join(dir, "card.json"), "--eval", join(dir, "eval.json")], { encoding: "utf8", env: { ...process.env, AGENTBOX_HOME: dir } });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const card = JSON.parse(readFileSync(join(dir, "card.json"), "utf8")) as { model: ModelSection };
    assert.deepEqual(card.model, { status: "skipped", reason: "the evaluation record is from a stand-in, not a model" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A3: the script with an injected failure writes a FAIL card and exits 1; without it, INCOMPLETE and 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-scorecard-"));
  try {
    const script = new URL("../../scripts/scorecard.mjs", import.meta.url).pathname;
    const run = (extra: string[]) =>
      spawnSync(process.execPath, ["--experimental-transform-types", script, "--skip-tests", "--skip-artifact", "--out", join(dir, "card.json"), ...extra], { encoding: "utf8", env: { ...process.env, AGENTBOX_HOME: dir } });
    const failed = run(["--inject-failure"]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const card = JSON.parse(readFileSync(join(dir, "card.json"), "utf8")) as { verdict: { status: string }; format: string };
    assert.equal(card.format, "lumenbox-scorecard/1");
    assert.equal(card.verdict.status, "FAIL");
    const incomplete = run([]);
    assert.equal(incomplete.status, 2, incomplete.stdout + incomplete.stderr);
    assert.match(incomplete.stdout, /INCOMPLETE/);
    assert.match(incomplete.stdout, /SKIPPED/);
    const checked = run(["--checked"]);
    assert.equal(checked.status, 0, "under release:check a missing model section is said, not fatal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
