/**
 * From a run's record to the numbers a person reads (INV-1772, INV-821).
 *
 * Everything here is recomputed from the record, never stored beside it: a result file read again
 * next month against a different baseline gives that month's comparison, and a change to how a
 * number is computed changes every report at once.
 *
 * What a comparison is allowed to mean is decided here too. Two runs are compared only when the
 * same models answered, with the same number of attempts, on the same side of the corpus, and
 * neither was a stand-in; and only over tasks that are the same task in both — an edited task is
 * a different question.
 */

import { priceOf, type Rates } from "../host/spend.ts";
import type { ModelSection } from "../host/scorecard.ts";
import { type Calibration, calibrate, type HumanLabel, MIN_LABELS } from "./calibration.ts";
import type { EvalRun, TaskResult, TokenUse } from "./runner.ts";
import { bootstrapInterval, failureUpperBound, type Interval, minimumDetectableDifference, type PairedComparison, pairedComparison, passAtAndHatK } from "./stats.ts";

export interface GroupRow {
  key: string;
  tasks: number;
  attempts: number;
  passed: number;
  /** Tasks whose every attempt passed. */
  reliable: number;
}

export interface Summary {
  tasks: number;
  attempts: number;
  passed: number;
  /** Attempts where the harness failed; in the denominator, never passes. */
  infra: number;
  /** Mean of the tasks' pass rates, with a 95% interval from resampling tasks. */
  passRate?: Interval;
  /** A task passes at least once in k; a task passes every time in k. */
  passAtK?: number;
  passHatK?: number;
  /** The most the share of unreliable tasks could be, at 95%. */
  unreliableUpperBound?: number;
  /** The smallest change in pass rate a comparison of two runs this size would catch. */
  detectableDifference?: number;
  cost: {
    use: TokenUse;
    /** Undefined when a model that ran has no configured rate: a partial sum would read as the price. */
    usd?: number;
    unpriced: string[];
    /** Per attempt that passed: what one working result costs, failures included in the bill. */
    tokensPerPass?: number;
    usdPerPass?: number;
  };
  byFailureType: GroupRow[];
  bySubject: GroupRow[];
  /** Present when judges were asked. `calibration` is absent for a stand-in: there is nothing a person's label could be held against. */
  judges?: {
    model: { provider: string; model: string };
    promptVersion: string;
    skipped: number;
    use: TokenUse;
    rows: { question: string; asked: number; present: number; invalid: number }[];
    calibration?: Calibration;
  };
  comparison?: { comparable: false; why: string } | ({ comparable: true; baselineCommit: string; baselineAt: string; dropped: number } & PairedComparison);
}

const reliable = (task: TaskResult): boolean => task.attempts.length > 0 && task.attempts.every(attempt => attempt.pass);

function groupBy(tasks: readonly TaskResult[], keyOf: (task: TaskResult) => string): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  for (const task of tasks) {
    const key = keyOf(task);
    const row = rows.get(key) ?? { key, tasks: 0, attempts: 0, passed: 0, reliable: 0 };
    row.tasks += 1;
    row.attempts += task.attempts.length;
    row.passed += task.attempts.filter(attempt => attempt.pass).length;
    if (reliable(task)) row.reliable += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Why two runs may not be compared, or undefined. */
export function incomparable(now: EvalRun, baseline: EvalRun): string | undefined {
  if (now.fake || baseline.fake) return "one side was answered by a stand-in, not a model";
  if (now.split !== baseline.split) return `the baseline is the ${baseline.split} split, this is ${now.split}`;
  if (now.k !== baseline.k) return `the baseline ran each task ${baseline.k} times, this ran ${now.k}`;
  for (const tier of ["primary", "summary"] as const) {
    const a = now.models[tier];
    const b = baseline.models[tier];
    if (a === undefined || b === undefined) continue;
    if (a.provider !== b.provider || a.model !== b.model) return `the ${tier} model differs: ${b.provider} ${b.model} then, ${a.provider} ${a.model} now`;
  }
  return undefined;
}

export function summarise(run: EvalRun, options: { baseline?: EvalRun; rates?: Rates; labels?: readonly HumanLabel[] } = {}): Summary {
  const attempts = run.tasks.flatMap(task => task.attempts);
  const passed = attempts.filter(attempt => attempt.pass).length;
  const rates = run.tasks.filter(task => task.attempts.length > 0).map(task => task.attempts.filter(attempt => attempt.pass).length / task.attempts.length);
  const passRate = bootstrapInterval(rates);
  const hat = passAtAndHatK(run.tasks.map(task => ({ passes: task.attempts.filter(attempt => attempt.pass).length, attempts: task.attempts.length })));

  const use: TokenUse = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let usd: number | undefined = 0;
  const unpriced = new Set<string>();
  for (const attempt of attempts) {
    for (const key of Object.keys(use) as (keyof TokenUse)[]) use[key] += attempt.use[key];
    if (attempt.use.calls === 0) continue;
    const price = run.fake ? undefined : priceOf({ model: attempt.model, ...attempt.use }, options.rates ?? {});
    if (price === undefined) unpriced.add(attempt.model);
    else if (usd !== undefined) usd += price;
  }
  if (unpriced.size > 0) usd = undefined;
  const tokens = use.inputTokens + use.outputTokens + use.cacheReadTokens + use.cacheWriteTokens;

  let comparison: Summary["comparison"];
  if (options.baseline !== undefined) {
    const why = incomparable(run, options.baseline);
    if (why !== undefined) comparison = { comparable: false, why };
    else {
      const before = new Map(options.baseline.tasks.map(task => [`${task.id}@${task.version}`, reliable(task)]));
      const after = new Map(run.tasks.map(task => [`${task.id}@${task.version}`, reliable(task)]));
      const paired = pairedComparison(after, before);
      comparison = { comparable: true, baselineCommit: options.baseline.commit, baselineAt: options.baseline.at, dropped: run.tasks.length - paired.paired, ...paired };
    }
  }

  let judges: Summary["judges"];
  if (run.judges !== undefined) {
    const section = run.judges;
    const standIn = run.fake || section.model.provider === "fake";
    judges = {
      model: section.model, promptVersion: section.promptVersion, skipped: section.skipped, use: section.use,
      rows: [...new Set(section.verdicts.map(verdict => verdict.question))].sort().map(question => {
        const mine = section.verdicts.filter(verdict => verdict.question === question);
        return { question, asked: mine.length, present: mine.filter(v => v.verdict === "present").length, invalid: mine.filter(v => v.verdict === "invalid").length };
      }),
      ...(standIn ? {} : { calibration: calibrate(section, options.labels ?? []) }),
    };
  }

  return {
    tasks: run.tasks.length,
    attempts: attempts.length,
    passed,
    infra: attempts.filter(attempt => attempt.infra !== undefined).length,
    ...(passRate !== undefined ? { passRate } : {}),
    ...(hat !== undefined ? { passAtK: hat.passAtK, passHatK: hat.passHatK, unreliableUpperBound: failureUpperBound(Math.round((1 - hat.passHatK) * hat.tasks), hat.tasks)! } : {}),
    ...(passRate !== undefined ? { detectableDifference: minimumDetectableDifference(rates.length, passRate.estimate)! } : {}),
    cost: {
      use,
      ...(usd !== undefined && !run.fake ? { usd } : {}),
      unpriced: [...unpriced].sort(),
      ...(passed > 0 ? { tokensPerPass: tokens / passed } : {}),
      ...(passed > 0 && usd !== undefined && !run.fake ? { usdPerPass: usd / passed } : {}),
    },
    byFailureType: groupBy(run.tasks, task => task.failureType),
    bySubject: groupBy(run.tasks, task => task.subject),
    ...(comparison !== undefined ? { comparison } : {}),
    ...(judges !== undefined ? { judges } : {}),
  };
}

/**
 * The release scorecard's `model` entry from a record (scorecard.ts): the four numbers and what
 * limits them. A stand-in's record, or one of the dev split, fills nothing — the entry stays
 * SKIPPED and says why, because a card that showed those numbers would be read as a measurement.
 */
export function scorecardModelSection(run: EvalRun, summary: Summary, record: string): ModelSection {
  if (run.fake) return { status: "skipped", reason: "the evaluation record is from a stand-in, not a model" };
  if (run.split !== "test") return { status: "skipped", reason: `the evaluation record is the ${run.split} split; a release is read from test` };
  if (summary.passRate === undefined || summary.passHatK === undefined || summary.passAtK === undefined || summary.detectableDifference === undefined) {
    return { status: "skipped", reason: "the evaluation record holds no attempt" };
  }
  const comparison = summary.comparison;
  const calibration = summary.judges?.calibration;
  const gated = calibration?.questions.filter(one => one.kappa !== undefined) ?? [];
  const models = Object.values(run.models);
  return {
    status: "ran",
    provider: [...new Set(models.map(model => model.provider))].join(" + "),
    model: [...new Set(models.map(model => model.model))].join(" + "),
    fixtureVersion: run.corpus.version,
    runs: run.k,
    eval: {
      record, split: run.split, tasks: summary.tasks, k: run.k,
      passRate: summary.passRate, passHatK: summary.passHatK, passAtK: summary.passAtK, detectableDifference: summary.detectableDifference,
      comparison: comparison === undefined
        ? { verdict: "NO_BASELINE", why: "there is no earlier record to compare with" }
        : !comparison.comparable
          ? { verdict: "NOT_COMPARABLE", why: comparison.why }
          : { verdict: comparison.verdict, why: comparison.why, paired: comparison.paired, worse: comparison.worse, better: comparison.better },
      judges: calibration?.calibrated === true
        ? {
            calibrated: true,
            note: `${calibration.matched} labels; may gate: ${calibration.questions.filter(one => one.mayGate).map(one => one.question).join(", ") || "none"}`,
            kappa: Object.fromEntries(gated.map(one => [one.question, one.kappa!])),
            mayGate: calibration.questions.filter(one => one.mayGate).map(one => one.question),
          }
        : { calibrated: false, note: summary.judges === undefined ? "no judge was asked" : `${calibration?.matched ?? 0} of ${MIN_LABELS} labels` },
      ...(summary.cost.tokensPerPass !== undefined
        ? { cost: { tokensPerPass: summary.cost.tokensPerPass, ...(summary.cost.usdPerPass !== undefined ? { usdPerPass: summary.cost.usdPerPass } : {}) } }
        : {}),
    },
  };
}
