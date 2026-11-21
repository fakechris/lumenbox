/**
 * The product's judges held against a person's labels, and what that standing lets them decide
 * (INV-1773).
 *
 * The labels are the evaluation's labels (src/evals/calibration.ts `HumanLabel`): a question, the
 * digest of the output it is about, `present` or `absent`, who said so — and here also when. They
 * differ from the evaluation's in two ways only. They live in `~/.agentbox/judge-labels.jsonl`,
 * written by the labelling page, not in `evals/labels/` in the repository: they are about this
 * installation's live verdicts, whose outputs are people's conversations and never committed. And
 * the question is namespaced by the judge (`answer-review:not-answered`, judge-record.ts), because
 * the product's questions are not the corpus's failure types. Kappa, catch rate, false-kill rate
 * and the thresholds are calibration.ts's, unchanged.
 *
 * What a standing changes, per judge and question:
 *
 *   - not calibrated (fewer than 30 matched labels for the judge, fewer than 10 on the question, or
 *     one answer throughout) — nothing. Every gate behaves exactly as it did before labels existed.
 *     That is every judge on a fresh installation.
 *   - measured under KAPPA_TO_GATE (0.6) — a hint, never a gate: `handsBack` is true, and the gate
 *     the verdict would have decided hands it to a person instead (auto-review.ts, memory-judge.ts).
 *   - measured under KAPPA_TO_RELEASE_UNATTENDED (0.8) — `releasesUnattended` is false: the verdict
 *     may not release anything on its own in a routine nobody is watching. No judge releases
 *     anything on its own today — the policy gate stands under every auto-review ALLOW — so this is
 *     the answer later work must ask (INV-1898), not a change to any present decision.
 *
 * A judge's standing is computed on the verdicts of its current model and question version only:
 * a reworded prompt or another model is another judge, and starts uncalibrated.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Calibration, calibrate, type HumanLabel, labelProblem, MIN_LABELS, parseLabels } from "../evals/calibration.ts";
import type { JudgeVerdict } from "../evals/judges.ts";
import { appendLine } from "./jsonl.ts";
import { JUDGE_LEDGERS, type JudgeName, type ProductVerdict, QUESTIONS, readVerdicts } from "./judge-record.ts";

export const LABELS_FILE = "judge-labels.jsonl";
export const JUDGES: readonly JudgeName[] = ["auto-review", "answer-review", "memory-judge", "jev"];

export interface JudgeStanding {
  judge: JudgeName;
  /** The current model and question version, per question; absent when it has judged nothing yet. */
  versions: { question: string; judgeModel: string; judgeVersion: string }[];
  /** Verdicts of the current versions. */
  verdicts: number;
  calibration: Calibration;
}

export interface Standings {
  judges: JudgeStanding[];
  labels: number;
  /** A label file that could not be read: every judge is then not calibrated, and the page says why. */
  problem?: string;
}

/** The labels a person gave on this installation. Throws, with the line, on one that is not a label. */
export function readProductLabels(home: string): HumanLabel[] {
  const path = join(home, LABELS_FILE);
  return existsSync(path) ? parseLabels(readFileSync(path, "utf8"), path) : [];
}

/** Appends one label, after the same check the reader makes. */
export function appendProductLabel(home: string, label: HumanLabel): void {
  const problem = labelProblem(label);
  if (problem !== undefined) throw new Error(problem);
  appendLine(join(home, LABELS_FILE), JSON.stringify(label));
}

/** Only the verdicts of each question's latest model and version: what the judge is now. */
function current(verdicts: readonly ProductVerdict[]): { kept: ProductVerdict[]; versions: JudgeStanding["versions"] } {
  const latest = new Map<string, { judgeModel: string; judgeVersion: string }>();
  for (const verdict of verdicts) latest.set(verdict.question, { judgeModel: verdict.judgeModel, judgeVersion: verdict.judgeVersion });
  const kept = verdicts.filter(verdict => {
    const now = latest.get(verdict.question)!;
    return verdict.judgeModel === now.judgeModel && verdict.judgeVersion === now.judgeVersion;
  });
  return { kept, versions: [...latest].map(([question, now]) => ({ question, ...now })).sort((a, b) => a.question.localeCompare(b.question)) };
}

/** Every judge's standing from the ledgers and the labels under `home`. */
export function computeStandings(home: string, verdicts: readonly ProductVerdict[] = readVerdicts(home)): Standings {
  let labels: HumanLabel[] = [];
  let problem: string | undefined;
  try {
    labels = readProductLabels(home);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const judges = JUDGES.map((judge): JudgeStanding => {
    const { kept, versions } = current(verdicts.filter(verdict => verdict.judge === judge));
    const asked: JudgeVerdict[] = kept.map((verdict, i) => ({ task: verdict.locate.ledger, attempt: i, question: verdict.question, verdict: verdict.verdict, outputDigest: verdict.digest }));
    // Questions the judge has not answered yet are still shown, as not calibrated.
    const calibration = calibrate({ verdicts: asked }, problem === undefined ? labels : []);
    const known = new Set(calibration.questions.map(one => one.question));
    const own = Object.entries(QUESTIONS).filter(([, info]) => judge === "jev" ? false : info.judge === judge).map(([question]) => question);
    for (const question of own.filter(one => !known.has(one))) {
      calibration.questions.push({ question, labels: 0, humanPresent: 0, humanAbsent: 0, measured: false, mayGate: false, mayReleaseUnattended: false, why: `${calibration.matched} of ${MIN_LABELS} labels` });
    }
    calibration.questions.sort((a, b) => a.question.localeCompare(b.question));
    return { judge, versions, verdicts: kept.length, calibration };
  });
  return { judges, labels: labels.length, ...(problem !== undefined ? { problem } : {}) };
}

const questionOf = (standings: Standings, judge: JudgeName, question: string) =>
  standings.judges.find(one => one.judge === judge)?.calibration.questions.find(one => one.question === question);

/** True when a person's labels measured this judge's question under KAPPA_TO_GATE: its verdict is a hint, and a person decides. */
export function handsBack(standings: Standings, judge: JudgeName, question: string): boolean {
  const one = questionOf(standings, judge, question);
  return one !== undefined && one.measured && !one.mayGate;
}

/** False unless a person's labels measured this judge's question at KAPPA_TO_RELEASE_UNATTENDED or above. */
export function releasesUnattended(standings: Standings, judge: JudgeName, question: string): boolean {
  return questionOf(standings, judge, question)?.mayReleaseUnattended === true;
}

export interface JudgeBooks {
  /** A memory-judge verdict, one line a candidate and question (remember.ts). */
  record: (line: Record<string, unknown>) => void;
  handsBack: (judge: JudgeName, question: string) => boolean;
  releasesUnattended: (judge: JudgeName, question: string) => boolean;
  standings: () => Standings;
}

/** How long a standing is reused before the ledgers are read again; a new label is read at once. */
const STANDING_TTL_MS = 60_000;

/**
 * The books of one installation: the memory judge's ledger, and its judges' standings, recomputed
 * when a label is added and otherwise at most once a minute — the ledgers grow with every reply and
 * call, and a gate asks on every one. A standing that cannot be computed is "not calibrated": the
 * gates then behave as they did before.
 */
export function judgeBooksAt(home: string, now: () => number = Date.now): JudgeBooks {
  let cached: { at: number; labels: string; standings: Standings } | undefined;
  const labelStamp = (): string => {
    try {
      const stat = statSync(join(home, LABELS_FILE));
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "none";
    }
  };
  const standings = (): Standings => {
    const stamp = labelStamp();
    if (cached !== undefined && cached.labels === stamp && now() - cached.at < STANDING_TTL_MS) return cached.standings;
    let computed: Standings;
    try {
      computed = computeStandings(home);
    } catch (error) {
      computed = { judges: [], labels: 0, problem: error instanceof Error ? error.message : String(error) };
    }
    cached = { at: now(), labels: stamp, standings: computed };
    return computed;
  };
  return {
    record: line => {
      try {
        appendLine(join(home, JUDGE_LEDGERS["memory-judge"]), JSON.stringify(line));
      } catch {
        // A verdict's record is not worth failing the memory it is about.
      }
    },
    handsBack: (judge, question) => handsBack(standings(), judge, question),
    releasesUnattended: (judge, question) => releasesUnattended(standings(), judge, question),
    standings,
  };
}

const books = new Map<string, JudgeBooks>();
/** The one set of books per installation home, shared by every judge and the page. */
export function judgeBooks(home: string): JudgeBooks {
  const known = books.get(home);
  if (known !== undefined) return known;
  const made = judgeBooksAt(home);
  books.set(home, made);
  return made;
}
