import {workRootSummary} from "../host/work-root-store.ts";
import { summarizeTaskProgress, type ProgressSourceAccess } from "../host/task-progress.ts";
/** Board previews contain no full history, fork ledger or configuration history. Open the task for those. */
import type { Task } from "../host/tasks.ts";
const preview = (text: string | undefined, limit: number) => text === undefined ? undefined : text.length > limit ? text.slice(0, limit) + "…" : text;
/** Who writes a note to keep the books rather than to say what was done. */
const BOOKKEEPERS: ReadonlySet<string> = new Set(["aging", "audit-guard", "review-guard", "restart", "host", "channel"]);
/** The newest thing somebody said about the work itself: what a person deciding on it needs to read. */
export function lastReport(task: Pick<Task, "history" | "createdAt">): { at: string; by: string; note: string } | undefined {
  // The entry written at creation is the board's own line about the card, under the requester's name.
  const said = task.history.findLast((change, index) => !BOOKKEEPERS.has(change.by) && !(index === 0 && change.at === task.createdAt) && (change.note ?? "").trim() !== "");
  return said ? { at: said.at, by: said.by, note: preview(said.note, 700)! } : undefined;
}
export function taskBoardRecord(task: Task, access?: ProgressSourceAccess) {
  const last = task.history.at(-1), report = lastReport(task);
  return {
    work:workRootSummary(task),
    progress: summarizeTaskProgress(task, 3, access),
    id: task.id, title: task.title, status: task.status, requester: task.requester,
    assigneeId: task.assigneeId, conversation: task.conversation, reviewerId: task.reviewerId, updatedAt: task.updatedAt, createdAt: task.createdAt,
    level: task.level, levelBy: task.levelBy, proposedBy: task.proposedBy,
    due: task.due, aging: task.aging, snoozeUntil: task.snoozeUntil, waitingOn: preview(task.waitingOn, 160),
    ...(task.discovery ? { discovery: { kind: task.discovery.kind, source: task.discovery.source, evidence: preview(task.discovery.evidence, 160), whyNow: preview(task.discovery.whyNow, 160) } } : {}),
    ...(task.closeProposal ? { closeProposal: { by: task.closeProposal.by, at: task.closeProposal.at, decideBy: task.closeProposal.decideBy, reason: preview(task.closeProposal.reason, 160) } } : {}),
    ...(report ? { report } : {}),
    history: last ? [{ at: last.at, by: last.by, status: last.status, note: preview(last.note, 160) }] : [],
  };
}
