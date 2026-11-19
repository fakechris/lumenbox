/** The report's arithmetic against figures worked by hand or taken from the textbook case (INV-1772, INV-821). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapInterval, cohenKappa, failureUpperBound, mcnemar, minimumDetectableDifference, normalQuantile, pairedComparison, passAtAndHatK, tasksNeededFor, wilsonInterval,
} from "./stats.ts";

const near = (actual: number | undefined, expected: number, tolerance: number, what: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test("the bootstrap interval is the normal one on a large even sample, collapses when every task agrees, and repeats for a seed", () => {
  const half = [...new Array<number>(200).fill(1), ...new Array<number>(200).fill(0)];
  const interval = bootstrapInterval(half)!;
  assert.equal(interval.estimate, 0.5);
  // ±1.96 · √(0.25/400) = ±0.049
  near(interval.low, 0.451, 0.01, "low");
  near(interval.high, 0.549, 0.01, "high");
  assert.deepEqual(bootstrapInterval(half), interval, "the same results print the same interval");
  assert.deepEqual(bootstrapInterval([1, 1, 1, 1]), { estimate: 1, low: 1, high: 1 });
  assert.equal(bootstrapInterval([]), undefined, "no tasks, no estimate — not a zero");
  const few = bootstrapInterval([1, 0, 1])!;
  assert.ok(few.low === 0 || few.low < 0.4, "three tasks leave the interval wide open");
  assert.equal(few.high, 1);
});

test("pass@k and pass^k count tasks: once is not every time", () => {
  assert.deepEqual(passAtAndHatK([{ passes: 3, attempts: 3 }, { passes: 1, attempts: 3 }, { passes: 0, attempts: 3 }]), { tasks: 3, passAtK: 2 / 3, passHatK: 1 / 3 });
  assert.equal(passAtAndHatK([{ passes: 0, attempts: 0 }]), undefined, "a task never run is not a task that failed");
});

test("the normal quantile, the Wilson interval and the zero-failure bound match their tables", () => {
  near(normalQuantile(0.975), 1.959964, 1e-5, "z for 95% two-sided");
  near(normalQuantile(0.8), 0.841621, 1e-5, "z for 80% power");
  near(normalQuantile(0.01), -2.326348, 1e-5, "the lower tail");
  assert.throws(() => normalQuantile(1));
  const wilson = wilsonInterval(8, 10)!;
  near(wilson.low, 0.4902, 5e-4, "Wilson low for 8/10");
  near(wilson.high, 0.9433, 5e-4, "Wilson high for 8/10");
  // Thirty clean tasks: 1 − 0.05^(1/30), the "about 3/n" rule.
  near(failureUpperBound(0, 30), 0.0950, 5e-4, "upper bound with no failures");
  near(failureUpperBound(2, 10), wilsonInterval(2, 10)!.high, 1e-12, "with failures it is the Wilson bound");
  assert.equal(failureUpperBound(0, 0), undefined);
});

test("McNemar reads only the tasks that changed, exactly", () => {
  near(mcnemar(10, 0).p, 2 * 0.5 ** 10, 1e-12, "ten worse, none better");
  near(mcnemar(10, 0).statistic, 8.1, 1e-12, "continuity-corrected chi-square");
  // P(X ≤ 2 | n = 10, ½) = 56/1024, doubled.
  near(mcnemar(8, 2).p, 112 / 1024, 1e-12, "eight against two");
  assert.equal(mcnemar(1, 0).p, 1, "one changed task proves nothing");
  assert.deepEqual(mcnemar(0, 0), { discordant: 0, statistic: 0, p: 1 });
  assert.equal(mcnemar(3, 3).p, 1);
  assert.ok(mcnemar(700, 600).p < 0.01, "large counts do not overflow");
});

test("the detectable difference shrinks with the square root of the sample, and stays finite at a perfect rate", () => {
  // (1.959964 + 0.841621) · √(2 · 0.25 / 100)
  near(minimumDetectableDifference(100, 0.5), 0.1981, 5e-4, "n = 100 at 50%");
  near(minimumDetectableDifference(400, 0.5), 0.1981 / 2, 5e-4, "four times the tasks, half the difference");
  const perfect = minimumDetectableDifference(60, 1)!;
  assert.ok(perfect > 0 && perfect < 0.1, `a perfect rate still has a floor: ${perfect}`);
  assert.equal(minimumDetectableDifference(0, 0.5), undefined);
  // 2 · 0.25 · 2.801585² / 0.2² = 98.1
  assert.equal(tasksNeededFor(0.2, 0.5), 99, "the inverse: a 20-point difference at 50% needs 99 tasks");
  assert.equal(tasksNeededFor(0, 0.5), undefined);
});

test("kappa is agreement beyond chance, and refuses a rater who gave one answer", () => {
  const pairs: [boolean, boolean][] = [
    ...new Array<[boolean, boolean]>(20).fill([true, true]), ...new Array<[boolean, boolean]>(5).fill([true, false]),
    ...new Array<[boolean, boolean]>(10).fill([false, true]), ...new Array<[boolean, boolean]>(15).fill([false, false]),
  ];
  const result = cohenKappa(pairs)!;
  near(result.agreement, 0.7, 1e-12, "raw agreement");
  near(result.kappa, 0.4, 1e-12, "kappa: (0.7 − 0.5) / (1 − 0.5)");
  assert.equal(cohenKappa([[true, true], [true, true]])!.kappa, undefined, "all-yes from both is total chance agreement, not a perfect score");
  assert.equal(cohenKappa([]), undefined);
});

test("a drop is REVIEW only beyond noise; a small sample is INCOMPLETE and says what would settle it (INV-821)", () => {
  const run = (passes: number, total: number) => new Map(Array.from({ length: total }, (_, i) => [`t${i}`, i < passes] as const));
  const three = pairedComparison(run(2, 3), run(3, 3));
  assert.equal(three.verdict, "INCOMPLETE", "3/3 then 2/3 is one task: not a regression anyone can claim");
  assert.match(three.why, /about \d+ tasks would settle it/);
  const thirty = pairedComparison(run(20, 30), run(30, 30));
  assert.equal(thirty.verdict, "REVIEW");
  assert.equal(thirty.worse, 10);
  near(thirty.worseShare, 1 / 3, 1e-12, "the share that got worse");
  assert.equal(pairedComparison(run(30, 30), run(20, 30)).verdict, "IMPROVED");
  assert.equal(pairedComparison(run(30, 30), run(30, 30)).verdict, "NO_CHANGE_DETECTED");
  const disjoint = pairedComparison(new Map([["a", true]]), new Map([["b", true]]));
  assert.equal(disjoint.verdict, "INCOMPLETE");
  assert.equal(disjoint.paired, 0);
});
