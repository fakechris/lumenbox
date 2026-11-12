/**
 * Ended internal records leave the board for an archive, when an operator says so (INV-1824).
 *
 * An installation that ran audits and probes between agents holds their cards long after they
 * ended: thousands of them, on no default surface, in the file every start replays. They are not
 * deleted. Each is appended to the month's archive beside the ledger (`tasks.2026-11.jsonl`), in
 * the ledger's own line format, and only then taken off the board — so a crash between the two
 * leaves a record twice, never nowhere, and bringing them back is reading those lines again.
 *
 * What stays: anything still live, anything a person asked for, a record that carries a work root
 * (the root is stored on it), and a record a live one still waits on or hangs under.
 */
import { readFileSync } from "node:fs";
import { archivePathFor, archiveSettled } from "./jsonl.ts";
import { isLive, type Task, type TaskStore } from "./tasks.ts";

type Audience = (task: Task) => string;

/** The records an archive would take, and the internal ones it would leave. */
export function archivable(tasks: readonly Task[], audience: Audience): { take: Task[]; live: number } {
  const needed = new Set<string>();
  for (const task of tasks) {
    if (!isLive(task.status)) continue;
    for (const id of task.blockedBy ?? []) needed.add(id);
    if (task.origin?.parentId !== undefined) needed.add(task.origin.parentId);
  }
  const internal = tasks.filter(task => audience(task) === "internal");
  return {
    take: internal.filter(task => !isLive(task.status) && task.workRoot === undefined && !needed.has(task.id)),
    live: internal.filter(task => isLive(task.status)).length,
  };
}

/** Archive first, checked on disk, then off the board. */
export function archiveEnded(store: TaskStore, audience: Audience, now: Date = new Date()): { archived: number; file?: string } {
  const { take } = archivable(store.list(), audience);
  if (store.path === null || take.length === 0) return { archived: 0 };
  const file = archiveSettled(store.path, take.map(task => JSON.stringify({ kind: "task", task })), now)!;
  const held = new Set(archivedTasks(file).map(task => task.id));
  const missing = take.filter(task => !held.has(task.id));
  if (missing.length > 0) throw new Error(`the archive ${file} does not hold ${missing.length} of the ${take.length} records written to it; nothing was taken off the board`);
  store.relocate(take.map(task => task.id), [], now);
  return { archived: take.length, file };
}

/** This month's archived records back on the board; one already there is left as it is. */
export function restoreArchived(store: TaskStore, now: Date = new Date()): { restored: number; file?: string } {
  if (store.path === null) return { restored: 0 };
  const file = archivePathFor(store.path, now);
  const latest = new Map(archivedTasks(file).map(task => [task.id, task]));
  const back = [...latest.values()].filter(task => store.get(task.id) === undefined);
  if (back.length > 0) store.relocate([], back, now);
  return { restored: back.length, file };
}

function archivedTasks(file: string): Task[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap(line => {
    try {
      const row = JSON.parse(line) as { kind?: string; task?: Task };
      return row.kind === "task" && typeof row.task?.id === "string" ? [row.task] : [];
    } catch {
      return [];
    }
  });
}
