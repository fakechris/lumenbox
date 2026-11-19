import {workRootSummary} from "../host/work-root-store.ts";
import { summarizeTaskProgress, type ProgressSourceAccess } from "../host/task-progress.ts";
/** Board previews contain no full history, fork ledger or configuration history. Open the task for those. */
import type { Task } from "../host/tasks.ts";
import { type DeliveryPart, parseDelivery } from "../host/delivery-report.ts";
import { askOf, splitAsk } from "../host/person-ask.ts";
const preview = (text: string | undefined, limit: number) => text === undefined ? undefined : text.length > limit ? text.slice(0, limit) + "…" : text;
/** Who writes a note to keep the books rather than to say what was done. */
const BOOKKEEPERS: ReadonlySet<string> = new Set(["aging", "audit-guard", "review-guard", "restart", "host", "channel"]);
/**
 * The newest thing somebody said about the work itself: what a person deciding on it needs to read.
 * Written as a delivery (delivery-report.ts), it comes with its parts, read from the whole note before
 * anything is cut: the part that says what was not done stands last but one, and a cut note loses it first.
 * A request to the person written in the same note is the row's `ask`, shown as the card (person-ask.ts): the
 * note here is what is left without it, so nothing is said twice.
 */
export function lastReport(task: Pick<Task, "history" | "createdAt">, limit = 700): { at: string; by: string; note: string; parts?: DeliveryPart[] } | undefined {
  // The entry written at creation is the board's own line about the card, under the requester's name.
  const said = task.history.findLast((change, index) => !BOOKKEEPERS.has(change.by) && !(index === 0 && change.at === task.createdAt) && (change.note ?? "").trim() !== "");
  const parts = parseDelivery(said?.note)?.parts.map(part => ({ key: part.key, text: preview(part.text, Math.ceil(limit / 2))! }));
  return said ? { at: said.at, by: said.by, note: preview(splitAsk(said.note).rest, limit)!, ...(parts ? { parts } : {}) } : undefined;
}
export function taskBoardRecord(task: Task, access?: ProgressSourceAccess) {
  const last = task.history.at(-1), report = lastReport(task), ask = askOf(task);
  return {
    work:workRootSummary(task),
    progress: summarizeTaskProgress(task, 3, access),
    id: task.id, title: task.title, status: task.status, requester: task.requester,
    assigneeId: task.assigneeId, conversation: task.conversation, reviewerId: task.reviewerId, updatedAt: task.updatedAt, createdAt: task.createdAt,
    level: task.level, levelBy: task.levelBy, proposedBy: task.proposedBy,
    due: task.due, aging: task.aging, snoozeUntil: task.snoozeUntil, waitingOn: preview(task.waitingOn, 160),
    ...(task.discovery ? { discovery: { kind: task.discovery.kind, source: task.discovery.source, evidence: preview(task.discovery.evidence, 160), whyNow: preview(task.discovery.whyNow, 160) } } : {}),
    ...(task.closeProposal ? { closeProposal: { by: task.closeProposal.by, at: task.closeProposal.at, decideBy: task.closeProposal.decideBy, reason: preview(task.closeProposal.reason, 160) } } : {}),
    ...(report ? { report } : {}), ...(ask ? { ask } : {}),
    // What was handed over, by name: the card lists the files and opens them where it stands (INV-1923).
    ...(task.deliverables?.length ? { deliverables: task.deliverables.map(file => ({ id: file.id, name: file.name, note: file.note, size: file.size })) } : {}),
    history: last ? [{ at: last.at, by: last.by, status: last.status, note: preview(last.note, 160), ...(last.options?.length ? { options: last.options } : {}) }] : [],
  };
}
