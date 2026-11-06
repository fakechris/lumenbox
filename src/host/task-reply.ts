/**
 * The agent's last word on a task it was handed through the side door (INV-1676).
 *
 * A task assigned with `assign_task` runs one turn and closes when the turn does. What the
 * agent said at the end of that turn reached nobody: the caller outside reads the record, and
 * the record held a status and whatever notes the agent chose to write. An agent that answered
 * in prose and wrote no note left "completed" and nothing else. So the turn's final reply is
 * written on the task as one move of its history, by the agent, marked as a reply rather than
 * recognised from its wording — cut at a fixed length, because the task is the record of the
 * work and not a copy of the conversation (the whole reply stays in the agent's transcript).
 */

import type { Task, TaskChange } from "./tasks.ts";

/** How much of a reply the task keeps; the transcript keeps all of it. */
export const REPLY_MAX = 2000;

/** The reply as the task keeps it: trimmed, and cut with a mark when it ran long. Empty when there was none. */
export function clampReply(text: string): string {
  const said = text.trim();
  return said.length <= REPLY_MAX ? said : `${said.slice(0, REPLY_MAX - 1).trimEnd()}…`;
}

/** The next task with the reply recorded, or undefined for an unknown task or an empty reply. */
export function applyReply(task: Task | undefined, by: string, text: string, now: Date, historyLimit: number): Task | undefined {
  const note = clampReply(text);
  if (task === undefined || note === "") return undefined;
  const at = now.toISOString();
  const change: TaskChange = { at, by, note, reply: true };
  return { ...task, updatedAt: at, history: [...task.history, change].slice(-historyLimit) };
}

/** The latest reply a task holds, for a record that carries fewer moves than the board keeps. */
export function lastReply(task: Pick<Task, "history">): TaskChange | undefined {
  return task.history.findLast(change => change.reply === true && change.note !== undefined);
}
