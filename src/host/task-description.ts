import type { Task } from "./tasks.ts";
import { dependencyLine } from "./task-deps.ts";
import { LEVEL_MEANING } from "./autonomy-level.ts";

/** One task as a line a model or a person reads. */
export function describeTask(task: Task, nameOf: (id: string) => string, board?: { get(id: string): Task | undefined }): string { // board: to say which blockers are still open (INV-1740)
  const assignee = task.assigneeId !== undefined ? ` @${nameOf(task.assigneeId)}` : " (unassigned)";
  const reviewer = task.reviewerId !== undefined ? ` · review by ${nameOf(task.reviewerId)}` : "";
  const proposed = task.proposedBy !== undefined ? " (proposed — a person commits it before anyone starts)" : "";
  const goal = task.goal !== undefined ? ` · goal (${task.goal.area}${task.goal.commitment !== undefined ? `: ${task.goal.commitment}` : ""})` : "";
  const pursuit = task.pursuit !== undefined ? ` · pursuing (${task.pursuit.status})` : ""; const level = task.level !== undefined ? ` · ${LEVEL_MEANING[task.level]}` : "";
  return `${task.id} [${task.status}]${assignee} ${task.title}${goal}${pursuit}${reviewer}${proposed}${level}${dependencyLine(task, board)}`;
}
