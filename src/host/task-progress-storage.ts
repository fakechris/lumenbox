/** A durable state checkpoint of the existing task file, with the counter preserved; and what leaves it for the archive. */
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { archiveSettled } from "./jsonl.ts";
import type { Task } from "./tasks.ts";
export function checkpointTasks(path: string, counter: number, tasks: Iterable<Task>): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const text = [JSON.stringify({ kind: "counter", value: counter }), ...Array.from(tasks, task => JSON.stringify({ kind: "task", task }))].join("\n") + "\n";
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * Whether a closed record has been closed long enough to leave the ledger. A card somebody made
 * always could; a record that carries a work root never did, so a person's every chat message
 * stayed in the file for good (INV-1824). A request that was answered or stopped is over in the same
 * way: its root has nothing left to hold. A goal's record, and any root that is not the host's own
 * for a request, stay as they were.
 */
export function closedLongEnough(task: Task, cutoff: number): boolean {
  if ((task.status !== "done" && task.status !== "dropped") || !(Date.parse(task.updatedAt) < cutoff)) return false;
  const root = task.workRoot;
  if (root === undefined) return true;
  return root.automatic === true && task.pursuit === undefined && (root.cancellation !== undefined || root.state.status === "answered" || root.state.status === "cancelled");
}

/**
 * Closed records past their time leave the ledger for the month's archive beside it, in the
 * ledger's own line format. They used to be dropped; nothing here is deleted now.
 */
export function retireClosed(path: string, tasks: Map<string, Task>, cutoff: number, now: Date): number {
  const gone = [...tasks.values()].filter(task => closedLongEnough(task, cutoff));
  if (gone.length === 0) return 0;
  archiveSettled(path, gone.map(task => JSON.stringify({ kind: "task", task })), now);
  for (const task of gone) tasks.delete(task.id);
  return gone.length;
}
