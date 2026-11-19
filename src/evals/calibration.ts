/**
 * Judge calibration (INV-1772): whether a judge's verdicts agree with a person's, question by question.
 *
 * A judge is a model's opinion until it has been held against labels a person gave to the same
 * outputs. Until then every page says "judge not calibrated — may not gate", and so does this
 * file: with fewer than thirty matched labels nothing is calibrated, whatever the agreement on
 * the few there are.
 *
 * Labels live in `evals/labels/*.jsonl`, one line an output: the question, the digest of the
 * output that was read, `present` or `absent`, and who said so. A label is about an output, not
 * about a judge — the same labels calibrate any judge that answered the same question on the
 * same output, which is what lets a reworded question or another judge model be checked without
 * asking a person again. A label for an output this record does not hold is simply not matched.
 *
 * The sheet a person fills in is drawn from a record of the test split (`selectForLabelling`),
 * spread over the questions and over the judge's two answers, with the judge's answer left out:
 * a person shown the verdict agrees with it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, type EvalTask } from "./corpus.ts";
import { JUDGE_QUESTIONS, judgeContext, type JudgeSection, type JudgeVerdict } from "./judges.ts";
import type { EvalRun } from "./runner.ts";
import { cohenKappa } from "./stats.ts";

/** Below this many matched labels, no judge is calibrated. */
export const MIN_LABELS = 30;
/** Below this many on one question, that question's kappa is too thin to gate on. */
export const MIN_LABELS_PER_QUESTION = 10;
/** Agreement beyond chance a judge's question needs before its verdicts may gate anything. */
export const KAPPA_TO_GATE = 0.6;

export interface HumanLabel {
  /** The failure type asked about. */
  question: string;
  /** The digest of the output the person read, as the record and the sheet give it. */
  outputDigest: string;
  label: "present" | "absent";
  /** Who labelled it. A label nobody signed is not a label. */
  by: string;
  task?: string;
  attempt?: number;
  note?: string;
}

/** One row of the sheet a person fills in: `label` and `by` are empty until they do. */
export interface SheetRow {
  task: string;
  attempt: number;
  question: string;
  /** The question in words, as the judge was asked it. */
  asks: string;
  context: string;
  output: string;
  outputDigest: string;
  label: null;
  by: null;
}

/** Why a line is not a label, or undefined. A row still unfilled (`label: null`) is not a problem: it is not yet a label. */
export function labelProblem(value: unknown): string | undefined {
  const row = value as Partial<HumanLabel>;
  if (row === null || typeof row !== "object") return "not an object";
  if (typeof row.question !== "string" || row.question === "") return "question is required: the failure type that was asked about";
  if (typeof row.outputDigest !== "string" || !/^[0-9a-f]{16}$/.test(row.outputDigest)) return "outputDigest must be the 16-character digest from the sheet";
  if (row.label !== "present" && row.label !== "absent") return 'label must be "present" or "absent"';
  if (typeof row.by !== "string" || row.by.trim() === "") return "by is required: who labelled it";
  return undefined;
}

export function parseLabels(text: string, where: string): HumanLabel[] {
  const labels: HumanLabel[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${where}:${index + 1}: not JSON`);
    }
    if (parsed.label === null || parsed.label === undefined) return;
    const problem = labelProblem(parsed);
    if (problem !== undefined) throw new Error(`${where}:${index + 1}: ${problem}`);
    labels.push({
      question: parsed.question as string, outputDigest: parsed.outputDigest as string, label: parsed.label as HumanLabel["label"], by: (parsed.by as string).trim(),
      ...(typeof parsed.task === "string" ? { task: parsed.task } : {}), ...(typeof parsed.attempt === "number" ? { attempt: parsed.attempt } : {}),
      ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
    });
  });
  return labels;
}

/** Every label in a directory's `*.jsonl` files. No directory is no labels. */
export function loadLabels(dir: string): HumanLabel[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort().flatMap(name => parseLabels(readFileSync(join(dir, name), "utf8"), join(dir, name)));
}

/**
 * The outputs a person is asked to label: at least `count` where the record has them, spread
 * evenly over the questions and, within a question, alternating between what the judge called
 * present and absent — a subset the judge called all-absent could not show whether it catches
 * anything. Fixed by `seed`, so the same record gives the same sheet. Test split only: the
 * calibration subset is part of what a report is read from.
 */
export function selectForLabelling(run: EvalRun, tasks: readonly EvalTask[], options: { count?: number; seed?: number } = {}): SheetRow[] {
  if (run.fake || run.judges === undefined || run.judges.model.provider === "fake") throw new Error("there is nothing to label: this record holds no judged output of a real model");
  if (run.split !== "test") throw new Error(`the calibration subset is drawn from the test split; this record is ${run.split}`);
  const count = options.count ?? MIN_LABELS;
  const order = (verdict: JudgeVerdict) => digest(`${options.seed ?? 1772}:${verdict.task}:${verdict.attempt}:${verdict.question}`);
  const pools = new Map<string, JudgeVerdict[]>();
  for (const question of [...new Set(run.judges.verdicts.map(verdict => verdict.question))].sort()) {
    const mine = run.judges.verdicts.filter(verdict => verdict.question === question).sort((a, b) => (order(a) < order(b) ? -1 : 1));
    const present = mine.filter(verdict => verdict.verdict === "present");
    const rest = mine.filter(verdict => verdict.verdict !== "present");
    const mixed: JudgeVerdict[] = [];
    while (present.length > 0 || rest.length > 0) {
      const a = present.shift();
      if (a !== undefined) mixed.push(a);
      const b = rest.shift();
      if (b !== undefined) mixed.push(b);
    }
    pools.set(question, mixed);
  }
  // Round-robin over the questions, so a question with few outputs gives all it has and the others make up the number.
  const chosen: JudgeVerdict[] = [];
  const seen = new Set<string>();
  while (chosen.length < count && [...pools.values()].some(pool => pool.length > 0)) {
    for (const pool of pools.values()) {
      const next = pool.shift();
      if (next === undefined || chosen.length >= count) continue;
      // The same text judged for the same question twice is one thing to label, not two.
      const key = `${next.question}:${next.outputDigest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chosen.push(next);
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const asks = new Map(JUDGE_QUESTIONS.map(one => [one.failureType, one.question]));
  return chosen.flatMap(verdict => {
    const task = byId.get(verdict.task);
    const output = run.tasks.find(one => one.id === verdict.task)?.attempts.find(one => one.attempt === verdict.attempt)?.output;
    if (task === undefined || output === undefined) return [];
    return [{
      task: verdict.task, attempt: verdict.attempt, question: verdict.question, asks: asks.get(verdict.question) ?? verdict.question,
      context: judgeContext(task), output, outputDigest: verdict.outputDigest, label: null, by: null,
    }];
  });
}

/** Two decimals, without the "-0.00" a rounding error prints for no agreement beyond chance. */
export const twoPlaces = (value: number): string => (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);

export interface QuestionCalibration {
  question: string;
  /** Labelled outputs this judge also answered. */
  labels: number;
  agreement?: number;
  /** Undefined when the person or the judge gave one answer throughout: nothing to agree beyond chance on. */
  kappa?: number;
  /** Of the outputs a person said have the failure, the share the judge caught. Undefined when the person found none. */
  catchRate?: number;
  humanPresent: number;
  mayGate: boolean;
  why: string;
}

export interface Calibration {
  /** True once there are enough matched labels to say anything; says nothing about any one question. */
  calibrated: boolean;
  /** Labels matched to a verdict of this judge. */
  matched: number;
  /** Labels for an output or a question this record's judge did not answer. */
  unmatched: number;
  /** Outputs two people labelled differently: left out, because there is no one answer to agree with. */
  conflicting: number;
  labellers: string[];
  questions: QuestionCalibration[];
}

/**
 * Holds a judge's verdicts against a person's labels. An `invalid` verdict is the judge failing
 * to answer, and counts as disagreeing with whatever the person said: a judge may not improve
 * its agreement by declining the hard ones.
 */
export function calibrate(judges: JudgeSection, labels: readonly HumanLabel[]): Calibration {
  const said = new Map<string, HumanLabel["label"] | "conflict">();
  for (const label of labels) {
    const key = `${label.question}:${label.outputDigest}`;
    const before = said.get(key);
    said.set(key, before === undefined || before === label.label ? label.label : "conflict");
  }
  const verdicts = new Map(judges.verdicts.map(verdict => [`${verdict.question}:${verdict.outputDigest}`, verdict]));
  const pairs = new Map<string, [boolean, boolean][]>();
  let matched = 0;
  let unmatched = 0;
  let conflicting = 0;
  for (const [key, label] of said) {
    const verdict = verdicts.get(key);
    if (verdict === undefined) unmatched += 1;
    else if (label === "conflict") conflicting += 1;
    else {
      matched += 1;
      const human = label === "present";
      const judge = verdict.verdict === "invalid" ? !human : verdict.verdict === "present";
      pairs.set(verdict.question, [...(pairs.get(verdict.question) ?? []), [human, judge]]);
    }
  }
  const calibrated = matched >= MIN_LABELS;
  const questions = [...new Set(judges.verdicts.map(verdict => verdict.question))].sort().map((question): QuestionCalibration => {
    const mine = pairs.get(question) ?? [];
    const kappa = cohenKappa(mine);
    const humanPresent = mine.filter(([human]) => human).length;
    const caught = mine.filter(([human, judge]) => human && judge).length;
    let why: string;
    if (!calibrated) why = `${matched} of ${MIN_LABELS} labels`;
    else if (mine.length < MIN_LABELS_PER_QUESTION) why = `${mine.length} labels on this question; ${MIN_LABELS_PER_QUESTION} needed`;
    else if (kappa?.kappa === undefined) why = "the person or the judge gave one answer throughout: agreement beyond chance cannot be told";
    else if (kappa.kappa < KAPPA_TO_GATE) why = `kappa ${twoPlaces(kappa.kappa)} is under ${KAPPA_TO_GATE}`;
    else why = `kappa ${twoPlaces(kappa.kappa)} on ${mine.length} labels`;
    const mayGate = calibrated && mine.length >= MIN_LABELS_PER_QUESTION && kappa?.kappa !== undefined && kappa.kappa >= KAPPA_TO_GATE;
    return {
      question, labels: mine.length, humanPresent, mayGate, why,
      ...(kappa !== undefined ? { agreement: kappa.agreement } : {}),
      ...(kappa?.kappa !== undefined ? { kappa: kappa.kappa } : {}),
      ...(humanPresent > 0 ? { catchRate: caught / humanPresent } : {}),
    };
  });
  return { calibrated, matched, unmatched, conflicting, labellers: [...new Set(labels.map(label => label.by))].sort(), questions };
}
