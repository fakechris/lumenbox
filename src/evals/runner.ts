/**
 * The runner (INV-1772): every task k times, graded by code, written down whole.
 *
 * It holds no model and no statistics. It is given tasks, the subjects that run them, a model per
 * tier and a cache, and returns a record of what each attempt did — the graders' findings, the
 * tokens it used, the answer itself — from which summary.ts computes every number and report.ts
 * prints the page. Keeping the record separate from the arithmetic is what lets a result be
 * re-read later against a new baseline, or re-graded by a judge, without asking the model again.
 *
 * A harness failure is not a failure of the system under test, and is not a pass either: it is
 * marked `infra`, counted apart, and stays in the denominator.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderProfile } from "../host/provider.ts";
import { redactCredentials } from "../host/teach.ts";
import { type CacheStore, type CallCounters, cachedModel, type ModelCall } from "./cache.ts";
import { corpusVersion, digest, type EvalTask, type Split, type SubjectName, taskVersion } from "./corpus.ts";
import { type GraderResult, gradeObservation } from "./graders.ts";
import type { JudgeSection } from "./judges.ts";
import type { Subject } from "./subjects.ts";

/** What a record was run over: one side of the corpus, or both pooled, which only a comparison of two versions does. */
export type RunSplit = Split | "dev+test";

export interface TokenUse {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AttemptResult {
  attempt: number;
  pass: boolean;
  /** The harness failed; the model was not tested. Never a pass, still counted. */
  infra?: string;
  graders: GraderResult[];
  labels: string[];
  state: Record<string, number | string | boolean>;
  /** What was answered, credentials redacted and cut to a readable length: what a judge or a person labels. */
  output: string;
  model: string;
  use: TokenUse;
}

export interface TaskResult {
  id: string;
  version: string;
  subject: SubjectName;
  source: EvalTask["source"];
  failureType: string;
  attempts: AttemptResult[];
}

export interface EvalRun {
  format: "lumenbox-eval/1";
  at: string;
  commit: string;
  dirty: boolean;
  split: RunSplit;
  corpus: { version: string; tasks: number };
  k: number;
  /** True when a deterministic stand-in answered instead of a model: the numbers measure nothing. */
  fake: boolean;
  /** The model behind each tier that ran: what a baseline must match to be compared with. */
  models: Partial<Record<Subject["tier"], { provider: string; model: string }>>;
  calls: CallCounters;
  tasks: TaskResult[];
  /** The judges' verdicts on this record's outputs, when they were asked (judges.ts). Never part of `pass`. */
  judges?: JudgeSection;
}

export interface Tier {
  model: ModelCall;
  profile: ProviderProfile;
}

export interface RunOptions {
  tasks: readonly EvalTask[];
  split: RunSplit;
  k?: number;
  subjects: Readonly<Record<SubjectName, Subject>>;
  /** The real models, per tier. Unused when `fake` is given, except for the profile. */
  tiers: Record<Subject["tier"], Tier>;
  /** Answer from each subject's deterministic stand-in instead; `wrongShare` of attempts get the wrong reply. */
  fake?: { wrongShare: number; seed?: number };
  cache?: CacheStore;
  /** Never call a model: an attempt whose calls are not all in the cache is an infra result. */
  offline?: boolean;
  meta: { at: string; commit: string; dirty: boolean };
  progress?: (line: string) => void;
}

const OUTPUT_LIMIT = 4000;
export const emptyUse = (): TokenUse => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** Adds up what each call reports having used, as the usage ledger would have recorded it. */
export function metered(model: ModelCall, use: TokenUse): ModelCall {
  return async (params, wire) => {
    const message = await model(params, wire);
    const usage = (message.usage ?? {}) as Partial<Anthropic.Usage>;
    use.calls += 1;
    use.inputTokens += usage.input_tokens ?? 0;
    use.outputTokens += usage.output_tokens ?? 0;
    use.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    use.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    return message;
  };
}

/** Whether this attempt gets the stand-in's wrong reply: fixed by the seed, the task and the attempt. */
export const fakeIsWrong = (seed: number, id: string, attempt: number, wrongShare: number): boolean =>
  Number.parseInt(digest(`${seed}:${id}:${attempt}`).slice(0, 8), 16) / 0x100000000 < wrongShare;

/** The most calls a run over these tasks can make: what a person is told before they spend. */
export function callBudget(tasks: readonly EvalTask[], subjects: RunOptions["subjects"], k: number): { total: number; bySubject: Partial<Record<SubjectName, { tasks: number; calls: number }>> } {
  const bySubject: Partial<Record<SubjectName, { tasks: number; calls: number }>> = {};
  let total = 0;
  for (const task of tasks) {
    const calls = subjects[task.subject].maxCalls(task) * k;
    const cell = bySubject[task.subject] ?? { tasks: 0, calls: 0 };
    bySubject[task.subject] = { tasks: cell.tasks + 1, calls: cell.calls + calls };
    total += calls;
  }
  return { total, bySubject };
}

export async function runEval(options: RunOptions): Promise<EvalRun> {
  const k = options.k ?? 3;
  const counters: CallCounters = { made: 0, cached: 0 };
  const models: EvalRun["models"] = {};
  const results: TaskResult[] = [];
  for (const task of options.tasks) {
    const subject = options.subjects[task.subject];
    const tier = options.tiers[subject.tier];
    const named = options.fake !== undefined ? { provider: "fake", model: "deterministic stand-in" } : { provider: tier.profile.label, model: tier.profile.model };
    models[subject.tier] = named;
    const version = taskVersion(task);
    const attempts: AttemptResult[] = [];
    for (let attempt = 1; attempt <= k; attempt += 1) {
      const use = emptyUse();
      const wrong = options.fake !== undefined && fakeIsWrong(options.fake.seed ?? 1, task.id, attempt, options.fake.wrongShare);
      const source = options.fake !== undefined ? subject.fake(task, wrong) : tier.model;
      const recipe = { subject: subject.name, provider: named.provider, model: named.model, attempt, ...(options.fake !== undefined ? { wrong: wrong ? 1 : 0 } : {}) };
      const model = metered(cachedModel(source, options.cache, { dataVersion: version, recipe }, counters, { ...(options.offline !== undefined ? { offline: options.offline } : {}) }), use);
      let observation: Awaited<ReturnType<Subject["run"]>>;
      try {
        observation = await subject.run(task, { model, profile: tier.profile });
      } catch (error) {
        observation = { output: "", labels: [], state: {}, infra: error instanceof Error ? error.message : String(error) };
      }
      const graders = observation.infra === undefined ? gradeObservation(task, observation) : [];
      const output = redactCredentials(observation.output.length > OUTPUT_LIMIT ? `${observation.output.slice(0, OUTPUT_LIMIT)} …` : observation.output);
      attempts.push({
        attempt,
        pass: observation.infra === undefined && graders.length > 0 && graders.every(grader => grader.pass),
        ...(observation.infra !== undefined ? { infra: observation.infra } : {}),
        graders, labels: observation.labels, state: observation.state, output, model: named.model, use,
      });
    }
    results.push({ id: task.id, version, subject: task.subject, source: task.source, failureType: task.failureType, attempts });
    const marks = attempts.map(one => (one.infra !== undefined ? "!" : one.pass ? "·" : "x")).join("");
    options.progress?.(`${marks}  ${task.id}`);
  }
  return {
    format: "lumenbox-eval/1", ...options.meta, split: options.split,
    corpus: { version: corpusVersion(options.tasks), tasks: options.tasks.length },
    k, fake: options.fake !== undefined, models, calls: counters, tasks: results,
  };
}
