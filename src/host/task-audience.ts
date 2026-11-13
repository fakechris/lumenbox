/** Display provenance is host-owned and never inferred from a task's title. */
import type { Task } from "./tasks.ts";
export interface TaskOrigin { kind: "user" | "internal"; workId?: string; parentId?: string; /** Made in a turn somebody asked for (INV-1844): set by the host, so a later wake for it keeps that standing. */ asked?: true }
export function taskAudience(task: Task, agentIds: ReadonlySet<string>, people?: ReadonlySet<string>): "user" | "subtask" | "internal" {
  if (task.origin?.parentId) return "subtask";
  if (task.origin) return task.origin.kind;
  // Old records have no provenance. Known agent requesters are not human requests;
  // keep them discoverable as internal/unlinked rather than guessing from prose.
  return agentIds.has(task.requester) ? "internal" : task.requester === "web" ? "user" : people && !people.has(task.requester) && !task.sourceMessageId ? "internal" : "user";
}

/**
 * A request the agent answered in its own turn (INV-1822): the record of a chat exchange, kept so the
 * request can be found again, and never a card somebody has to look at. Anything that left a result to
 * inspect — a deliverable, a submission, a goal — is work, and stays on the list.
 */
export function answeredInChat(task: Pick<Task, "status" | "workRoot" | "pursuit" | "delivery" | "deliverables">): boolean {
  return task.status === "done"
    && task.workRoot?.automatic === true
    && task.pursuit === undefined
    && task.delivery === undefined
    && !task.deliverables?.length;
}
