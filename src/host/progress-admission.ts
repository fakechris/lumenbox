/** Progress authority is captured before durable admission; inbox recovery never calls this again. */
import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../agents/bus.ts";
import { admittedTaskBinding, type TaskBinding } from "./execution-binding.ts";
import type { TaskStore } from "./tasks.ts";
import type { ProgressContext } from "./task-progress.ts";

export function admitProgressMessage(tasks: TaskStore | undefined, agentId: string, message: InboundMessage): InboundMessage {
  if (!tasks) return message;
  const binding = admittedTaskBinding({ agentId, conversation: message.conversation ?? "main", inbound: [message], tasks, goal: message.goal, resume: message.resumeOf });
  if (!binding || binding.progressAdmission || message.resumeOf || binding.role === "child") return message;
  // A goal callback must carry the scope it observed, even if it only reaches the bus after a pause/resume.
  if (message.goal && !message.goal.progressScope) return message;
  const admission = tasks.progress.reserve(binding.taskId, message.goal?.workId ?? randomUUID(), message.goal ? message.goal.verify ? "verifier" : "continuation" : "new", message.goal?.progressScope);
  return admission ? { ...message, taskBinding: { ...binding, progressAdmission: admission } } : message;
}

export function progressContext(tasks: TaskStore | undefined, binding: TaskBinding | undefined, input: {
  agentId: string; conversation: string; turnId: string; executionId: string; boxId?: string; workId: string; resuming?: boolean;
}): ProgressContext | undefined {
  if (!tasks || !binding?.progressAdmission) return undefined;
  return tasks.progress.open({ ...input, taskId: binding.taskId, admission: binding.progressAdmission, role: binding.role,
    ...(binding.parent ? { sourceIdentity: binding.parent.forkId } : {}) });
}

/** Explicit selection may create progress authority only from a current turn, never an old callback. */
export function selectedProgressBinding(tasks: TaskStore | undefined, binding: TaskBinding, input: { workId: string; admittedAt: string }): TaskBinding {
  const task = tasks?.get(binding.taskId);
  if (!tasks || !task || (task.progress && Date.parse(task.progress.epochAt) > Date.parse(input.admittedAt))) return binding;
  const admission = tasks.progress.reserve(task.id, input.workId, "new");
  return admission ? { ...binding, progressAdmission: admission } : binding;
}
