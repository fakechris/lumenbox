/**
 * What a person said on work that waited on them, and that the member hears it (INV-1923).
 *
 * A member asks on its task: it parks the task with a request, or delivers a result for a look. The
 * person answers on the same task — a button on the card, a reply typed under it, "send back" with a
 * reason. Two things follow from that one write, and this file is their home.
 *
 * It reaches the member. On 2026-11-19 a result sent back from the page with a reason moved the task
 * to "doing" and started nothing: measured against the orchestrator with a scripted model, zero model
 * calls followed. The reason sat on the board and the member was never told its work was its own
 * again. So a person's word on a waiting task is delivered to the assignee, in the conversation the
 * work belongs to, and starts its turn (`watchPersonWord`).
 *
 * And it is the record. Once answered, the card is not left standing with a second message under it:
 * it is one line saying what was decided, by whom and when (`receiptOf`), read from the task's history
 * wherever the answer was given. Work nobody answered that the host ended has its line too.
 *
 * A word is what a person writes: not the assignee, not another agent, not the host keeping its books.
 * It grants nothing — the policy gate asks for what it holds on its own card.
 */
import { BOOKKEEPERS } from "./review-settle.ts";
import { splitAsk } from "./person-ask.ts";
import type { Task, TaskChange } from "./tasks.ts";

/** How a wait ended: the result accepted, sent back, the request answered, the work dropped, or ended by the host with nobody's word. */
export type ReceiptKind = "accepted" | "returned" | "answered" | "dropped" | "closed" | "lapsed";

/** One settled wait: what was asked, how it ended, who ended it, when, and what they said. */
export interface Receipt { what: ReceiptKind; title: string; by: string; at: string; text?: string }

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** Where the member last put the work in front of the person: its newest move to blocked or to review. */
function askedAt(task: Pick<Task, "history" | "assigneeId">): number {
  return task.history.findLastIndex(change => change.by === task.assigneeId && (change.status === "blocked" || change.status === "review"));
}

/** A change read as an answer to a wait, or undefined when it is not one. */
function answerIn(change: TaskChange, waited: string | undefined, task: Pick<Task, "assigneeId">, isAgent: (id: string) => boolean): ReceiptKind | undefined {
  if (change.closed !== undefined) return change.closed === "lapsed" ? "lapsed" : "closed";
  if (change.by === task.assigneeId || BOOKKEEPERS.has(change.by) || isAgent(change.by)) return undefined;
  if (change.status === "done") return "accepted";
  if (change.status === "dropped") return "dropped";
  if ((change.status === "doing" || change.status === "open") && waited === "review") return "returned";
  return change.status === undefined && (change.note ?? "").trim() !== "" ? "answered" : undefined;
}

/**
 * The line a settled card collapses to, or undefined while the work still waits unanswered or never
 * waited. It is about the newest wait only: a member that asks again has a card again, and the old
 * line gives way to it. The newest answer wins, so "answered, then sent back" reads as sent back.
 */
export function receiptOf(task: Pick<Task, "history" | "assigneeId" | "title">, isAgent: (id: string) => boolean = () => false): Receipt | undefined {
  return settlement(task, isAgent)?.receipt;
}

/** The receipt and which change it was read from. */
function settlement(task: Pick<Task, "history" | "assigneeId" | "title">, isAgent: (id: string) => boolean): { receipt: Receipt; index: number } | undefined {
  const from = askedAt(task);
  if (from < 0) return undefined;
  const asked = task.history[from]!;
  for (let index = task.history.length - 1; index > from; index--) {
    const change = task.history[index]!, what = answerIn(change, asked.status, task, isAgent);
    if (what === undefined) continue;
    const said = what === "closed" || what === "lapsed" ? "" : (change.note ?? "").trim();
    return { index, receipt: { what, title: splitAsk(asked.note).ask?.title ?? task.title, by: change.by, at: change.at, ...(said !== "" ? { text: clip(said, 600) } : {}) } };
  }
  return undefined;
}

/** What the member is told, in the host's voice: which work, what the person decided, and their words as they wrote them. */
export function personWordLine(task: Pick<Task, "id" | "title">, receipt: Receipt): string {
  const work = `${task.id} "${task.title}"`, read = `(Tasks read ${task.id})`;
  if (receipt.what !== "returned") return `[The person answered on ${work}, which waits on them:\n${receipt.text ?? ""}\nCarry on from their answer. ${read}]`;
  if (receipt.text === undefined) return `[The person looked at ${work} and sent it back to you without saying why. Ask them what to change if the result does not tell you. ${read}]`;
  return `[The person looked at ${work} and sent it back to you, saying:\n${receipt.text}\nIt is yours again: do what they say and deliver it again. ${read}]`;
}

/**
 * Delivers a person's word on waiting work to the member it is for, once per word.
 *
 * Two words are delivered: a result sent back (with or without a reason), and something written on
 * work that still waits — an answer to a request, a remark on a result. An acceptance, a drop and the
 * host's own endings need no turn. Unassigned work and a proposal have nobody to tell.
 */
export function watchPersonWord(
  store: { onChange(listener: (task: Task) => void): unknown },
  isAgent: (id: string) => boolean,
  deliver: (task: Task, text: string) => void
): void {
  const told = new Set<string>();
  store.onChange(task => {
    const found = settlement(task, isAgent);
    // Only the change just made: an answer already on the record when something else moves is not said again.
    if (found === undefined || found.index !== task.history.length - 1 || task.assigneeId === undefined || task.proposedBy !== undefined) return;
    if (found.receipt.what !== "returned" && found.receipt.what !== "answered") return;
    const key = `${task.id}#${found.index}`;
    if (told.has(key)) return;
    told.add(key);
    deliver(task, personWordLine(task, found.receipt));
  });
}
