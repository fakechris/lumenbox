/**
 * A task's deliverables (INV-1663): the files an agent marked as what the task produced.
 *
 * Until this, "done" had nothing to open. A file pasted into a reply reached the chat it was
 * asked in and nowhere else, the board's evidence was a list of strings, and the box kept
 * changing underneath both — a report rewritten the next morning was no longer the one a
 * person accepted. A deliverable is the other kind of file: named on purpose, with a line on
 * what it is, and copied off the box at the moment it was named, so what the task page
 * offers for download is the bytes the agent handed over, whatever the box does next.
 *
 * Storage beside the board's own file: `<dir of tasks.jsonl>/deliverables/<task id>/<sha256>`,
 * content-addressed and written once, read-only. The record — name, size, digest, note, who,
 * when — rides on the task like its history. Not built: versions or diffs between deliveries
 * (each delivery is its own entry), and a library of files across tasks.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boxPathsNamed } from "./named-files.ts";
import type { Task, TaskChange } from "./tasks.ts";

export interface TaskDeliverable {
  /** "d1", "d2", … per task: what a person or an agent says, and what the download names. */
  id: string;
  /** The file's name as the person will save it: the basename of `path`. */
  name: string;
  /** Where in the box it was when it was delivered. Informational; the snapshot is the file. */
  path: string;
  size: number;
  sha256: string;
  /** What it is, in the agent's words: one line. */
  note: string;
  at: string;
  by: string;
  /** The turn it was delivered in. */
  run?: string;
}

/** Past this a file is not taken: the same cap the chat outbox has. */
export const DELIVERABLE_LIMIT_BYTES = 25 * 1024 * 1024;
/** Deliveries kept on one task. A task that hands over more is a batch, and should be zipped. */
export const DELIVERABLES_PER_TASK = 50;
export const DELIVERABLE_NOTE_MAX = 300;

/** Where a board keeps its deliverables: beside the board's own file, so one home holds both. */
export function deliverablesDir(tasksFile: string): string {
  return join(dirname(tasksFile), "deliverables");
}

function snapshotFile(tasksFile: string, taskId: string, sha256: string): string {
  return join(deliverablesDir(tasksFile), taskId.replace(/[^A-Za-z0-9_-]/g, "_"), sha256);
}

export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Writes the snapshot, once. Content-addressed, so a second delivery of the same bytes is the
 * same file, and a file that is already there is never rewritten — which is what makes it
 * immutable in practice, not only by permission bits.
 */
export function writeSnapshot(tasksFile: string, taskId: string, bytes: Buffer): string {
  const sha256 = digestOf(bytes);
  const file = snapshotFile(tasksFile, taskId, sha256);
  if (existsSync(file)) return sha256;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { flag: "wx", mode: 0o444 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return sha256;
}

/** A deliverable's bytes, checked against the digest it was recorded under; undefined if gone or altered. */
export function readSnapshot(tasksFile: string, taskId: string, item: Pick<TaskDeliverable, "sha256">): Buffer | undefined {
  const file = snapshotFile(tasksFile, taskId, item.sha256);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  return digestOf(bytes) === item.sha256 ? bytes : undefined;
}

/** The next task with one more deliverable, or undefined when there is no such task. */
export function applyDeliverable(
  task: Task | undefined,
  item: Omit<TaskDeliverable, "id">,
  historyLimit: number
): { task: Task; item: TaskDeliverable } | undefined {
  if (task === undefined) return undefined;
  const existing = task.deliverables ?? [];
  const numbers = existing.map(entry => Number(entry.id.slice(1))).filter(Number.isFinite);
  const delivered: TaskDeliverable = { id: `d${Math.max(0, ...numbers) + 1}`, ...item, note: item.note.replace(/\s+/g, " ").trim().slice(0, DELIVERABLE_NOTE_MAX) };
  const change: TaskChange = { at: item.at, by: item.by, note: `delivered ${delivered.name}${delivered.note !== "" ? ` — ${delivered.note}` : ""}`, ...(item.run !== undefined ? { run: item.run } : {}) };
  return {
    item: delivered,
    task: { ...task, deliverables: [...existing, delivered].slice(-DELIVERABLES_PER_TASK), updatedAt: item.at, history: [...task.history, change].slice(-historyLimit) },
  };
}

/** The same bytes under the same name already delivered to this task: a retried call, not a second delivery. */
export function alreadyDelivered(task: Pick<Task, "deliverables">, name: string, sha256: string): TaskDeliverable | undefined {
  return (task.deliverables ?? []).find(entry => entry.name === name && entry.sha256 === sha256);
}

/**
 * Files a task's submission for review points at, when the task has no deliverable at all.
 *
 * The agent said it made something — its move to review names a file in the box — and marked
 * nothing, so the task page has nothing to open. A path comparison, not a judgement: the
 * person is told, and decides whether it matters.
 */
export function claimedButNotDelivered(task: Pick<Task, "status" | "history" | "deliverables">, work: string): string[] { // work: the assignee's box's (INV-1737)
  if (task.status !== "review" || (task.deliverables ?? []).length > 0) return [];
  const submission = [...task.history].reverse().find(change => change.status === "review");
  if (submission === undefined) return [];
  return boxPathsNamed([submission.note ?? "", ...(submission.evidence ?? [])].join("\n"), work);
}
