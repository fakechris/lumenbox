/**
 * Code graders (INV-1772): what a program can decide about a run, decided by a program.
 *
 * Labels, required facts, forbidden words, format and the state a run ends in are all things a
 * reader could check with a finger on the page, so no model is asked. Each part of a task's gold
 * is one grader with one result and the evidence for it; an attempt passes when every grader
 * does. What needs an understanding of meaning is a judge's question, asked second and kept
 * apart from these.
 */

import { scoreTeaching, type TeachFixture } from "../host/teach-evals.ts";
import type { EvalTask, StateBound } from "./corpus.ts";

/** What one attempt at a task left behind, in the terms the graders read. */
export interface Observation {
  /** What the person would have read: the answer, the draft, the classifier's raw reply. */
  output: string;
  /** What the run did or decided, as labels: `skill:<slug>` for a skill opened, the verdict given. */
  labels: string[];
  /** The state the run ended in: answered, questions, toolCalls, agents and the like. */
  state: Record<string, number | string | boolean>;
  /**
   * The harness failed, not the model: nothing here says anything about the system under test.
   * Counted apart and still in the denominator, so a broken run cannot raise a pass rate.
   */
  infra?: string;
}

export interface GraderResult {
  /** `labels`, `facts`, `forbidden`, `format`, `state:<key>`, or `<scorer>:<check>`. */
  name: string;
  pass: boolean;
  /** What was found, in words a reader can check against the output. */
  detail?: string;
}

/** Plain text is found without regard to case; `re:` starts a pattern (also without case). */
export function textMatches(needle: string, haystack: string): boolean {
  if (needle.startsWith("re:")) return new RegExp(needle.slice(3), "i").test(haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function boundProblem(bound: StateBound, value: number | string | boolean | undefined): string | undefined {
  if (value === undefined) return "the run did not report it";
  if (bound.eq !== undefined && value !== bound.eq) return `is ${String(value)}, wanted ${String(bound.eq)}`;
  if (bound.min !== undefined && !(typeof value === "number" && value >= bound.min)) return `is ${String(value)}, wanted at least ${bound.min}`;
  if (bound.max !== undefined && !(typeof value === "number" && value <= bound.max)) return `is ${String(value)}, wanted at most ${bound.max}`;
  return undefined;
}

function formatProblem(format: NonNullable<EvalTask["gold"]["format"]>, output: string): string | undefined {
  if (format === "nonempty") return output.trim() === "" ? "nothing was said" : undefined;
  try {
    const value: unknown = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""));
    return value !== null && typeof value === "object" ? undefined : "JSON, but not an object or a list";
  } catch {
    return "does not parse as JSON";
  }
}

/** Every grader the task's gold names, run over one observation. Pure; no model. */
export function gradeObservation(task: EvalTask, observation: Observation): GraderResult[] {
  const gold = task.gold;
  const results: GraderResult[] = [];
  if (gold.labels !== undefined) {
    const missing = (gold.labels.all ?? []).filter(label => !observation.labels.includes(label));
    const unwanted = (gold.labels.none ?? []).filter(label => observation.labels.includes(label));
    const problems = [...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []), ...(unwanted.length > 0 ? [`must not carry ${unwanted.join(", ")}`] : [])];
    results.push({ name: "labels", pass: problems.length === 0, detail: `${problems.join("; ") || "as wanted"} (got: ${observation.labels.join(", ") || "none"})` });
  }
  if (gold.facts !== undefined) {
    const missing = gold.facts.filter(fact => !textMatches(fact, observation.output));
    results.push({ name: "facts", pass: missing.length === 0, ...(missing.length > 0 ? { detail: `missing: ${missing.join(" | ")}` } : {}) });
  }
  if (gold.forbidden !== undefined) {
    const found = gold.forbidden.filter(word => textMatches(word, observation.output));
    results.push({ name: "forbidden", pass: found.length === 0, ...(found.length > 0 ? { detail: `contains: ${found.join(" | ")}` } : {}) });
  }
  if (gold.format !== undefined) {
    const problem = formatProblem(gold.format, observation.output);
    results.push({ name: "format", pass: problem === undefined, ...(problem !== undefined ? { detail: problem } : {}) });
  }
  for (const [key, bound] of Object.entries(gold.state ?? {})) {
    const problem = boundProblem(bound, observation.state[key]);
    results.push({ name: `state:${key}`, pass: problem === undefined, ...(problem !== undefined ? { detail: `${key} ${problem}` } : {}) });
  }
  if (gold.scorer?.name === "teach") {
    const fixture = { id: String(task.input.fixture ?? task.id), trace: task.input.trace, expect: gold.scorer.expect, reference: gold.answer ?? "" } as unknown as TeachFixture;
    for (const check of scoreTeaching(fixture, observation.output)) {
      results.push({ name: `teach:${check.name}`, pass: check.ok, ...(check.detail !== undefined && !check.ok ? { detail: check.detail.slice(0, 200) } : {}) });
    }
  }
  return results;
}
