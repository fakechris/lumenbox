/** The runner end to end on a stand-in, the cache, and what a summary and its page may claim (INV-1772). */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveProvider } from "../host/provider.ts";
import { type CacheStore, FileCache, type ModelCall } from "./cache.ts";
import { type EvalTask, loadCorpus } from "./corpus.ts";
import { renderReport, renderTrend } from "./report.ts";
import { callBudget, type EvalRun, runEval, type Tier } from "./runner.ts";
import { SUBJECT_TABLE } from "./subjects.ts";
import { summarise } from "./summary.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = loadCorpus(join(root, "evals/corpus"));
const everything = [...corpus.dev, ...corpus.test];
/** One task of each subject, and both kinds of skill case: enough to cross every path once. */
const sample: EvalTask[] = [
  everything.find(task => task.failureType === "skill-not-opened")!,
  everything.find(task => task.failureType === "skill-opened-wrongly")!,
  everything.find(task => task.subject === "auto-review")!,
  everything.find(task => task.subject === "steward")!,
  everything.find(task => task.subject === "teach")!,
];
const profile = resolveProvider("anthropic");
const never: ModelCall = async () => {
  throw new Error("the real model was reached");
};
const tiers = (model: ModelCall = never): Record<"primary" | "summary", Tier> => ({ primary: { model, profile }, summary: { model, profile: { ...profile, model: "cheap-model" } } });
const meta = { at: "2026-11-19T10:00:00.000Z", commit: "abc1234", dirty: false };
const text = (body: string, usage = { input_tokens: 2000, output_tokens: 500 }): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: body }], stop_reason: "end_turn", stop_sequence: null, usage }) as unknown as Anthropic.Message;

test("a stand-in run crosses every subject, grades gold answers as passes and wrong ones as failures, and a second run makes no call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1772-cache-"));
  try {
    const cache = new FileCache(dir);
    const right = await runEval({ tasks: sample, split: "test", k: 2, subjects: SUBJECT_TABLE, tiers: tiers(), fake: { wrongShare: 0 }, cache, meta });
    assert.deepEqual(right.tasks.map(task => task.attempts.map(attempt => attempt.pass)), sample.map(() => [true, true]), JSON.stringify(right.tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.graders.filter(g => !g.pass)))));
    assert.equal(right.fake, true);
    assert.ok(right.calls.made >= sample.length * 2 && right.calls.cached === 0);

    const again = await runEval({ tasks: sample, split: "test", k: 2, subjects: SUBJECT_TABLE, tiers: tiers(), fake: { wrongShare: 0 }, cache, meta });
    assert.deepEqual(again.calls, { made: 0, cached: right.calls.made }, "the same prompts, tasks and recipe are answered from the cache");
    assert.deepEqual(again.tasks, right.tasks, "and give the same record, usage included");

    const wrong = await runEval({ tasks: sample, split: "test", k: 2, subjects: SUBJECT_TABLE, tiers: tiers(), fake: { wrongShare: 1 }, cache, meta });
    assert.ok(wrong.tasks.every(task => task.attempts.every(attempt => !attempt.pass && attempt.infra === undefined)), "a wrong answer is a failure the graders found, not a harness fault");
    assert.match(wrong.tasks[0]!.attempts[0]!.graders[0]!.detail!, /missing skill:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each attempt is its own sample in the cache, an edited task is asked again, and offline a miss is a harness result — never a call, never a pass", async () => {
  const entries = new Map<string, Anthropic.Message>();
  const cache: CacheStore = { get: key => entries.get(key), set: (key, message) => void entries.set(key, message) };
  const steward = sample.find(task => task.subject === "steward")!;
  const gold = steward.gold.labels!.all![0]!;
  let asked = 0;
  const model: ModelCall = async () => {
    asked += 1;
    return text(JSON.stringify({ action: gold }));
  };
  const first = await runEval({ tasks: [steward], split: "test", k: 3, subjects: SUBJECT_TABLE, tiers: tiers(model), cache, meta });
  assert.equal(asked, 3, "three attempts at one prompt are three calls, not one call read three times");
  assert.deepEqual(first.models, { summary: { provider: profile.label, model: "cheap-model" } }, "the model that answered is on the record, by tier");

  const edited = { ...steward, input: { ...steward.input, view: `${String(steward.input.view)}\nthem: one more thing` } };
  const offline = await runEval({ tasks: [steward, edited], split: "test", k: 3, subjects: SUBJECT_TABLE, tiers: tiers(model), cache, offline: true, meta });
  assert.equal(asked, 3, "offline never reaches the model");
  assert.deepEqual(offline.tasks[0]!.attempts.map(attempt => attempt.pass), [true, true, true]);
  assert.ok(offline.tasks[1]!.attempts.every(attempt => !attempt.pass && /not in the cache/.test(attempt.infra ?? "")));
  const summary = summarise(offline);
  assert.equal(summary.attempts, 6, "the harness failures stay in the denominator");
  assert.equal(summary.infra, 3);
  assert.equal(summary.passRate!.estimate, 0.5);
});

test("a model that fails is a harness result; an episode winds down on it instead of retrying, and one that never answers has tested nothing", async () => {
  const failing: ModelCall = async () => {
    throw new Error("529 overloaded");
  };
  const noTrigger = sample.find(task => task.failureType === "skill-opened-wrongly")!;
  const run = await runEval({ tasks: [noTrigger, sample.find(task => task.subject === "auto-review")!], split: "test", k: 1, subjects: SUBJECT_TABLE, tiers: tiers(failing), meta });
  assert.match(run.tasks[0]!.attempts[0]!.infra!, /529 overloaded/, "a no-trigger case must not pass because the model was silent");
  assert.match(run.tasks[1]!.attempts[0]!.infra!, /529 overloaded/);
  assert.equal(summarise(run).passed, 0);
});

test("the summary prices what the calls reported, per passed attempt, and gives no total when a model has no rate", async () => {
  const autoReview = sample.find(task => task.subject === "auto-review")!;
  const gold = autoReview.gold.labels!.all![0]!;
  let call = 0;
  // Two right verdicts and one the parser cannot read.
  const model: ModelCall = async () => {
    call += 1;
    return text(call === 2 ? "I cannot decide." : JSON.stringify({ verdict: gold, reason: "said so" }));
  };
  const run = await runEval({ tasks: [autoReview], split: "test", k: 3, subjects: SUBJECT_TABLE, tiers: tiers(model), meta });
  assert.deepEqual(run.tasks[0]!.attempts.map(attempt => attempt.labels[0]), [gold, "NONE", gold]);
  const priced = summarise(run, { rates: { "cheap-model": { inputPerM: 1, outputPerM: 4 } } });
  assert.deepEqual(priced.cost.use, { calls: 3, inputTokens: 6000, outputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(priced.cost.usd! - 0.012) < 1e-12, "3 × (2000 in at $1/M + 500 out at $4/M)");
  assert.ok(Math.abs(priced.cost.usdPerPass! - 0.006) < 1e-12, "the failed attempt is on the bill of the two that passed");
  assert.equal(priced.passAtK, 1);
  assert.equal(priced.passHatK, 0, "passed twice of three: usable once, not reliable");
  const unpriced = summarise(run);
  assert.equal(unpriced.cost.usd, undefined);
  assert.deepEqual(unpriced.cost.unpriced, ["cheap-model"]);
  assert.equal(unpriced.cost.tokensPerPass, 3750);
});

const recorded = (passes: readonly boolean[], more: Partial<EvalRun> = {}): EvalRun => ({
  format: "lumenbox-eval/1", ...meta, split: "test", corpus: { version: "v", tasks: passes.length }, k: 1, fake: false,
  models: { primary: { provider: "p", model: "m" } }, calls: { made: passes.length, cached: 0 },
  tasks: passes.map((pass, index) => ({
    id: `t${index}`, version: "1", subject: "steward" as const, source: { kind: "steward-tail" as const, ref: "x" }, failureType: "f",
    attempts: [{ attempt: 1, pass, graders: [{ name: "labels", pass }], labels: [], state: {}, output: "", model: "m", use: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  })),
  ...more,
});
const passes = (count: number, total: number) => Array.from({ length: total }, (_, index) => index < count);

test("two runs are compared task by task only when the same models answered the same way; an edited task is not paired", () => {
  const baseline = recorded(passes(30, 30));
  const worse = summarise(recorded(passes(20, 30)), { baseline }).comparison!;
  assert.ok(worse.comparable && worse.verdict === "REVIEW" && worse.worse === 10 && worse.paired === 30);
  const small = summarise(recorded(passes(2, 3)), { baseline: recorded(passes(3, 3)) }).comparison!;
  assert.ok(small.comparable && small.verdict === "INCOMPLETE", "one task of three is not a regression (INV-821)");

  const refused = (now: Partial<EvalRun>, was: Partial<EvalRun> = {}) => {
    const comparison = summarise(recorded(passes(3, 3), now), { baseline: recorded(passes(3, 3), was) }).comparison!;
    assert.equal(comparison.comparable, false);
    return comparison.comparable ? "" : comparison.why;
  };
  assert.match(refused({ models: { primary: { provider: "p", model: "other" } } }), /primary model differs/);
  assert.match(refused({ k: 3 }), /ran each task 1 times, this ran 3/);
  assert.match(refused({ split: "dev" }), /baseline is the test split/);
  assert.match(refused({}, { fake: true }), /stand-in/);

  const edited = recorded(passes(0, 30));
  edited.tasks.forEach((task, index) => { if (index >= 5) task.version = "2"; });
  const partial = summarise(edited, { baseline }).comparison!;
  assert.ok(partial.comparable && partial.paired === 5 && partial.dropped === 25, "a task whose content changed is a different question");
});

test("the page says in its first lines whether anything was measured, carries the four numbers, and never calls a judge calibrated", async () => {
  const fake = await runEval({ tasks: sample.slice(2, 4), split: "test", k: 1, subjects: SUBJECT_TABLE, tiers: tiers(), fake: { wrongShare: 0 }, meta });
  const fakePage = renderReport(fake, summarise(fake), { name: "REPORT-2026-11-19" });
  assert.ok(fakePage.startsWith("<!-- eval-report: REPORT-2026-11-19\n     measured: no"), "the stand-in is named before anything else on the page");
  assert.match(fakePage.split("\n").find(line => line.startsWith("# "))!, /NOT A MEASUREMENT/);
  assert.doesNotMatch(fakePage, /\$\d/, "a stand-in has no price");

  const baseline = recorded(passes(30, 30));
  const real = recorded(passes(20, 30));
  const page = renderReport(real, summarise(real, { baseline, rates: { m: { inputPerM: 1, outputPerM: 1 } } }), { name: "REPORT-2026-11-19" });
  assert.ok(page.startsWith("<!-- eval-report: REPORT-2026-11-19\n     measured: yes\n     split: test\n     corpus: v\n     commit: abc1234\n     models: primary: p m\n-->"));
  for (const wanted of [/Pass rate \| \*\*66\.7%\*\* \| 95% interval \d+\.\d% – \d+\.\d%/, /pass\^1[^|]*\| \*\*66\.7%\*\*/, /\*\*REVIEW\*\* — 10 worse \(33\.3%\), 0 better/, /Smallest detectable difference \| \*\*\d+\.\d%\*\*/, /per passed attempt/]) {
    assert.match(page, wanted);
  }
  assert.match(page, /Judge not calibrated — may not gate/, "no judge has been checked against a person's labels, and the page must say so until one has");
  assert.match(renderTrend([{ run: fake, summary: summarise(fake) }])[0]!, /STAND-IN, not a measurement/);
});

test("the call budget is tasks × attempts × the most calls an attempt can make", () => {
  const budget = callBudget(sample, SUBJECT_TABLE, 3);
  // Two skill cases capped at 4 calls, and three one-call subjects.
  assert.equal(budget.total, 2 * 4 * 3 + 3 * 1 * 3);
  assert.deepEqual(budget.bySubject.episode, { tasks: 2, calls: 24 });
});
