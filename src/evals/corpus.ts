/**
 * The gold corpus (INV-1772): `evals/corpus/dev.jsonl` and `evals/corpus/test.jsonl`, one task a line.
 *
 * A task is something a person could ask, the way it is run (`subject`), what a right result
 * looks like (`gold`), where it came from, and the one failure it exists to catch. Dev is what a
 * prompt may be tuned against; test is what a report is read from, and is never tuned against —
 * so the two are separate files, and a task, an input or a group appearing in both is refused at
 * load rather than discovered in a number that was too good.
 *
 * The corpus is derived from material already in the repository (corpus-build.ts) and from lines
 * a person adds. Nothing here reads a conversation, a ledger or a review record of an
 * installation: what a person's own data contributes, the person adds.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Split = "dev" | "test";
export const SPLITS: readonly Split[] = ["dev", "test"];

/** How a task is run. Each has one implementation in subjects.ts. */
export type SubjectName = "episode" | "auto-review" | "steward" | "teach";
export const SUBJECTS: readonly SubjectName[] = ["episode", "auto-review", "steward", "teach"];

/**
 * Where a task came from. The last two are a person's own material — replies a review judged and
 * a person corrected, and tasks an evaluation run already scored — and are empty until a person
 * adds lines; nothing in the repository holds them.
 */
export type SourceKind = "skill-eval" | "teach-fixture" | "auto-review-trajectory" | "steward-tail" | "scenario" | "review-ledger" | "learning-material";
export const SOURCE_KINDS: readonly SourceKind[] = ["skill-eval", "teach-fixture", "auto-review-trajectory", "steward-tail", "scenario", "review-ledger", "learning-material"];

/** A bound on one number or flag of the state a run ends in. */
export interface StateBound {
  eq?: number | string | boolean;
  min?: number;
  max?: number;
}

/** What a right result looks like. Every part present is one code grader; a task needs at least one. */
export interface Gold {
  /** Labels the run must carry (`all`) and must not (`none`): the skill opened, the verdict given. */
  labels?: { all?: string[]; none?: string[] };
  /** Text the answer must contain. Plain text is matched without case; `re:` starts a pattern. */
  facts?: string[];
  /** Text the answer must not contain; same matching. */
  forbidden?: string[];
  /** A shape the answer must have. */
  format?: "json" | "nonempty";
  /** Bounds on the state the run ends in: answered, questions asked, model calls made. */
  state?: Record<string, StateBound>;
  /** An existing deterministic scorer, named, with what it needs. `teach` is teach-evals.ts. */
  scorer?: { name: "teach"; expect: Record<string, unknown> };
  /** A reference answer, where the source has one. Never shown to the model under test. */
  answer?: string;
}

export interface EvalTask {
  id: string;
  subject: SubjectName;
  source: { kind: SourceKind; ref: string };
  /** The one failure this task exists to catch, in a few words; the report groups by it. */
  failureType: string;
  /** Tasks that must stay on one side of the split together: both cases of one skill, say. */
  group?: string;
  /** What the subject is given. Its shape belongs to the subject. */
  input: Record<string, unknown>;
  gold: Gold;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const hasGrader = (gold: Gold): boolean =>
  gold.labels !== undefined || gold.facts !== undefined || gold.forbidden !== undefined || gold.format !== undefined || gold.state !== undefined || gold.scorer !== undefined;

/** Why this is not a task, or undefined. The schema, in code. */
export function taskProblem(value: unknown): string | undefined {
  const task = value as Partial<EvalTask>;
  if (task === null || typeof task !== "object") return "not an object";
  if (typeof task.id !== "string" || !ID.test(task.id)) return "id must be lowercase letters, digits, . _ -";
  if (!SUBJECTS.includes(task.subject as SubjectName)) return `subject must be one of ${SUBJECTS.join(", ")}`;
  if (task.source === undefined || !SOURCE_KINDS.includes(task.source.kind) || typeof task.source.ref !== "string" || task.source.ref === "") {
    return `source needs a kind (${SOURCE_KINDS.join(", ")}) and a ref saying where it came from`;
  }
  if (typeof task.failureType !== "string" || task.failureType.trim() === "") return "failureType is required: the one failure this task catches";
  if (task.input === undefined || task.input === null || typeof task.input !== "object") return "input is required";
  if (task.gold === undefined || task.gold === null || typeof task.gold !== "object" || !hasGrader(task.gold)) {
    return "gold needs at least one of labels, facts, forbidden, format, state, scorer: a task nothing grades proves nothing";
  }
  return undefined;
}

/** Stable JSON: keys sorted, so the same task hashes the same whoever wrote it. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The version of one task: what the cache and a baseline comparison hold a result to. */
export const taskVersion = (task: EvalTask): string => digest(canonical(task)).slice(0, 16);

/** The version of a set of tasks, independent of their order. */
export const corpusVersion = (tasks: readonly EvalTask[]): string => digest(tasks.map(task => `${task.id}:${taskVersion(task)}`).sort().join("\n")).slice(0, 12);

export function parseCorpusFile(text: string, where: string): EvalTask[] {
  const tasks: EvalTask[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${where}:${index + 1}: not JSON`);
    }
    const problem = taskProblem(parsed);
    if (problem !== undefined) throw new Error(`${where}:${index + 1}: ${problem}`);
    tasks.push(parsed as EvalTask);
  });
  return tasks;
}

export const serializeCorpus = (tasks: readonly EvalTask[]): string => `${[...tasks].sort((a, b) => (a.id < b.id ? -1 : 1)).map(task => JSON.stringify(task)).join("\n")}\n`;

export type Corpus = Record<Split, EvalTask[]>;

/**
 * Everything that would let test leak into dev, or make a number mean less than it says: an id
 * twice, the same input on both sides, a group split across the two.
 */
export function corpusProblems(corpus: Corpus): string[] {
  const problems: string[] = [];
  const side = new Map<string, Split>();
  const inputs = new Map<string, { split: Split; id: string }>();
  const groups = new Map<string, Split>();
  for (const split of SPLITS) {
    for (const task of corpus[split]) {
      const before = side.get(task.id);
      if (before !== undefined) problems.push(`${task.id} appears ${before === split ? `twice in ${split}` : "in both dev and test"}`);
      side.set(task.id, split);
      const input = digest(canonical({ subject: task.subject, input: task.input }));
      const same = inputs.get(input);
      if (same !== undefined && same.split !== split) problems.push(`${task.id} (${split}) has the same input as ${same.id} (${same.split}): test would be tuned against`);
      inputs.set(input, { split, id: task.id });
      if (task.group !== undefined) {
        const held = groups.get(task.group);
        if (held !== undefined && held !== split) problems.push(`group ${task.group} is split across dev and test (${task.id})`);
        groups.set(task.group, split);
      }
    }
  }
  return problems;
}

/** Reads both files and refuses a corpus whose halves are not apart. A missing file is an empty half. */
export function loadCorpus(dir: string): Corpus {
  const read = (split: Split): EvalTask[] => {
    const path = join(dir, `${split}.jsonl`);
    return existsSync(path) ? parseCorpusFile(readFileSync(path, "utf8"), path) : [];
  };
  const corpus: Corpus = { dev: read("dev"), test: read("test") };
  const problems = corpusProblems(corpus);
  if (problems.length > 0) throw new Error(`the corpus in ${dir} is not usable:\n  ${problems.join("\n  ")}`);
  return corpus;
}
