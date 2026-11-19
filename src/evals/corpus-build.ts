/**
 * The corpus, derived from what the repository already holds (INV-1772).
 *
 * Five places already state a request and what a right result is: the starter skills' own cases,
 * the teach fixtures, the auto-review trajectories, the context steward's labelled endings, and
 * the live scenarios. Each is turned into tasks here, with the failure it exists to catch, and
 * `evals/corpus/*.jsonl` is this function's output — a test holds the two together, so a case
 * edited at its source and not in the corpus (or the reverse) fails the suite.
 *
 * A task's side of the split is decided once, by a hash of its group, and then kept: a task never
 * moves from test to dev because another task was added. Lines a person added by hand (a source
 * this file does not derive) are carried through untouched.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewInput } from "../host/auto-review.ts";
import { starterSkillsWithEvals } from "../host/starter-skills.ts";
import { TEACH_FIXTURES } from "../host/teach-evals.ts";
import { type Corpus, canonical, digest, type EvalTask, type SourceKind, type Split, SPLITS } from "./corpus.ts";

/** The share of new groups that land in dev: about 20 of 80. */
const DEV_PERCENT = 25;

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

/** The kinds this file derives; a task of any other kind in the corpus was added by a person. */
export const DERIVED_KINDS: readonly SourceKind[] = ["skill-eval", "teach-fixture", "auto-review-trajectory", "steward-tail", "scenario"];

/**
 * The two live scenarios an in-memory box can carry (scripts/scenario-live.mjs, by name). The
 * third, `heavy`, walks a real file tree with a real shell and stays with `npm run scenario`.
 */
const SCENARIO_TASKS: readonly EvalTask[] = [
  {
    id: "scenario.team",
    subject: "episode",
    source: { kind: "scenario", ref: "scripts/scenario-live.mjs#team" },
    failureType: "team-not-built",
    input: {
      says: "Build me a five-agent content team: a scout, a brief writer, a drafter, a fact checker and an analyst. They share /home/box/work/content-team.",
      cap: 40,
    },
    gold: { state: { agents: { min: 6 }, questions: { max: 1 }, toolCalls: { max: 39 } } },
  },
  {
    id: "scenario.vague",
    subject: "episode",
    source: { kind: "scenario", ref: "scripts/scenario-live.mjs#vague" },
    failureType: "clarification-spiral",
    input: { says: "写点东西发出去。", cap: 12 },
    gold: { state: { questions: { max: 1 }, engaged: { eq: true }, toolCalls: { max: 11 } } },
  },
];

function skillTasks(): EvalTask[] {
  return starterSkillsWithEvals().flatMap(starter =>
    // A case that says it cannot be run honestly is not a task: it would be a denominator of nothing.
    starter.evals.filter(one => one.na === undefined).map((one): EvalTask => ({
      id: `skill.${starter.slug}.${slug(one.name)}`,
      subject: "episode",
      source: { kind: "skill-eval", ref: `src/host/starter-skills.ts#${starter.slug}/${one.name}` },
      failureType: one.kind === "trigger" ? "skill-not-opened" : "skill-opened-wrongly",
      group: `skill:${starter.slug}`,
      input: { says: one.says, ...(one.files !== undefined ? { files: one.files } : {}), cap: 4 },
      gold: { labels: one.kind === "trigger" ? { all: [`skill:${starter.slug}`] } : { none: [`skill:${starter.slug}`] } },
    }))
  );
}

function teachTasks(): EvalTask[] {
  return TEACH_FIXTURES.map((fixture): EvalTask => ({
    id: `teach.${slug(fixture.id)}`,
    subject: "teach",
    source: { kind: "teach-fixture", ref: `src/host/teach-evals.ts#${fixture.id}` },
    failureType: fixture.expect.skill ? "unusable-skill-draft" : "skill-written-from-nothing",
    input: { fixture: fixture.id, trace: fixture.trace },
    gold: { scorer: { name: "teach", expect: fixture.expect as unknown as Record<string, unknown> }, answer: fixture.reference },
  }));
}

function autoReviewTasks(root: string): EvalTask[] {
  const file = "src/host/fixtures/auto-review-trajectories.json";
  const { cases } = JSON.parse(readFileSync(join(root, file), "utf8")) as { cases: { name: string; expected: "ALLOW" | "BLOCK"; input: ReviewInput }[] };
  return cases.map((one): EvalTask => ({
    id: `auto-review.${slug(one.name)}`,
    subject: "auto-review",
    source: { kind: "auto-review-trajectory", ref: `${file}#${one.name}` },
    failureType: one.expected === "BLOCK" ? "allowed-unauthorised-action" : "blocked-authorised-action",
    input: one.input as unknown as Record<string, unknown>,
    gold: { labels: { all: [one.expected] } },
  }));
}

function stewardTasks(root: string): EvalTask[] {
  const file = "src/host/fixtures/steward-tails.json";
  const { cases } = JSON.parse(readFileSync(join(root, file), "utf8")) as { cases: { name: string; expected: "switch" | "compact"; condensed: number; view: string }[] };
  return cases.map((one): EvalTask => ({
    id: `steward.${slug(one.name)}`,
    subject: "steward",
    source: { kind: "steward-tail", ref: `${file}#${one.name}` },
    failureType: one.expected === "switch" ? "missed-stopping-point" : "needless-fresh-context",
    input: { condensed: one.condensed, view: one.view },
    gold: { labels: { all: [one.expected] } },
  }));
}

/** Every task the repository's own material yields, before any is given a side. */
export function derivedTasks(root: string): EvalTask[] {
  return [...skillTasks(), ...teachTasks(), ...autoReviewTasks(root), ...stewardTasks(root), ...SCENARIO_TASKS];
}

const sideOf = (key: string): Split => (Number.parseInt(digest(key).slice(0, 8), 16) % 100 < DEV_PERCENT ? "dev" : "test");

/**
 * The corpus as it should stand: every derived task, on the side it already had in `existing` or
 * else the side its group hashes to; derived tasks whose source is gone are dropped; a person's
 * own lines are kept where they are.
 */
export function buildCorpus(root: string, existing: Corpus = { dev: [], test: [] }): Corpus {
  const held = new Map<string, Split>();
  for (const split of SPLITS) for (const task of existing[split]) held.set(task.group ?? task.id, split);
  const corpus: Corpus = { dev: [], test: [] };
  for (const split of SPLITS) corpus[split].push(...existing[split].filter(task => !DERIVED_KINDS.includes(task.source.kind)));
  // One request is often two tasks: the line that must open one skill is the line that must not
  // open its neighbour. Tasks that share a group or an input go to one side together, or the
  // test half would hold a question the dev half was tuned on.
  const tasks = derivedTasks(root);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const up = parent.get(key) ?? key;
    if (up === key) return key;
    const top = find(up);
    parent.set(key, top);
    return top;
  };
  const keyOf = (task: EvalTask) => task.group ?? task.id;
  for (const task of tasks) {
    const [a, b] = [find(keyOf(task)), find(`input:${digest(canonical({ subject: task.subject, input: task.input }))}`)];
    if (a !== b) parent.set(...((a < b ? [b, a] : [a, b]) as [string, string]));
  }
  const members = new Map<string, string[]>();
  for (const task of tasks) members.set(find(keyOf(task)), [...(members.get(find(keyOf(task))) ?? []), keyOf(task)]);
  for (const task of tasks) {
    const cluster = find(keyOf(task));
    const before = (members.get(cluster) ?? []).map(key => held.get(key)).find(side => side !== undefined);
    corpus[before ?? sideOf(cluster)].push(task);
  }
  return corpus;
}
