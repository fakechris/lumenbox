/**
 * Two versions of the prompt and the tools on the same tasks (INV-1862).
 *
 * A change to `prompt.ts` or to a tool's description is an edit to the product's behaviour with
 * no diff a reviewer can read the effect from. This runs the product as it was at a base commit
 * and as it is at a candidate, both over one set of tasks with one set of graders, k attempts
 * each, and says what moved: both pass rates, the difference task by task with its interval, the
 * tasks that got worse and better, what a pass costs on each side, and a gate.
 *
 * It is orchestration over what exists. A side is an ordinary run (runner.ts) on that commit's
 * subjects (frozen.ts); its numbers are an ordinary summary (summary.ts); the pairing, McNemar and
 * the interval are stats.ts. What is decided here is only what the two runs share and what red
 * means.
 *
 * **One instrument.** The tasks and graders are the running checkout's, for both sides. A commit's
 * own corpus is never read: a task worded differently on each side is two questions, and no
 * pairing of them says anything about the prompt.
 *
 * **One cache, keyed by the request.** Nothing in a cache key names a side. The system prompt and
 * the tool list are inside every request an agent sends, so two versions that differ there never
 * share an entry; and a request the two send byte for byte alike — the steward's, when only the
 * agent's prompt changed — is the same question to the same model and is asked once. Asking it
 * twice would pay for noise the change did not cause.
 *
 * **Red.** The gate reads code graders only. It is red when the pass rate fell and the whole 95%
 * interval of the difference is below zero, or when more tasks than allowed went from passing
 * every attempt to passing none. The second catches a change that breaks some tasks outright
 * while fixing others, which the first averages away. It counts outright breaks, not every task
 * that moved: at one failed attempt in ten, a fifth of all tasks change sides between two runs
 * of the very same version, and a count of those is red on noise.
 */

import type { Rates } from "../host/spend.ts";
import type { CacheStore } from "./cache.ts";
import type { EvalTask, Split, SubjectName } from "./corpus.ts";
import { type EvalRun, type RunOptions, type RunSplit, runEval, type TaskResult } from "./runner.ts";
import { bootstrapInterval, type Interval, type PairedComparison, pairedComparison } from "./stats.ts";
import type { Subject } from "./subjects.ts";
import { reliable, type Summary, summarise } from "./summary.ts";
import type { PromptSurface } from "./surface.ts";

/** One version, ready to run: a commit's subjects and the prompt it sends. */
export interface Build {
  ref: string;
  sha: string;
  subjects: Readonly<Record<SubjectName, Subject>>;
  surface: PromptSurface;
  ownCorpus: "same" | "different" | "none";
}

export interface Side {
  ref: string;
  sha: string;
  /** What this version sends: the sizes and one name for the whole. The text itself is in the commit. */
  surface: { digest: string; systemBytes: number; toolsBytes: number; tools: number };
  ownCorpus: Build["ownCorpus"];
  run: EvalRun;
}

export interface CompareRecord {
  format: "lumenbox-eval-compare/1";
  at: string;
  k: number;
  fake: boolean;
  /** Which half of the corpus each task is from: dev is what a prompt may have been tuned against. */
  splits: Record<string, Split>;
  base: Side;
  candidate: Side;
}

export interface CompareOptions {
  base: Build;
  candidate: Build;
  /** The running checkout's tasks, by half; an empty half is left out. */
  tasks: Readonly<Record<Split, readonly EvalTask[]>>;
  k?: number;
  tiers: RunOptions["tiers"];
  fake?: { wrongShare: number };
  cache?: CacheStore;
  offline?: boolean;
  at: string;
  progress?: (line: string) => void;
}

/**
 * The stand-in's draw for a version. A model answers a changed prompt with a fresh sample and an
 * unchanged one — through the cache — with the same; so does this: one seed per prompt.
 */
const standInSeed = (surface: PromptSurface): number => Number.parseInt(surface.digest.slice(0, 8), 16);

export async function runCompare(options: CompareOptions): Promise<CompareRecord> {
  const k = options.k ?? 3;
  const tasks = [...options.tasks.dev, ...options.tasks.test];
  const split: RunSplit = options.tasks.dev.length === 0 ? "test" : options.tasks.test.length === 0 ? "dev" : "dev+test";
  const side = async (name: string, build: Build): Promise<Side> => {
    options.progress?.(`${name}: ${build.ref} (${build.sha.slice(0, 7)}), prompt ${build.surface.digest}`);
    const run = await runEval({
      tasks, split, k, subjects: build.subjects, tiers: options.tiers,
      ...(options.fake !== undefined ? { fake: { wrongShare: options.fake.wrongShare, seed: standInSeed(build.surface) } } : {}),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...(options.offline !== undefined ? { offline: options.offline } : {}),
      meta: { at: options.at, commit: build.sha.slice(0, 7), dirty: false },
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    });
    const { surface } = build;
    return { ref: build.ref, sha: build.sha, surface: { digest: surface.digest, systemBytes: surface.bytes.system, toolsBytes: surface.bytes.tools, tools: surface.tools.length }, ownCorpus: build.ownCorpus, run };
  };
  const base = await side("base", options.base);
  const candidate = await side("candidate", options.candidate);
  return {
    format: "lumenbox-eval-compare/1", at: options.at, k, fake: options.fake !== undefined,
    splits: Object.fromEntries((["dev", "test"] as const).flatMap(half => options.tasks[half].map(task => [task.id, half]))),
    base, candidate,
  };
}

/** A task whose outcome differs between the sides, with what each side scored. */
export interface MovedTask {
  id: string;
  split: Split | undefined;
  base: string;
  candidate: string;
  /** Passed every attempt on one side and none on the other. */
  outright: boolean;
  /** What the graders first found on the side that did not pass. */
  finding: string;
}

export interface Gate {
  /** NOT_READ: no task ran on both sides, so there is nothing to be red about — or clear of. */
  status: "RED" | "NOT_RED" | "NOT_READ";
  reasons: string[];
  maxBroken: number;
  maxWorse?: number;
}

export interface Comparison {
  base: Summary;
  candidate: Summary;
  /** Candidate minus base, the mean over paired tasks of the change in a task's own pass rate; the interval resamples tasks. */
  difference?: Interval;
  /** Task by task, a task passing when every attempt did: counts, McNemar, and what the size of the sample lets them mean. */
  paired: PairedComparison;
  worse: MovedTask[];
  better: MovedTask[];
  /** Tasks the harness failed on either side: not paired, since neither outcome is the model's. */
  unpaired: string[];
  bySplit: { split: Split; tasks: number; base: number; candidate: number; worse: number; better: number }[];
  /** Per passed attempt, candidate minus base; absent where a side passed nothing or has no price. */
  cost: { tokensPerPass?: number; usdPerPass?: number };
  gate: Gate;
}

const passes = (task: TaskResult): number => task.attempts.filter(attempt => attempt.pass).length;
const score = (task: TaskResult): string => `${passes(task)}/${task.attempts.length}`;
const harnessFailed = (task: TaskResult): boolean => task.attempts.some(attempt => attempt.infra !== undefined);
const points = (value: number): string => `${(value * 100).toFixed(1)}`;

function firstFinding(task: TaskResult): string {
  const bad = task.attempts.find(attempt => !attempt.pass);
  return bad === undefined ? "" : bad.graders.filter(grader => !grader.pass).map(grader => `${grader.name}${grader.detail !== undefined ? ` — ${grader.detail}` : ""}`).join("; ");
}

export function compareSides(record: CompareRecord, options: { rates?: Rates; maxBroken?: number; maxWorse?: number } = {}): Comparison {
  const rates = options.rates !== undefined ? { rates: options.rates } : {};
  const before = new Map(record.base.run.tasks.map(task => [task.id, task]));
  const pairs = record.candidate.run.tasks.flatMap(task => {
    const was = before.get(task.id);
    return was === undefined ? [] : [{ id: task.id, was, now: task }];
  });
  const unpaired = pairs.filter(pair => harnessFailed(pair.was) || harnessFailed(pair.now)).map(pair => pair.id);
  const kept = pairs.filter(pair => !unpaired.includes(pair.id));
  const paired = pairedComparison(new Map(kept.map(pair => [pair.id, reliable(pair.now)])), new Map(kept.map(pair => [pair.id, reliable(pair.was)])));
  const difference = bootstrapInterval(kept.map(pair => passes(pair.now) / pair.now.attempts.length - passes(pair.was) / pair.was.attempts.length));

  const byId = new Map(kept.map(pair => [pair.id, pair]));
  const moved = (ids: readonly string[], failing: "was" | "now"): MovedTask[] => ids.map(id => {
    const pair = byId.get(id)!;
    return { id, split: record.splits[id], base: score(pair.was), candidate: score(pair.now), outright: passes(pair[failing]) === 0, finding: firstFinding(pair[failing]) };
  });
  const worse = moved(paired.worseIds, "now");
  const better = moved(paired.betterIds, "was");

  const base = summarise(record.base.run, rates);
  const candidate = summarise(record.candidate.run, rates);
  const less = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? a - b : undefined);
  const tokensPerPass = less(candidate.cost.tokensPerPass, base.cost.tokensPerPass);
  const usdPerPass = less(candidate.cost.usdPerPass, base.cost.usdPerPass);

  const maxBroken = options.maxBroken ?? 0;
  const broken = worse.filter(task => task.outright).length;
  const reasons: string[] = [];
  if (difference !== undefined && difference.high < 0) {
    reasons.push(`the pass rate fell by ${points(-difference.estimate)} points, and the whole 95% interval of the difference (${points(difference.low)} to ${points(difference.high)}) is below zero`);
  }
  if (broken > maxBroken) reasons.push(`${broken} task${broken === 1 ? "" : "s"} that passed every attempt on the base passed none on the candidate (${maxBroken} allowed)`);
  if (options.maxWorse !== undefined && worse.length > options.maxWorse) reasons.push(`${worse.length} tasks got worse (${options.maxWorse} allowed)`);

  return {
    base, candidate,
    ...(difference !== undefined ? { difference } : {}),
    paired, worse, better, unpaired,
    bySplit: (["dev", "test"] as const).flatMap(split => {
      const mine = kept.filter(pair => record.splits[pair.id] === split);
      if (mine.length === 0) return [];
      const count = (tasks: readonly MovedTask[]) => tasks.filter(task => task.split === split).length;
      return [{ split, tasks: mine.length, base: mine.filter(pair => reliable(pair.was)).length, candidate: mine.filter(pair => reliable(pair.now)).length, worse: count(worse), better: count(better) }];
    }),
    cost: { ...(tokensPerPass !== undefined ? { tokensPerPass } : {}), ...(usdPerPass !== undefined ? { usdPerPass } : {}) },
    gate: {
      status: kept.length === 0 ? "NOT_READ" : reasons.length > 0 ? "RED" : "NOT_RED",
      reasons: kept.length === 0 ? ["no task ran on both sides"] : reasons,
      maxBroken,
      ...(options.maxWorse !== undefined ? { maxWorse: options.maxWorse } : {}),
    },
  };
}
