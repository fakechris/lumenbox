/**
 * One list on the Tasks panel (INV-1654): what waits on a person is a mark on the task's own
 * row, first in the list, not a second list above the board that said the same thing again.
 *
 * The attention items that are not tasks — a consent, a question, a paused agent — have no row
 * to sit on; they stay in the small panel above the board, and only they.
 *
 * Written once as plain functions and shipped to the page as its own source (`BOARD_ORDER_JS`),
 * so the test and the page run the same merge.
 */

export interface BoardItem {
  ref: string;
  kind: string;
  detail: string;
  deadline?: string;
  decision?: boolean;
}

export interface BoardTask {
  id: string;
  status: string;
  updatedAt: string;
}

export interface BoardRow<T extends BoardTask> {
  task: T;
  /** What the person owes on this task, when something. */
  mine?: BoardItem;
  /** What another agent is waiting for on it, when something and nothing is owed by the person. */
  theirs?: BoardItem;
}

/** A task id, as the board writes them: a row exists for it. Anything else is an approval, a question, a pause. */
export function isTaskRef(ref: string): boolean {
  return /^t\d+$/.test(ref);
}

/** The items with no task row: the panel above the board shows exactly these. */
export function looseItems<I extends BoardItem>(items: readonly I[]): I[] {
  return items.filter(item => !isTaskRef(item.ref));
}

/**
 * Every task once, with its attention item on it. Rows the person owes something on come first:
 * a decision, then a review, then a nudge; within those the nearest deadline first. Then the
 * board's own order: live statuses before closed ones, newest change first within a status.
 */
export function boardOrder<T extends BoardTask, I extends BoardItem>(tasks: readonly T[], mine: readonly I[], theirs: readonly I[]): BoardRow<T>[] {
  const order: Record<string, number> = { open: 0, doing: 1, blocked: 2, review: 3, done: 4, dropped: 5 };
  const byRef = (items: readonly I[]): Map<string, I> => new Map(items.map(item => [item.ref, item]));
  const owed = byRef(mine), waited = byRef(theirs);
  const rows: BoardRow<T>[] = tasks.map(task => {
    const m = owed.get(task.id), t = waited.get(task.id);
    return { task, ...(m !== undefined ? { mine: m } : {}), ...(m === undefined && t !== undefined ? { theirs: t } : {}) };
  });
  const due = (row: BoardRow<T>): string => (row.mine && row.mine.deadline) || "9999";
  const urgency = (row: BoardRow<T>): number => (row.mine === undefined ? 3 : row.mine.decision ? 0 : row.mine.kind === "review" ? 1 : 2);
  return rows.sort((a, b) =>
    urgency(a) - urgency(b) ||
    (a.mine ? (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0) : 0) ||
    ((order[a.task.status] ?? 9) - (order[b.task.status] ?? 9)) ||
    (b.task.updatedAt > a.task.updatedAt ? 1 : b.task.updatedAt < a.task.updatedAt ? -1 : 0));
}

/** The page's copy: the functions above, verbatim, as a classic script. */
export const BOARD_ORDER_JS = `${isTaskRef.toString()}\n${looseItems.toString()}\n${boardOrder.toString()}\n`;
