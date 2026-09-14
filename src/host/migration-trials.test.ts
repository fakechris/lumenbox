/**
 * The 5×3 migration matrix (INV-481), taught and untaught, on the scripted model: skills
 * reach the prompt, a site learning is recalled on a page it was not written on, the
 * artifact carries the input's own parameters, a capability the receiver lacks is refused
 * rather than done, and every cell is on the report with failures by stage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearning } from "./learnings.ts";
import { WORKFLOWS, judgeTrial, trialReport, type TrialOutcome } from "./migration-trials.ts";
import { runEpisode, type EpisodeResult } from "./scenario.ts";

const outcomes: TrialOutcome[] = [];

const fixedBrowser = () => ({
  browser: async (request: { url?: string }) => ({ url: request.url ?? "", title: "vendor.test", snapshot: '- heading "Team plan" [ref=e1]', text: "Team plan: $12" }) as never,
});

for (const workflow of WORKFLOWS) {
  for (const input of workflow.inputs) {
    for (const taught of [true, false]) {
      test(`${workflow.id} / ${input.id} / ${taught ? "taught" : "untaught"}`, async () => {
        const learnings = mkdtempSync(join(tmpdir(), "agentbox-trial-learn-"));
        const previous = process.env.AGENTBOX_LEARNINGS;
        process.env.AGENTBOX_LEARNINGS = learnings;
        if (taught && workflow.learning !== undefined) {
          appendLearning(workflow.learning.host, { at: new Date("2026-09-01T00:00:00Z"), worked: true, text: workflow.learning.line, by: "Ada" }, learnings);
        }
        const systems: string[] = [];
        let result: EpisodeResult | undefined;
        try {
          const script = workflow.script(input, taught);
          result = await runEpisode({
            team: [{ name: "Vera" }],
            says: [input.ask],
            files: input.files ?? {},
            ...(workflow.learning !== undefined ? { box: fixedBrowser(), display: 1 } : {}),
            ...(taught && workflow.skill !== undefined ? { skills: [workflow.skill] } : {}),
            script: ctx => {
              systems.push(ctx.system);
              return script(ctx);
            },
            maxRounds: 30,
          });
          (result as EpisodeResult & { systems?: string[] }).systems = systems;
          const outcome = judgeTrial(workflow, input, taught, result);
          outcomes.push(outcome);
          assert.deepEqual(outcome.failures, [], `${workflow.id}/${input.id}/${taught}: refusals ${result.score.refusals.join(" | ")}; said ${result.score.said.map(s => s.text).join(" | ")}; trail ${result.score.trail.join(" ")}`);
        } finally {
          result?.cleanup();
          if (previous === undefined) delete process.env.AGENTBOX_LEARNINGS;
          else process.env.AGENTBOX_LEARNINGS = previous;
          rmSync(learnings, { recursive: true, force: true });
        }
      });
    }
  }
}

test("the matrix is complete, taught never costs more than untaught, and the report names its unverified halves", () => {
  assert.equal(outcomes.length, 30, "5 workflows × 3 inputs × taught/untaught");
  for (const workflow of WORKFLOWS) {
    for (const input of workflow.inputs) {
      const on = outcomes.find(o => o.workflow === workflow.id && o.input === input.id && o.taught)!;
      const off = outcomes.find(o => o.workflow === workflow.id && o.input === input.id && !o.taught)!;
      assert.ok(on.calls <= off.calls, `${workflow.id}/${input.id}: taught ${on.calls} > untaught ${off.calls}`);
      assert.ok(on.questions <= off.questions);
    }
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // No git: the report says unknown.
  }
  const report = trialReport(outcomes, { commit, config: "scripted model, memory box, no credentials" });
  console.log(report.join("\n"));
  assert.match(report[0]!, /^Migration trials \(INV-481\): 30\/30 cells passed/);
  assert.ok(report.some(line => /failures by stage: none/.test(line)));
  assert.ok(report.some(line => /UNVERIFIED: the same matrix on a real model/.test(line)));
});
