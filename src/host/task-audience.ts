/** Display provenance is host-owned and never inferred from a task's title. */
import type { AgentRegistry } from "../agents/registry.ts";
import type { Task } from "./tasks.ts";
export interface TaskOrigin { kind: "user" | "internal"; workId?: string; parentId?: string; /** Made in a turn somebody asked for (INV-1844): set by the host, so a later wake for it keeps that standing. */ asked?: true }
export function taskAudience(task: Task, agentIds: ReadonlySet<string>, people?: ReadonlySet<string>): "user" | "subtask" | "internal" {
  if (task.origin?.parentId) return "subtask";
  if (task.origin) return task.origin.kind;
  // Old records have no provenance. Known agent requesters are not human requests;
  // keep them discoverable as internal/unlinked rather than guessing from prose.
  return agentIds.has(task.requester) ? "internal" : task.requester === "web" ? "user" : people && !people.has(task.requester) && !task.sourceMessageId ? "internal" : "user";
}

export function taskVisibilityNote(task: Task, creator: string, registry: AgentRegistry): string {
  const sharing = registry.boxOf(task.assigneeId ?? creator).members !== "everyone"
    ? " A task on this restricted box is not organisation-wide, even when assigned. For organisation-wide work, ask the user to open a separate task with an agent on a Shared box."
    : "";
  if (!task.assigneeId) return "Unassigned: other signed-in box members cannot see this agent-created task. "
    + "For an All work card, create standalone requested work (parent: none) and assign it to an agent in their box or take it yourself." + sharing;
  const audience = taskAudience(task, new Set([creator]));
  if (audience !== "user") return "This is not a standalone card in All work or its board. Members of the assignee’s box can find it by searching All work." + sharing;
  return "All work and its board show this card to members of the assignee’s box, not to people outside that box." + sharing;
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
