/**
 * When a delivered result needs a person's word, and when it does not (INV-1904).
 *
 * On 2026-11-17 a card asked Chris to Accept or Request changes on an answer given in a Feishu
 * chat 27 days earlier. Nothing waited on it and there was no file to look at: the answer had
 * been read in the chat the day it was given. Every request a person made ended in review, and
 * review waited for the person, so every finished request became one more button to press. The
 * products this is measured against have no such step: the reply is the result, and "that is
 * wrong" in the conversation is how a person sends it back.
 *
 * So a person's request ends when its result is delivered, unless something gives their word a
 * consequence — the rows of `signOffReasons`. A result nobody answered for a week ends too, unless
 * other work waits on it. Neither ending is an acceptance: the change says `closed`, which
 * nothing counts as accepted work (docs/75), and the history says a person never looked. Silence
 * is still never consent (INV-532); it is the end of asking.
 */
import { envNumber } from "../config.ts";
import { dependencyView } from "./task-deps.ts";
import type { Task, TaskChange, TaskStore } from "./tasks.ts";

/** The harness actor that ends a review nobody needs to answer. */
export const SETTLE_ACTOR = "settle";
/** A review unanswered this long ends, unless other work waits on it. */
export const REVIEW_LAPSE_MS = envNumber("AGENTBOX_REVIEW_LAPSE_DAYS", 7) * 86_400_000;

/**
 * Why a person's word matters here:
 * - `blocks`: live work waits on this result, and would start on something nobody looked at;
 * - `files`: files were handed over, and a file is looked at before it is used;
 * - `asked`: the person asked to see the result before it counts (`Task.signOff`), or a person is named to review it;
 * - `undecided`: a check could not settle it and said a person decides;
 * - `remarked`: somebody wrote about the result after it was delivered — the 2026-11-02 note on
 *   that card said the result did not hold, and a closing would have buried it.
 */
export type SignOff = "blocks" | "files" | "asked" | "undecided" | "remarked";

/** Who writes notes to keep the books, not to say anything about the result. */
const BOOKKEEPERS: ReadonlySet<string> = new Set(["aging", "audit-guard", "review-guard", "restart", "host", "channel", SETTLE_ACTOR]);

/** The board as the rule reads it: a lookup and the whole list (task-deps.ts owns what waits on what). */
type Board = { get(id: string): Task | undefined; list(): Task[] };
const blocksAny = (task: Task, board: Board): boolean => (dependencyView(task, board).blocks ?? []).length > 0;

/** Where the newest move into review is in the history: a review change whose last status before it was not review. -1 when none is remembered. */
function deliveredAt(history: readonly TaskChange[]): number {
  let at = -1, before: string | undefined;
  history.forEach((change, index) => { if (change.status === undefined) return; if (change.status === "review" && before !== "review") at = index; before = change.status; });
  return at;
}

/** What happened since the result was last delivered: the changes after the newest move into review. */
function sinceDelivery(history: readonly TaskChange[]): TaskChange[] {
  const at = deliveredAt(history);
  return at < 0 ? [] : history.slice(at + 1);
}

/** What the page shows beside a result: why it waits for the person, only while it does. */
export function signOffView(task: Task, board: Board, isAgent: (id: string) => boolean): SignOff[] { return task.status === "review" ? signOffReasons(task, board, isAgent) : []; }

/** Every reason a person's word is needed on this result; empty when none is. */
export function signOffReasons(task: Task, board: Board, isAgent: (id: string) => boolean): SignOff[] {
  const reasons: SignOff[] = [];
  if (blocksAny(task, board)) reasons.push("blocks");
  if ((task.deliverables?.length ?? 0) > 0) reasons.push("files");
  if (task.signOff === true || task.reviewerId !== undefined && !isAgent(task.reviewerId)) reasons.push("asked");
  const since = sinceDelivery(task.history);
  if (since.some(change => change.decide === true) || task.history.at(-1)?.decide === true) reasons.push("undecided");
  if (since.some(change => change.note !== undefined && change.status === undefined && !BOOKKEEPERS.has(change.by) && change.by !== task.requester)) reasons.push("remarked");
  return reasons;
}

export interface SettleWorld {
  board: Board;
  /** Whether an id is an agent: an agent's own request is settled by the check record (review-dispatch.ts), not here. */
  isAgent: (id: string) => boolean;
  /** A check of this result is running or about to: it speaks first. */
  checking: (task: Task) => boolean;
}

/** Work this rule never ends: a goal closes by the person's word (INV-768), a proposal is not work yet. */
function outOfScope(task: Task, world: SettleWorld): boolean {
  return task.status !== "review" || task.pursuit !== undefined || task.goal !== undefined || task.proposedBy !== undefined || world.isAgent(task.requester) || world.checking(task);
}

/** A named agent reviewer that has not yet spoken on this delivery: its verdict comes before anything ends the work. */
function reviewerToCome(task: Task, isAgent: (id: string) => boolean): boolean {
  const reviewer = task.reviewerId;
  return reviewer !== undefined && isAgent(reviewer) && !sinceDelivery(task.history).some(change => change.by === reviewer || change.by === "review-guard" && change.status !== undefined);
}

/** The note that ends a delivered result nobody needs to answer, or undefined when it waits for a person. */
export function deliveredClose(task: Task, world: SettleWorld): string | undefined {
  if (outOfScope(task, world) || reviewerToCome(task, world.isAgent) || signOffReasons(task, world.board, world.isAgent).length > 0) return undefined;
  return "ended on delivery: nothing waits on it, no files were handed over, and nobody asked to see it first. Not accepted by a person — if it is wrong, say so and it reopens.";
}

/** When the result went into review, as far as the bounded history remembers. */
export function inReviewSince(task: Pick<Task, "history" | "createdAt">): number {
  const at = deliveredAt(task.history);
  return Date.parse(at >= 0 ? task.history[at]!.at : task.history[0]?.at ?? task.createdAt); // trimmed past it: the oldest change remembered
}

/** The note that ends a review nobody answered in time, or undefined while it should still ask. */
export function lapsedClose(task: Task, world: SettleWorld, now: Date): string | undefined {
  if (outOfScope(task, world) || blocksAny(task, world.board)) return undefined;
  if (task.snoozeUntil !== undefined && Date.parse(task.snoozeUntil) > now.getTime()) return undefined;
  const days = Math.floor((now.getTime() - inReviewSince(task)) / 86_400_000);
  if (now.getTime() - inReviewSince(task) < REVIEW_LAPSE_MS) return undefined;
  return `ended unreviewed: waited ${days} days for a look and nothing depends on it. Not accepted by a person — reopen it if it still matters.`;
}

/** Ends a delivered result nobody needs to answer; called a tick after each move into review, once the check listener has spoken. */
export function settleDelivered(board: TaskStore, id: string, world: SettleWorld): void {
  const task = board.get(id), note = task && deliveredClose(task, world);
  if (note) board.update(id, { status: "done", note, closed: "delivery" }, SETTLE_ACTOR);
}

/**
 * The sweep: every review that should not be waiting ends — delivered results nobody needs to answer
 * (those from before this rule, which never moved since), and reviews nobody answered in time.
 * One line per ended task, for the sweep's log.
 */
export function settleReviews(board: TaskStore, world: SettleWorld, now: Date): string[] {
  return board.list().flatMap(task => {
    const delivered = deliveredClose(task, world), note = delivered ?? lapsedClose(task, world, now);
    if (!note || board.update(task.id, { status: "done", note, closed: delivered ? "delivery" : "lapsed" }, SETTLE_ACTOR, undefined, now)?.coerced !== undefined) return [];
    return [`${task.id} "${task.title}" ${note}`];
  });
}
