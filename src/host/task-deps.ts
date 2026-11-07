/**
 * Dependencies between tasks (INV-1740): "t7 cannot start before t5 and t6 are finished".
 *
 * Before this, a dependency lived only inside one Orchestrate plan; on the board two tasks had no
 * relation, and `waitingOn` was a sentence. Now a task carries `blockedBy` — the ids of the tasks
 * it waits on — and three rules follow from it, all read off the board rather than remembered:
 *
 * - **Ready means nothing it waits on is open.** A blocker is open while it is live; once it is
 *   done or dropped (or let go by compaction, long after it closed) it no longer holds anything.
 *   A task with an open blocker is listed as "blocked by tN", cannot be taken or started, is not
 *   closed by its turn ending, and is not nudged for sitting still — waiting is what it should do.
 * - **No cycles.** A blocker that already waits, directly or not, on the task it would block is
 *   refused: a cycle is two tasks each ready only after the other, which is never.
 * - **Release wakes the one waiting.** When the last open blocker closes (or a person takes the
 *   last one off), the task's history says so and its assignee is woken in the task's
 *   conversation, the way a late fork result is (`bus.deliverSystem`).
 *
 * The other direction is a view: the live tasks waiting on a task are found by scanning, never
 * stored, so there is one record of each edge.
 */

import type { Task } from "./tasks.ts";

/** How many tasks one task may wait on: past this it is a plan, not a dependency. */
export const BLOCKERS_MAX = 20;

/** The actor that closes an Orchestrate plan's item cards (plan-cards.ts): the plan's result is the wake. */
export const PLAN_ACTOR = "plan";

type Lookup = { get(id: string): Task | undefined };
type Board = Lookup & { list(): Task[] };

const live = (task: Pick<Task, "status">): boolean => task.status !== "done" && task.status !== "dropped";

export type BlockerProblem = { code: "task-blocker-unknown" | "task-blocker-self" | "task-blocker-cycle"; vars: { task: string; path?: string } };

/** A blocker refused by the board, said in the words of the one who named it. */
export class BlockerError extends Error {
  constructor(readonly problem: BlockerProblem) {
    super(problem.code === "task-blocker-unknown"
      ? `No task ${problem.vars.task} to wait on.`
      : problem.code === "task-blocker-self"
        ? `${problem.vars.task} cannot wait on itself.`
        : `That would be a cycle (${problem.vars.path}): each task would be ready only after the other. Not changed.`);
    this.name = "BlockerError";
  }
}

/** Task ids from "t2, t3" or ["t2", "T3"]: trimmed, lower-cased, de-duplicated, at most BLOCKERS_MAX. Undefined when it is neither. */
export function parseBlockers(raw: unknown): string[] | undefined {
  const parts = typeof raw === "string" ? raw.split(/[\s,，、]+/) : Array.isArray(raw) ? raw.map(item => String(item)) : undefined;
  if (parts === undefined) return undefined;
  return [...new Set(parts.map(part => part.trim().toLowerCase()).filter(part => part !== ""))].slice(0, BLOCKERS_MAX);
}

/** Why these blockers cannot be set on task `id` (undefined for a task not created yet), or undefined when they can. */
export function blockerProblem(tasks: Lookup, id: string | undefined, ids: readonly string[]): BlockerProblem | undefined {
  for (const blocker of ids) {
    if (blocker === id) return { code: "task-blocker-self", vars: { task: blocker } };
    if (tasks.get(blocker) === undefined) return { code: "task-blocker-unknown", vars: { task: blocker } };
  }
  if (id === undefined) return undefined;
  // A cycle exists when `id` is reachable from one of its new blockers by following blockedBy.
  for (const blocker of ids) {
    const path = pathTo(tasks, blocker, id, new Set());
    if (path !== undefined) return { code: "task-blocker-cycle", vars: { task: blocker, path: [id, ...path].join(" → ") } };
  }
  return undefined;
}

function pathTo(tasks: Lookup, from: string, target: string, seen: Set<string>): string[] | undefined {
  if (from === target) return [from];
  if (seen.has(from)) return undefined;
  seen.add(from);
  for (const next of tasks.get(from)?.blockedBy ?? []) {
    const rest = pathTo(tasks, next, target, seen);
    if (rest !== undefined) return [from, ...rest];
  }
  return undefined;
}

/** Throws a BlockerError for an unknown task, the task itself, or a cycle. */
export function refuseBlockers(tasks: Lookup, id: string | undefined, ids: readonly string[]): void {
  const problem = blockerProblem(tasks, id, ids);
  if (problem !== undefined) throw new BlockerError(problem);
}

/** The blockers still live. One that no longer exists closed long enough ago to be let go, so it holds nothing. */
export function openBlockers(task: Pick<Task, "blockedBy"> | undefined, tasks: Lookup): string[] {
  return (task?.blockedBy ?? []).filter(id => { const blocker = tasks.get(id); return blocker !== undefined && live(blocker); });
}

/** Why a task may not be started now, or undefined when it is ready. */
export function notReady(task: Task, tasks: Lookup): string | undefined {
  const open = openBlockers(task, tasks);
  if (open.length === 0) return undefined;
  return `${task.id} is blocked by ${open.join(", ")}, which ${open.length === 1 ? "is" : "are"} not finished, so it has not started. ` +
    `Work on something ready; whoever it is assigned to is woken when the last of them closes.`;
}

/** The dependency part of a task's line: " · blocked by t2 (waiting on 1 of 2)", " · after t2, t3", or nothing. */
export function dependencyLine(task: Pick<Task, "blockedBy">, tasks: Lookup | undefined): string {
  const all = task.blockedBy ?? [];
  if (all.length === 0) return "";
  const open = tasks === undefined ? [] : openBlockers(task, tasks);
  return open.length > 0 ? ` · blocked by ${open.join(", ")} (waiting on ${open.length} of ${all.length})` : ` · after ${all.join(", ")}`;
}

/** What a card shows (INV-1740): each blocker with its status, and the live tasks waiting on this one. */
export function dependencyView(task: Task, board: Board): { blockers?: { id: string; status: string }[]; blocks?: string[] } {
  const blockers = (task.blockedBy ?? []).map(id => ({ id, status: board.get(id)?.status ?? "done" }));
  const blocks = board.list().filter(other => live(other) && other.blockedBy?.includes(task.id) === true).map(other => other.id).sort();
  return { ...(blockers.length > 0 ? { blockers } : {}), ...(blocks.length > 0 ? { blocks } : {}) };
}

/** Who closed a blocker: the actor of its last status change. */
function closedBy(task: Task | undefined): string | undefined {
  return task?.history.findLast(change => change.status !== undefined)?.by;
}

/**
 * Watches the board and releases what waits (INV-1740). On every change the changed task and the
 * tasks waiting on it are looked at again; one that had an open blocker and has none now is
 * released — a line in its history, and its assignee woken in the task's conversation.
 *
 * "Had an open blocker" is what the board looked like before the change: kept here, task by task,
 * from creation on.
 *
 * Not woken: a proposal (nobody may start it yet), a task nobody is assigned, and the parent of an
 * Orchestrate plan whose item cards the plan closed — the plan's one result message is its wake.
 */
export function watchDependencies(
  store: Board & {
    onChange(listener: (task: Task) => void): void;
    onCreate(listener: (task: Task) => void): void;
    update(id: string, changes: { note: string }, by: string): unknown;
  },
  wake: (task: Task, text: string) => void
): void {
  const waiting = new Set<string>();
  const look = (task: Task): void => { if (live(task) && openBlockers(task, store).length > 0) waiting.add(task.id); else waiting.delete(task.id); };
  for (const task of store.list()) look(task);
  store.onCreate(look);
  store.onChange(changed => {
    const dependents = store.list().filter(other => other.blockedBy?.includes(changed.id) === true);
    for (const candidate of [changed, ...dependents]) {
      if (!live(candidate) || openBlockers(candidate, store).length > 0) { look(candidate); continue; }
      if (!waiting.delete(candidate.id)) continue; // before the note below: the note is a change too
      const after = candidate.blockedBy ?? [];
      const text = after.length > 0
        ? `${candidate.id} "${candidate.title}" is ready: ${after.join(", ")} ${after.length === 1 ? "is" : "are"} finished.`
        : `${candidate.id} "${candidate.title}" is ready: it no longer waits on anything.`;
      store.update(candidate.id, { note: text }, "host");
      const planned = after.length > 0 && after.every(id => closedBy(store.get(id)) === PLAN_ACTOR);
      if (candidate.assigneeId === undefined || candidate.proposedBy !== undefined || planned) continue;
      wake(store.get(candidate.id) ?? candidate, `[${text} Nothing it waits on is open; pick it up now (Tasks read ${candidate.id}).]`);
    }
  });
}
