/**
 * An ordinary request that does not fit in one turn's budget (INV-1823).
 *
 * The long-run work (INV-1776) made a goal cross turn budgets, survive compaction, lost receipts and
 * restarts — and left it behind `/goal`, which the app's own chat refuses. Somebody who simply typed a
 * big task got sixty model calls and a hand-back. This is the missing door: when a person's request
 * reaches the turn budget having done real work, the host gives its task a pursuit that completes by
 * answering, and the continuation loop that already exists carries it — with the same stops for
 * spinning, repeating, a count of slices and active time.
 *
 * One function, called from the turn at the budget line. It decides; the loop does the rest.
 */
import { DEFAULT_PURSUIT_LIMITS, newPursuit } from "./goal-mode.ts";
import type { TaskStore } from "./tasks.ts";

export interface LongRequestLimits { continuations: number; activeMs: number }

/**
 * How much the installation is willing to put into one request before the host stops carrying it (INV-1844).
 *
 * One rough choice instead of numbers to fill in. Chris, 2026-11-13: a person's control over spend comes
 * down to how they pay and one preference, and beyond that the agent should judge for itself whether the
 * work is worth continuing rather than ask. `standard` is what the installation did before the choice existed.
 */
export type Effort = "lean" | "standard" | "open";
export const EFFORT_LIMITS: Record<Effort, LongRequestLimits> = {
  lean: { continuations: 8, activeMs: 4 * 3_600_000 },
  standard: { ...DEFAULT_PURSUIT_LIMITS },
  open: { continuations: 120, activeMs: 48 * 3_600_000 },
};
export const effortOf = (value: unknown): Effort => (value === "lean" || value === "open" ? value : "standard");

/** The ceiling for anything the host continues unattended: the level's, unless somebody wrote numbers of their own. */
export function longRequestLimits(configured?: { continuations?: unknown; activeHours?: unknown }, effort?: unknown): LongRequestLimits {
  // A setting that is not a whole number in range is ignored, not guessed at: 0 slices turns continuation off.
  const whole = (value: unknown, min: number, max: number): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  const hours = whole(configured?.activeHours, 1, 168);
  return {
    continuations: whole(configured?.continuations, 0, 1000) ?? EFFORT_LIMITS[effortOf(effort)].continuations,
    activeMs: hours !== undefined ? hours * 3_600_000 : EFFORT_LIMITS[effortOf(effort)].activeMs,
  };
}

export interface BudgetSlice {
  /** The task the request was admitted under. */
  taskId?: string;
  workId: string;
  agentId: string;
  conversation: string;
  /** Whether any tool that is work ran in the slice. A slice that only talked is not continued. */
  worked: boolean;
}

/** True when the host will continue this request itself; the turn then says so instead of handing back. */
export function continueAcrossBudget(tasks: TaskStore, slice: BudgetSlice, limits: LongRequestLimits): boolean {
  const task = slice.taskId === undefined ? undefined : tasks.get(slice.taskId);
  if (task === undefined || !slice.worked || limits.continuations <= 0) return false;
  // Only a request the host itself recorded for this agent in this conversation: a card somebody
  // made by hand, a subtask or an internal record keeps the hand-back it always had.
  const root = task.workRoot;
  if (root?.automatic !== true || root.state.id !== slice.workId || root.cancellation !== undefined) return false;
  if (task.assigneeId !== slice.agentId || (task.conversation ?? "main") !== slice.conversation) return false;

  if (task.pursuit === undefined) {
    const pursuit = newPursuit({ objective: task.description ?? task.title, workId: slice.workId, completion: "answer", limits });
    return tasks.setPursuit(task.id, current => current, "the request reached its turn budget with work done; the host continues it", undefined, undefined, pursuit) !== undefined;
  }
  // A request that was answered, taken up again by the person, and ran long a second time: the same
  // allowance, not a fresh one.
  const pursuit = task.pursuit;
  if (pursuit.completion !== "answer" || pursuit.status !== "complete") return false;
  if (pursuit.spent.continuations >= pursuit.limits.continuations || pursuit.spent.activeMs >= pursuit.limits.activeMs) return false;
  return tasks.setPursuit(task.id, current => ({ ...current, status: "active" }), "taken up again and reached its turn budget; the host continues it") !== undefined;
}
