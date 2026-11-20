/** Two versions on the same tasks: what the gate calls red, what it leaves alone, and what the page says of both (INV-1862). */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveProvider } from "../host/provider.ts";
import type { ModelCall } from "./cache.ts";
import { type Build, type CompareRecord, compareSides, runCompare } from "./compare.ts";
import { loadCorpus } from "./corpus.ts";
import { renderComparison } from "./report.ts";
import type { AttemptResult, EvalRun, Tier } from "./runner.ts";
import { SUBJECT_TABLE } from "./subjects.ts";
import { type PromptSurface, promptSurface } from "./surface.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = loadCorpus(join(root, "evals/corpus"));
const profile = resolveProvider("anthropic");
const never: ModelCall = async () => {
  throw new Error("the real model was reached");
};
const tiers: Record<"primary" | "summary", Tier> = { primary: { model: never, profile }, summary: { model: never, profile } };
const at = "2026-11-19T10:00:00.000Z";
const build = (ref: string, surface: PromptSurface, subjects: Build["subjects"] = SUBJECT_TABLE): Build => ({ ref, sha: ref.padEnd(40, "0"), subjects, surface, ownCorpus: "same" });

test("a version whose tool list lost read_file is red on every skill it can no longer open; two versions that differ only by chance are not", async () => {
  const surface = await promptSurface();
  assert.equal((await promptSurface()).digest, surface.digest, "the same configuration reads the same prompt twice, or no two versions could be told apart by it");
  assert.ok(surface.bytes.system > 1000 && surface.tools.some(tool => "name" in tool && tool.name === "read_file"), "what is read is the prompt and tool list a turn really sends");
  assert.notEqual((await promptSurface({ skills: [] })).digest, surface.digest, "an agent offered no skills is sent another prompt");
  // The two halves the size ratchet holds (INV-1857) are the two the turn sent, and a turn nobody waits on is sent another list.
  assert.equal(`${surface.parts.stable}\n\n${surface.parts.volatile}`, surface.system);
  assert.match(surface.parts.stable, /Your name is Nova\./, "the stable half holds who the agent is");
  assert.match(surface.parts.volatile, /# Before you answer/, "the volatile half ends the prompt");
  assert.equal(surface.bytes.stable + surface.bytes.volatile + 2, surface.bytes.system);
  const offered = (one: PromptSurface) => one.tools.map(tool => ("name" in tool ? tool.name : ""));
  const unattended = await promptSurface({ unattended: true });
  assert.ok(offered(unattended).includes("NothingToSay") && !offered(surface).includes("NothingToSay"), "silence is offered only where nobody is waiting");
  assert.match(unattended.parts.volatile, /# Before you answer/);

  // The candidate is the same product with one tool gone from what the model is sent.
  const episode = SUBJECT_TABLE.episode;
  const withoutReadFile: Build["subjects"] = {
    ...SUBJECT_TABLE,
    episode: { ...episode, run: (task, context) => episode.run(task, { ...context, model: (params, wire) => context.model({ ...params, tools: (params.tools ?? []).filter(tool => !("name" in tool) || tool.name !== "read_file") }, wire) }) },
  };
  const episodes = { dev: corpus.dev.filter(task => task.subject === "episode"), test: corpus.test.filter(task => task.subject === "episode") };
  const broken = await runCompare({ base: build("base", surface), candidate: build("cand", { ...surface, digest: "ffffffff0000" }, withoutReadFile), tasks: episodes, k: 2, tiers, fake: { wrongShare: 0 }, at });
  const verdict = compareSides(broken);
  const mustOpen = [...episodes.dev, ...episodes.test].filter(task => task.failureType === "skill-not-opened").map(task => task.id).sort();
  assert.ok(mustOpen.length > 10);
  assert.deepEqual(verdict.worse.map(task => task.id).sort(), mustOpen, "exactly the tasks that need the tool, and no other");
  assert.ok(verdict.worse.every(task => task.outright && task.base === "2/2" && task.candidate === "0/2" && /missing skill:/.test(task.finding)));
  assert.equal(verdict.better.length, 0);
  assert.equal(verdict.gate.status, "RED");
  assert.equal(verdict.gate.reasons.length, 2, "both the fall beyond its interval and the outright breaks are said");
  assert.ok(verdict.difference!.high < 0 && verdict.paired.verdict === "REVIEW");
  const page = renderComparison(broken, verdict, { name: "COMPARE-2026-11-19-base-cand" });
  assert.match(page, /measured: no /, "a stand-in's comparison says so where docs-lint reads it");
  assert.match(page, /\*\*Gate: RED\*\* — the pass rate fell by/);
  assert.match(page, /The gate reads code graders only: no judge was asked/);
  assert.ok(mustOpen.every(id => page.includes(`| ${id} **(outright)** |`)), "every task that broke is named on the page");

  // Same product under two prompt digests: the stand-in draws afresh for each, as a model would, one attempt in ten wrong.
  // Both digests are fixed here, so the draw does not move when the real prompt is edited.
  const noise = await runCompare({ base: build("base", { ...surface, digest: "ba5e00000000" }), candidate: build("cand", { ...surface, digest: "0123456789ab" }), tasks: corpus, k: 3, tiers, fake: { wrongShare: 0.1 }, at });
  const quiet = compareSides(noise);
  assert.ok(quiet.worse.length >= 5 && quiet.better.length >= 5, `chance alone moves tasks both ways: ${quiet.worse.length} worse, ${quiet.better.length} better`);
  assert.ok(quiet.difference!.low < 0 && quiet.difference!.high > 0, "and the interval of the difference holds zero");
  assert.equal(quiet.gate.status, "NOT_RED", "so nothing is red, however many tasks moved");
  assert.equal(compareSides(noise, { maxWorse: 0 }).gate.status, "RED", "a count of every task that moved is red on that same noise, which is why it is off unless asked for");
  assert.deepEqual(quiet.bySplit.map(row => [row.split, row.tasks]), [["dev", corpus.dev.length], ["test", corpus.test.length]]);
});

/** A record with the given passes out of three per task on each side; "!" is a harness failure. */
function recorded(base: readonly (number | "!")[], candidate: readonly (number | "!")[]): CompareRecord {
  const run = (scores: readonly (number | "!")[]): EvalRun => ({
    format: "lumenbox-eval/1", at, commit: "abc1234", dirty: false, split: "test", corpus: { version: "v", tasks: scores.length }, k: 3, fake: false,
    models: { primary: { provider: "p", model: "m" } }, calls: { made: scores.length * 3, cached: 0 },
    tasks: scores.map((score, index) => ({
      id: `t${index}`, version: "1", subject: "episode", source: { kind: "skill-eval", ref: "x" }, failureType: "f",
      attempts: [1, 2, 3].map((attempt): AttemptResult => ({
        attempt, pass: score !== "!" && attempt <= score, ...(score === "!" ? { infra: "529 overloaded" } : {}),
        graders: score === "!" ? [] : [{ name: "labels", pass: attempt <= score }], labels: [], state: {}, output: "", model: "m",
        use: { calls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    })),
  });
  const side = (ref: string, scores: readonly (number | "!")[]) => ({ ref, sha: ref.padEnd(40, "0"), surface: { digest: ref, systemBytes: 1, toolsBytes: 1, tools: 1 }, ownCorpus: "same" as const, run: run(scores) });
  return { format: "lumenbox-eval-compare/1", at, k: 3, fake: false, splits: Object.fromEntries(base.map((_, index) => [`t${index}`, "test" as const])), base: side("base", base), candidate: side("cand", candidate) };
}

test("one task broken outright is red even when the pass rate rose; a task that only slipped is not; a harness failure is neither", () => {
  // Three tasks fixed, one that always passed now never does: the mean is up and a person must still look.
  const mixed = compareSides(recorded([3, 0, 0, 0, 3, 3], [0, 3, 3, 3, 3, 3]), { rates: { m: { inputPerM: 1, outputPerM: 10 } } });
  assert.ok(mixed.difference!.estimate > 0 && mixed.difference!.high > 0);
  assert.equal(mixed.gate.status, "RED");
  assert.match(mixed.gate.reasons.join(), /^1 task that passed every attempt on the base passed none on the candidate \(0 allowed\)$/);
  assert.equal(compareSides(recorded([3, 0, 0, 0, 3, 3], [0, 3, 3, 3, 3, 3]), { maxBroken: 1 }).gate.status, "NOT_RED", "the allowance is a setting");
  // 3 input-thousands and 300 output tokens a task, six tasks, nine passes before and fifteen after.
  assert.ok(Math.abs(mixed.cost.tokensPerPass! - (19800 / 15 - 19800 / 9)) < 1e-9, "what a pass costs fell, because the same spend bought more of them");
  assert.ok(mixed.cost.usdPerPass! < 0);

  const slipped = compareSides(recorded([3, 3, 3, 3, 3, 3], [2, 3, 3, 3, 3, 3]));
  assert.deepEqual(slipped.worse.map(task => [task.id, task.candidate, task.outright]), [["t0", "2/3", false]]);
  assert.equal(slipped.gate.status, "NOT_RED", "one failed attempt in eighteen is listed, not red");
  assert.equal(slipped.paired.verdict, "INCOMPLETE", "and the sample is said to be too small to settle it");

  const outage = compareSides(recorded([3, 3, 3], [3, "!", 3]));
  assert.deepEqual(outage.unpaired, ["t1"]);
  assert.equal(outage.worse.length, 0, "the model was not asked, so the task did not get worse");
  assert.equal(outage.gate.status, "NOT_RED");
  assert.match(renderComparison(recorded([3, 3, 3], [3, "!", 3]), outage, { name: "x" }), /\*\*1 task\(s\) were not paired\*\* because the harness failed on a side \(t1\)/);
  const dark = compareSides(recorded([3, 3], ["!", "!"]));
  assert.equal(dark.gate.status, "NOT_READ", "a side that never ran is not a regression and not a pass");
});
