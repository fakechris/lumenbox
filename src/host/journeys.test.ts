/**
 * The nine delivery journeys (INV-480) on the scripted model and the memory box: every
 * check named, the report printed so a reader can keep it, and the two things this
 * cannot verify said as such.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { JOURNEYS, journeyReport, judgeJourney, type JourneyOutcome } from "./journeys.ts";
import { runEpisode } from "./scenario.ts";

const outcomes: JourneyOutcome[] = [];

for (const journey of JOURNEYS) {
  test(`journey ${journey.id}: ${journey.ask.slice(0, 70)}`, async () => {
    const result = await runEpisode({ ...journey.episode, maxRounds: 40 });
    try {
      const outcome = judgeJourney(journey, result);
      outcomes.push(outcome);
      const failed = Object.entries(outcome.checks).filter(([, ok]) => !ok).map(([label]) => label);
      assert.deepEqual(failed, [], `${journey.id}: ${failed.join("; ")}\nrefusals: ${result.score.refusals.join(" | ")}\nsaid: ${result.score.said.map(s => s.text).join(" | ")}\ntrail: ${result.score.trail.join(" ")}`);
      if (journey.variant === "refused") assert.ok(outcome.refusals >= 1, "a refused variant leaves a refusal on record");
      assert.equal(outcome.questions, 0, "none of these asks needs a question");
    } finally {
      result.cleanup();
    }
  });
}

test("the journey report: nine variants, three per class, and the unverified parts named", () => {
  assert.equal(JOURNEYS.length, 9);
  for (const kind of ["report", "collect", "routine-check"] as const) {
    assert.deepEqual(JOURNEYS.filter(j => j.kind === kind).map(j => j.variant), ["normal", "refused", "interrupted"]);
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // No git here is fine; the report says unknown.
  }
  const report = journeyReport(outcomes, { commit, config: "scripted model, memory box, no credentials", node: process.version });
  console.log(report.join("\n"));
  assert.match(report[0]!, /^Journeys \(INV-480\): 9\/9 passed/);
  assert.ok(report.some(line => /UNVERIFIED: a real model's conduct/.test(line)));
});
