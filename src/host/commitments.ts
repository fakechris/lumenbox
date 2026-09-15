/**
 * Commitments a routine writes down are checked against what it actually set up
 * (INV-528).
 *
 * A weekly retro said "send the reminder before 9/11" and "next week: close t12 by
 * 9/19", and neither happened, because the sentences lived in a document and nothing
 * else. Now a routine's report may carry a commitments block — `## 下周改` or
 * `## Next week` (or the same as a bold line), one item per bullet, a date on each — and
 * when the report is delivered the host reconciles every item against the board and the
 * scheduler: a commitment needs a task card (with a due date) and a reminder (a task
 * due by then, or an `@at` routine). What is missing is said in the same chat, the agent
 * is cued to create it now, and the next run of the same routine is told how last
 * week's commitments stand — so a retro that lists the same item twice is a fact the
 * person reads, not a coincidence.
 *
 * The same shape as docs/29's template reconcile: the host compares the document with
 * what landed, and says the difference. Nothing here decides what to commit to.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { dedupeKey } from "./memory.ts";

export interface Commitment {
  text: string;
  /** ISO date the item names, when it names one. */
  due?: string;
}

const HEADINGS = /^(?:#{1,4}\s*|\*\*)?\s*(下周改|下周要改|下周改进|本周改|next week(?:'s)? change(?:s)?|next week|commitments?)\s*[:：]?\s*(?:\*\*)?\s*$/i;

/** Pulls the commitments block out of a report: the bullets under its heading, until the next heading or a blank-then-prose line. */
export function parseCommitments(report: string, year = new Date().getUTCFullYear()): Commitment[] {
  const lines = report.split("\n");
  const start = lines.findIndex(line => HEADINGS.test(line.trim()));
  if (start < 0) return [];
  const out: Commitment[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line === "") {
      if (out.length > 0) break;
      continue;
    }
    if (/^#{1,4}\s/.test(line) || /^\*\*[^*]+\*\*\s*[:：]?\s*$/.test(line)) break;
    const item = line.replace(/^(?:[-*•]|\d+[.)、])\s*/, "").trim();
    if (item === "" || item === line && !/^(?:[-*•]|\d+[.)、])/.test(line)) {
      // Prose under the heading with no bullet is part of the same item list only if it
      // reads like one; a paragraph ends the block.
      if (out.length === 0 && item !== "") out.push({ text: item, ...(dueOf(item, year) !== undefined ? { due: dueOf(item, year)! } : {}) });
      break;
    }
    out.push({ text: item, ...(dueOf(item, year) !== undefined ? { due: dueOf(item, year)! } : {}) });
  }
  return out;
}

/** A date in the item: 2026-09-19, 9/19, 9月19日. The first one found. */
export function dueOf(text: string, year: number): string | undefined {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(text);
  if (slash !== null) return `${year}-${slash[1]!.padStart(2, "0")}-${slash[2]!.padStart(2, "0")}`;
  const cjk = /(\d{1,2})月(\d{1,2})日?/.exec(text);
  if (cjk !== null) return `${year}-${cjk[1]!.padStart(2, "0")}-${cjk[2]!.padStart(2, "0")}`;
  return undefined;
}

export interface CommitmentCheck {
  commitment: Commitment;
  /** Which task was bound to it last time, so the next run resolves by id and not by words. */
  boundTaskId?: string;
  /** The task that carries it, by id, when one does. */
  task?: { id: string; title: string; status: string; due?: string };
  /** The reminder that will fire for it: the task's own due date, or an @at routine. */
  reminder?: { kind: "task-due" | "routine"; ref: string };
  missing: ("card" | "due" | "reminder")[];
}

const tokens = (text: string): Set<string> => new Set(dedupeKey(text).split(" ").filter(t => t.length > 1));

/** A task shape the reconcile needs: its status and, for a finished one, when it moved. */
export interface CarrierTask {
  id: string;
  title: string;
  status: string;
  due?: string;
  updatedAt?: string;
}

/**
 * Whether a task can hold a commitment made now (INV-534).
 *
 * A dropped card holds nothing. A card marked done *before* the commitment was written
 * holds nothing either: the weekly retro that promises "send the reminder" every week
 * matched the same finished card from three weeks ago and passed every time, which is
 * the failure this whole file exists to catch, wearing a green tick.
 */
export function canCarry(task: CarrierTask, madeAt: number): boolean {
  if (task.status === "dropped") return false;
  if (task.status !== "done") return true;
  return task.updatedAt !== undefined && Date.parse(task.updatedAt) >= madeAt;
}

/** Whether a title is about the same thing as a commitment: shared key material, or the task id named in the item. */
export function matches(commitment: string, title: string, taskId?: string): boolean {
  if (taskId !== undefined && new RegExp(`\\b${taskId}\\b`).test(commitment)) return true;
  const a = tokens(commitment);
  const b = tokens(title);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.5 && shared >= 2;
}

/**
 * What is actually holding each commitment (INV-528), and what is not (INV-534).
 *
 * `madeAt` is when the commitment was written: a card finished before that cannot be
 * what will carry it. `bound` is what the last run tied each item to — an id beats a
 * word match, so "send the weekly reminder" keeps meaning the same card week after week
 * instead of drifting onto whatever has the most words in common today.
 */
export function reconcileCommitments(
  commitments: readonly Commitment[],
  tasks: readonly CarrierTask[],
  routines: readonly { slug: string; name: string; at?: number; paused?: boolean }[],
  madeAt: number = Date.now(),
  bound: ReadonlyMap<string, string> = new Map()
): CommitmentCheck[] {
  const usable = tasks.filter(task => canCarry(task, madeAt));
  return commitments.map(commitment => {
    const boundTaskId = bound.get(dedupeKey(commitment.text));
    const task =
      (boundTaskId !== undefined ? usable.find(candidate => candidate.id === boundTaskId) : undefined) ??
      usable.find(candidate => matches(commitment.text, candidate.title, candidate.id));
    const missing: CommitmentCheck["missing"] = [];
    if (task === undefined) missing.push("card");
    else if (task.due === undefined) missing.push("due");
    // The end of the day the item names, and nothing later. The first version allowed a
    // day of slack, so "before 9/11" was satisfied by a card due 9/12 — a deadline that
    // moves to meet whatever exists is not a deadline.
    const dueMs = commitment.due !== undefined ? Date.parse(`${commitment.due}T23:59:59Z`) : undefined;
    let reminder: CommitmentCheck["reminder"];
    if (task?.due !== undefined && (dueMs === undefined || Date.parse(task.due) <= dueMs)) reminder = { kind: "task-due", ref: task.id };
    else {
      const routine = routines.find(r => r.at !== undefined && r.paused !== true && (dueMs === undefined || r.at <= dueMs) && matches(commitment.text, r.name, undefined));
      if (routine !== undefined) reminder = { kind: "routine", ref: routine.slug };
    }
    if (reminder === undefined) missing.push("reminder");
    return {
      commitment,
      ...(task !== undefined ? { task, boundTaskId: task.id } : {}),
      ...(reminder !== undefined ? { reminder } : {}),
      missing,
    };
  });
}

/** What the last run bound each commitment to, by the same key a repeat of it produces. */
export function bindingsOf(record: CommitmentRecord | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const check of record?.checks ?? []) {
    const id = check.boundTaskId ?? check.task?.id;
    if (id !== undefined) out.set(dedupeKey(check.commitment.text), id);
  }
  return out;
}

/** What the chat hears about the gaps, and what the agent is cued to do. */
export function describeGaps(checks: readonly CommitmentCheck[]): { toChat?: string; cue?: string } {
  const gaps = checks.filter(check => check.missing.length > 0);
  if (gaps.length === 0) return {};
  const lines = gaps.map(check => {
    const what = check.missing.map(m => (m === "card" ? "no task card" : m === "due" ? "the card has no due date" : "nothing will remind anyone by then")).join(", ");
    return `- ${check.commitment.text}${check.commitment.due !== undefined ? ` (by ${check.commitment.due})` : ""}: ${what}`;
  });
  return {
    toChat: `Commitments in this report that nothing is holding:\n${lines.join("\n")}`,
    cue:
      `[commitments] The report you just delivered lists ${checks.length} commitment(s); ${gaps.length} of them ${gaps.length === 1 ? "is" : "are"} not held by anything:\n${lines.join("\n")}\n` +
      "Right now, in this turn: create a task card for each with Tasks (title in the item's words, due on its date), and for any without a date, an @at routine on the day you mean. " +
      "Then one line naming what you created. Do not restate the report.",
  };
}

export interface CommitmentRecord {
  at: string;
  slug: string;
  agentId: string;
  commitments: Commitment[];
  checks: CommitmentCheck[];
  /**
   * Commitments from earlier runs that are still not done (INV-534), with the run that
   * made each. A week that does not repeat an item is not a week the item was dropped;
   * the first version read only the newest record, so anything not restated disappeared
   * from the next run's opening — which is how "9/11 前发 reminder" went quiet.
   */
  carried?: { at: string; commitment: Commitment; taskId?: string }[];
}

export class CommitmentLedger {
  constructor(private readonly path: string) {}

  record(entry: CommitmentRecord): void {
    appendLine(this.path, JSON.stringify(entry));
  }

  /**
   * The record to write, with everything still open from before carried into it
   * (INV-534). `isDone(taskId)` says whether the card that held an older item has been
   * finished; anything unfinished travels forward, keeping the date it was promised for.
   */
  withCarried(entry: CommitmentRecord, isDone: (taskId: string | undefined) => boolean): CommitmentRecord {
    const previous = this.lastFor(entry.slug);
    const earlier = [
      ...(previous?.carried ?? []),
      ...(previous?.checks ?? []).map(check => ({ at: previous!.at, commitment: check.commitment, ...(check.boundTaskId ?? check.task?.id ? { taskId: check.boundTaskId ?? check.task!.id } : {}) })),
    ];
    const restated = new Set(entry.commitments.map(commitment => dedupeKey(commitment.text)));
    const carried = earlier.filter(item => !restated.has(dedupeKey(item.commitment.text)) && !isDone(item.taskId));
    return { ...entry, ...(carried.length > 0 ? { carried } : {}) };
  }

  /** The newest record for a routine, so its next run is told how last time's commitments stand. */
  lastFor(slug: string): CommitmentRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    let last: CommitmentRecord | undefined;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as CommitmentRecord;
        if (parsed.slug === slug) last = parsed;
      } catch {
        // One torn line.
      }
    }
    return last;
  }
}

/** The prompt line a routine's next run opens with: last time's commitments and where each stands now. */
export function priorCommitmentsPrompt(
  last: CommitmentRecord | undefined,
  tasks: readonly CarrierTask[]
): string | undefined {
  if (last === undefined) return undefined;
  const bindings = bindingsOf(last);
  const stateOf = (commitment: Commitment, taskId?: string): string => {
    const id = taskId ?? bindings.get(dedupeKey(commitment.text));
    const task = (id !== undefined ? tasks.find(candidate => candidate.id === id) : undefined) ?? tasks.find(candidate => matches(commitment.text, candidate.title, candidate.id));
    return task === undefined ? "no card was ever created" : `${task.id} is ${task.status}${task.due !== undefined ? `, due ${task.due.slice(0, 10)}` : ""}`;
  };
  const lines = last.commitments.map(commitment => `- ${commitment.text}${commitment.due !== undefined ? ` (by ${commitment.due})` : ""} — ${stateOf(commitment)}`);
  // Older items nobody has finished, still named, with the date they were promised for:
  // silence about a commitment is not the same as having kept it.
  const older = (last.carried ?? []).map(item => `- (from ${item.at.slice(0, 10)}) ${item.commitment.text}${item.commitment.due !== undefined ? ` (by ${item.commitment.due})` : ""} — ${stateOf(item.commitment, item.taskId)}`);
  if (lines.length === 0 && older.length === 0) return undefined;
  return (
    `Last time (${last.at.slice(0, 10)}) this routine committed to:\n${lines.length > 0 ? lines.join("\n") : "- nothing"}` +
    (older.length > 0 ? `\nStill open from before:\n${older.join("\n")}` : "") +
    `\nSay where each stands before anything else; a commitment repeated without a card is a finding, not a plan.`
  );
}
