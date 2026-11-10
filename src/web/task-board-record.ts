import { summarizeTaskProgress, type ProgressSourceAccess } from "../host/task-progress.ts";
/** Board previews contain no full history, fork ledger or configuration history. Open the task for those. */
import type { Task } from "../host/tasks.ts";
const preview = (text: string | undefined, limit: number) => text === undefined ? undefined : text.length > limit ? text.slice(0, limit) + "…" : text;
export function taskBoardRecord(task: Task, access?: ProgressSourceAccess) {
  const last = task.history.at(-1);
  return {
    progress: summarizeTaskProgress(task, 3, access),
    id: task.id, title: task.title, status: task.status, requester: task.requester,
    assigneeId: task.assigneeId, reviewerId: task.reviewerId, updatedAt: task.updatedAt, createdAt: task.createdAt,
    level: task.level, levelBy: task.levelBy, proposedBy: task.proposedBy,
    due: task.due, aging: task.aging, snoozeUntil: task.snoozeUntil, waitingOn: preview(task.waitingOn, 160),
    ...(task.discovery ? { discovery: { kind: task.discovery.kind, source: task.discovery.source, evidence: preview(task.discovery.evidence, 160), whyNow: preview(task.discovery.whyNow, 160) } } : {}),
    ...(task.closeProposal ? { closeProposal: { by: task.closeProposal.by, at: task.closeProposal.at, decideBy: task.closeProposal.decideBy, reason: preview(task.closeProposal.reason, 160) } } : {}),
    history: last ? [{ at: last.at, by: last.by, status: last.status, note: preview(last.note, 160) }] : [],
  };
}
