/** Host-owned task selection. Conversation activity and task titles are never identity (INV-1785). */
import type { InboundMessage } from "../agents/bus.ts";
import type { Task, TaskStore } from "./tasks.ts";
import type { GoalMarker } from "./goal-mode.ts";
import type { ResumeMarker } from "./resume.ts";

export interface TaskBinding {
  progressAdmission?: import("./task-progress.ts").ProgressAdmission;
  taskId: string;
  role: "executor" | "child" | "verifier";
  /** Set by the host when it admits a fork, never parsed from the child's text. */
  parent?: { conversation: string; turnId: string; workId: string; forkId: string };
  selection?: { turnId: string; toolUseId: string };
}

export function admittedTaskBinding(input: {
  agentId: string; conversation: string; inbound: readonly InboundMessage[];
  tasks?: TaskStore; goal?: GoalMarker; resume?: ResumeMarker;
}): TaskBinding | undefined {
  const { tasks, goal, resume } = input;
  if (!tasks) return undefined;
  const candidates: TaskBinding[] = [];
  if (resume?.taskBinding) candidates.push(resume.taskBinding);
  if (goal) candidates.push({ taskId: goal.taskId, role: goal.verify ? "verifier" : "executor" });
  for (const message of input.inbound) {
    if (message.taskBinding) candidates.push(message.taskBinding);
    else if(message.work?.taskId && message.work.owner===input.agentId && message.work.conversation===input.conversation) candidates.push({taskId:message.work.taskId,role:"executor"});
    // An admitted message's exact immutable id also proves its original task.
    for (const task of tasks.list()) if (task.sourceMessageId === message.id) candidates.push({ taskId: task.id, role: "executor" });
  }
  if (!candidates.length || new Set(candidates.map(b => b.taskId)).size !== 1) return undefined;
  const ordered = candidates.filter(binding => binding.progressAdmission).sort((a, b) => b.progressAdmission!.ordinal - a.progressAdmission!.ordinal);
  if (ordered.length > 1 && ordered[0]!.progressAdmission!.ordinal === ordered[1]!.progressAdmission!.ordinal && ordered[0]!.progressAdmission!.id !== ordered[1]!.progressAdmission!.id) return undefined;
  const binding = ordered[0] ?? candidates[0]!;
  const task = tasks.get(binding.taskId);
  if (!task || task.proposedBy !== undefined) return undefined;
  if (goal && task.pursuit?.workId !== goal.workId) return undefined;
  if (binding.role === "verifier") {
    const verifying = task.pursuit?.verifying;
    return goal?.verify && goal.taskId === task.id && task.pursuit?.workId === goal.workId &&
      task.pursuit.status === "verifying" && verifying?.conversation === input.conversation &&
      verifying.attempt === goal.verify.attempt && (verifying.agentId === undefined || verifying.agentId === input.agentId)
      ? binding : undefined;
  }
  if (task.assigneeId !== input.agentId) return undefined;
  const expectedConversation = binding.role === "child" ? binding.parent?.conversation : input.conversation;
  if (!resume?.taskBinding?.selection && (expectedConversation === undefined || (task.conversation ?? "main") !== expectedConversation)) return undefined;
  return binding;
}

export function hasAdmittedTask(input: { inbound: readonly InboundMessage[]; tasks?: TaskStore; goal?: GoalMarker; resume?: ResumeMarker }): boolean {
  return !!input.goal || !!input.resume?.taskBinding || input.inbound.some(message => !!message.taskBinding || !!message.work?.taskId || input.tasks?.list().some(task => task.sourceMessageId === message.id));
}

/** A successful board take is an explicit boundary; earlier calls keep their original selection. */
export function takenTaskBinding(input: {
  tool: string; args: unknown; isError?: boolean; agentId: string;
  tasks?: TaskStore;
}): TaskBinding | undefined {
  const args = input.args as { action?: unknown; id?: unknown } | null;
  if (input.isError || input.tool !== "Tasks" || args?.action !== "take" || typeof args.id !== "string") return undefined;
  const task: Task | undefined = input.tasks?.get(args.id);
  return task?.status === "doing" && task.assigneeId === input.agentId ? { taskId: task.id, role: "executor" } : undefined;
}
