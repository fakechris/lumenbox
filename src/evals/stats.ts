/**
 * The arithmetic behind an evaluation report (INV-1772, INV-821). Pure: numbers in, numbers out.
 *
 * Four numbers are read together or not at all: a pass rate with its interval, pass^k beside
 * pass@k, a paired comparison with the previous run, and the smallest difference this sample
 * could have shown. A rate without an interval invites reading noise as a change; a comparison
 * without the detectable difference invites reading "no change" as "no regression".
 *
 * The unit is the task, not the attempt. Three attempts at one task are three looks at the same
 * question, so every interval here resamples or counts tasks, and attempts only shape a task's
 * own rate.
 */

/** A small seeded generator, so a report recomputed from the same results prints the same interval. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * The mean of per-task values with a percentile bootstrap interval, resampling tasks.
 * `values` is one number per task (its pass rate over its attempts). Empty input has no estimate.
 */
export function bootstrapInterval(values: readonly number[], options: { resamples?: number; seed?: number; level?: number } = {}): Interval | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const random = seededRandom(options.seed ?? 1772);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const means = new Array<number>(resamples);
  for (let round = 0; round < resamples; round += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) sum += values[Math.floor(random() * n)]!;
    means[round] = sum / n;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const at = (q: number) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))]!;
  return { estimate: mean, low: at(tail), high: at(1 - tail) };
}

export interface TaskTally {
  passes: number;
  attempts: number;
}

/**
 * pass@k — at least one of a task's attempts passed; pass^k — every one did. The gap between the
 * two is the unreliability a single run hides. Tasks with no attempts are not counted.
 */
export function passAtAndHatK(tasks: readonly TaskTally[]): { tasks: number; passAtK: number; passHatK: number } | undefined {
  const run = tasks.filter(task => task.attempts > 0);
  if (run.length === 0) return undefined;
  return {
    tasks: run.length,
    passAtK: run.filter(task => task.passes > 0).length / run.length,
    passHatK: run.filter(task => task.passes === task.attempts).length / run.length,
  };
}

/** The inverse of the standard normal distribution (Acklam's rational approximation, error under 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile needs a probability strictly between 0 and 1, not ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** The Wilson score interval for a proportion: sane at 0 and 1, where the textbook interval collapses. */
export function wilsonInterval(successes: number, n: number, level = 0.95): Interval | undefined {
  if (n <= 0) return undefined;
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { estimate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * The most the failure rate could be, at 95%, given `failures` in `n`. Zero failures is not zero
 * risk: the exact bound is 1 − 0.05^(1/n), about 3/n — thirty clean tasks still allow one in ten.
 */
export function failureUpperBound(failures: number, n: number): number | undefined {
  if (n <= 0) return undefined;
  if (failures === 0) return 1 - 0.05 ** (1 / n);
  return wilsonInterval(failures, n)!.high;
}

/**
 * McNemar's test on the tasks whose outcome changed: `worse` passed before and fail now, `better`
 * the reverse. Tasks that did not move say nothing about a difference and are not in it. The
 * p-value is the exact two-sided binomial one, right at the small counts an eval has; the
 * statistic is the continuity-corrected chi-square, for readers who expect it.
 */
export function mcnemar(worse: number, better: number): { discordant: number; statistic: number; p: number } {
  const discordant = worse + better;
  if (discordant === 0) return { discordant, statistic: 0, p: 1 };
  const smaller = Math.min(worse, better);
  // P(X ≤ smaller) for X ~ Binomial(discordant, ½), term by term so large counts do not overflow.
  let term = 0.5 ** discordant;
  let tail = 0;
  for (let i = 0; i <= smaller; i += 1) {
    tail += term;
    term = (term * (discordant - i)) / (i + 1);
  }
  const p = Math.min(1, 2 * tail);
  const statistic = (Math.abs(worse - better) - 1) ** 2 / discordant;
  return { discordant, statistic, p };
}

/**
 * The smallest true difference in pass rate a comparison of two runs of `n` tasks would catch
 * (two-sided, 5% false alarms, 80% of the time by default), around a rate of `p`. Computed as for
 * two independent samples, which overstates it for a paired design — the honest direction: a
 * gate set from this number is never tighter than the data supports.
 */
export function minimumDetectableDifference(n: number, p: number, options: { alpha?: number; power?: number } = {}): number | undefined {
  if (n <= 0) return undefined;
  const z = normalQuantile(1 - (options.alpha ?? 0.05) / 2) + normalQuantile(options.power ?? 0.8);
  // At 0 or 1 the variance estimate is zero and the answer would be "any difference": half a task
  // either way keeps the figure finite and conservative.
  const rate = Math.min(1 - 0.5 / n, Math.max(0.5 / n, p));
  return Math.min(1, z * Math.sqrt((2 * rate * (1 - rate)) / n));
}

/** How many tasks a comparison needs before a true difference of `delta` around `p` would be caught. */
export function tasksNeededFor(delta: number, p: number, options: { alpha?: number; power?: number } = {}): number | undefined {
  if (!(delta > 0)) return undefined;
  const z = normalQuantile(1 - (options.alpha ?? 0.05) / 2) + normalQuantile(options.power ?? 0.8);
  const rate = Math.min(0.99, Math.max(0.01, p));
  return Math.ceil((2 * rate * (1 - rate) * z * z) / (delta * delta));
}

/**
 * Cohen's kappa between two raters over the same items: agreement beyond what their base rates
 * alone would produce. Undefined when either rater gave one answer throughout — chance agreement
 * is then total, and a kappa there would be a division by zero dressed as a score.
 */
export function cohenKappa(pairs: readonly (readonly [boolean, boolean])[]): { n: number; agreement: number; kappa: number | undefined } | undefined {
  const n = pairs.length;
  if (n === 0) return undefined;
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const yesA = pairs.filter(([a]) => a).length / n;
  const yesB = pairs.filter(([, b]) => b).length / n;
  const chance = yesA * yesB + (1 - yesA) * (1 - yesB);
  return { n, agreement: agree, kappa: chance >= 1 ? undefined : (agree - chance) / (1 - chance) };
}

export type ComparisonVerdict = "REVIEW" | "IMPROVED" | "NO_CHANGE_DETECTED" | "INCOMPLETE";

export interface PairedComparison {
  /** Tasks present in both runs. */
  paired: number;
  worse: number;
  better: number;
  /** `worse` over the paired tasks: the share of what worked before that a reader would now find broken. */
  worseShare: number;
  betterShare: number;
  p: number;
  statistic: number;
  verdict: ComparisonVerdict;
  why: string;
}

/**
 * Two runs over the same tasks, task by task. A drop is REVIEW only when it is larger than noise
 * would produce; a drop that small samples cannot tell from noise is INCOMPLETE and says how many
 * tasks would settle it (INV-821) — never REVIEW, because a gate that fires on three runs of a
 * stochastic system teaches people to wave it through.
 */
export function pairedComparison(now: ReadonlyMap<string, boolean>, baseline: ReadonlyMap<string, boolean>, alpha = 0.05): PairedComparison {
  let paired = 0;
  let worse = 0;
  let better = 0;
  let baselinePasses = 0;
  for (const [id, passed] of now) {
    const was = baseline.get(id);
    if (was === undefined) continue;
    paired += 1;
    if (was) baselinePasses += 1;
    if (was && !passed) worse += 1;
    if (!was && passed) better += 1;
  }
  const test = mcnemar(worse, better);
  const share = (count: number) => (paired === 0 ? 0 : count / paired);
  let verdict: ComparisonVerdict;
  let why: string;
  if (paired === 0) {
    verdict = "INCOMPLETE";
    why = "the two runs share no task";
  } else if (test.p < alpha) {
    verdict = worse > better ? "REVIEW" : "IMPROVED";
    why = `${worse} worse, ${better} better of ${paired}: more than noise produces (p = ${test.p.toFixed(3)})`;
  } else if (worse > better) {
    const needed = tasksNeededFor((worse - better) / paired, baselinePasses / paired);
    verdict = "INCOMPLETE";
    why = `${worse} worse, ${better} better of ${paired}: a drop this size cannot be told from noise here (p = ${test.p.toFixed(3)})` +
      (needed !== undefined ? `; about ${needed} tasks would settle it` : "");
  } else {
    verdict = "NO_CHANGE_DETECTED";
    why = `${worse} worse, ${better} better of ${paired}: no drop (p = ${test.p.toFixed(3)}); read it beside the detectable difference`;
  }
  return { paired, worse, better, worseShare: share(worse), betterShare: share(better), p: test.p, statistic: test.statistic, verdict, why };
}
