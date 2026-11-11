/** Display provenance is host-owned and never inferred from a task's title. */
import type { Task } from "./tasks.ts";
export interface TaskOrigin { kind: "user" | "internal"; workId?: string; parentId?: string }
export function taskAudience(task: Task, agentIds: ReadonlySet<string>, people?: ReadonlySet<string>): "user" | "subtask" | "internal" {
  if (task.origin?.parentId) return "subtask";
  if (task.origin) return task.origin.kind;
  // Old records have no provenance. Known agent requesters are not human requests;
  // keep them discoverable as internal/unlinked rather than guessing from prose.
  return agentIds.has(task.requester) ? "internal" : task.requester === "web" ? "user" : people && !people.has(task.requester) && !task.sourceMessageId ? "internal" : "user";
}
