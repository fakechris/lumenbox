/**
 * A supervisor's raised attention on a task (INV-1509, docs/91).
 *
 * The watchdog outside sees what the record says — no change for an hour, a goal the gate stopped
 * and nobody looked at, a verification that failed twice — and its one way to say so is a flag:
 * a line on the task, an item on the person's "needs you" strip, a notice in the task's chat.
 * A flag changes nothing about the work. It holds until the task's status next moves, which is
 * read off the history rather than cleared by every writer, and the same note on the same task
 * inside the cooldown is the same flag, not a second one.
 */

import type { Task, TaskChange } from "./tasks.ts";

export const FLAG_NOTE_MAX = 280;
export const FLAG_COOLDOWN_MS = 6 * 60 * 60_000;

export interface TaskFlag {
  by: string;
  note: string;
  at: string;
}

/** The flag, while it holds: none once the task's status has moved since it was raised. */
export function currentFlag(task: Pick<Task, "flag" | "history">): TaskFlag | undefined {
  const flag = task.flag;
  if (flag === undefined) return undefined;
  const moved = task.history.some(change => change.status !== undefined && change.at > flag.at);
  return moved ? undefined : flag;
}

export type FlagOutcome = "raised" | "already" | "missing" | "ended";

/** The next task when a flag is raised, or why not. */
export function applyFlag(task: Task | undefined, by: string, note: string, now: Date, historyLimit: number): { outcome: FlagOutcome; task?: Task } {
  if (task === undefined) return { outcome: "missing" };
  if (task.status === "done" || task.status === "dropped") return { outcome: "ended" };
  const text = note.replace(/\s+/g, " ").trim().slice(0, FLAG_NOTE_MAX);
  const held = currentFlag(task);
  if (held !== undefined && held.note === text && now.getTime() - Date.parse(held.at) < FLAG_COOLDOWN_MS) return { outcome: "already" };
  const at = now.toISOString();
  const change: TaskChange = { at, by, note: `flagged for a person: ${text}` };
  return { outcome: "raised", task: { ...task, flag: { by, note: text, at }, updatedAt: at, history: [...task.history, change].slice(-historyLimit) } };
}
