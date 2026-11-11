import type { Task, TaskStore } from "./tasks.ts";
import { isDeliveryAction } from "./task-delivery.ts";
import type { WorkStamp } from "../agents/work-attention.ts";

export function reviewerInspectionRefusal(task: Task | undefined, by: string, tools: ReadonlySet<string> | undefined): string | undefined {
  return task?.reviewerId === by && task.assigneeId !== by && tools !== undefined && [...tools].every(tool => tool === "Tasks")
    ? `Not accepted: you are the reviewer of ${task.id} and this turn has checked nothing yet — no file read, no command run, no page opened. Inspect the work first, then accept or send it back with evidence.` : undefined;
}

export function deliveryTool(board: TaskStore, input: Record<string, unknown>, context: { agent: { id: string }; turnId?: string; toolsUsedThisTurn?: ReadonlySet<string>; callsThisTurn?: readonly string[]; work?: WorkStamp }) {
  if (!isDeliveryAction(input.action)) return { text: "Unknown delivery action.", isError: true };
  const id = String(input.id ?? ""), task = board.get(id);
  if (context.work && task?.workRoot && context.work.id !== task.workRoot.state.id) return { text: "This result belongs to another work request; use its own execution context.", isError: true };
  const refusal = input.action === "accept" ? reviewerInspectionRefusal(task, context.agent.id, context.toolsUsedThisTurn) : undefined;
  if (refusal) return { text: refusal, isError: true };
  const result = board.deliveryCommand(id, input.action, context.agent.id, {
    ...(typeof input.note === "string" ? { note: input.note } : {}),
    ...(Array.isArray(input.evidence) ? { evidence: input.evidence.filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof input.expected_version === "string" ? { expectedVersion: input.expected_version } : {}),
    ...(context.work && task?.workRoot?.state.id === context.work.id ? { generation: context.work.generation, epoch: context.work.epoch } : {}),
    ...(input.action === "accept" ? { checked: context.callsThisTurn?.filter(line => !line.startsWith("Tasks")).slice(-12) } : {}),
  }, context.turnId);
  if (!result) return { text: `No task ${id} on the board.`, isError: true };
  return { text: result.coerced ?? `${id}: ${input.action} ${result.outcome}; ${result.task.status}. Evidence version: ${result.task.delivery?.version ?? "unknown"}.`, ...(result.outcome === "refused" ? { isError: true } : {}) };
}
