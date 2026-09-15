/**
 * The release scorecard's verdicts (INV-130): hard gates fail, a missing model section is
 * INCOMPLETE and never PASS, a regression against a comparable baseline is REVIEW until a
 * named person accepts it, a baseline from another model is refused, and the injected
 * failure closes the gate — through the script, not only the function.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScorecard, compareModelSections, describeScorecard, exitCodeFor, passRates, type ModelSection, type ScorecardInput } from "./scorecard.ts";

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
