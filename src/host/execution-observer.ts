import { randomUUID } from "node:crypto";
import type { TurnEvent } from "./turn-events.ts";
import type { TurnLedger } from "./resume.ts";
import type { TaskBinding } from "./execution-binding.ts";
import { dispatchTool, type ToolContext, type ToolOutcome } from "./tools.ts";

export interface ExecutionContext {
  turnId: string; executionId: string; attempt: number; workId: string;
  agentId: string; boxId: string; conversation: string; contextEpoch: number;
  taskBinding?: TaskBinding;
}

/** One write boundary for text-free call metadata; the transcript remains the result source. */
export function observeExecution(event: TurnEvent, context: ExecutionContext, ledger?: TurnLedger): TurnEvent {
  const taskBinding = "taskBinding" in event ? event.taskBinding : context.taskBinding;
  const stamped: TurnEvent = { ...event, turnId: context.turnId, executionId: context.executionId,
    turnAttempt: context.attempt, workId: context.workId, conversation: context.conversation,
    ...(taskBinding ? { taskId: taskBinding.taskId, taskBinding } : {}) };
  if ((event.type === "tool_start" || event.type === "tool_end") && event.toolUseId) {
    ledger?.observeExecution({ event: "step", id: context.turnId, recordId: randomUUID(),
      executionId: context.executionId, attempt: context.attempt, workId: context.workId,
      agentId: context.agentId, boxId: context.boxId, conversation: context.conversation,
      contextEpoch: context.contextEpoch, ...(taskBinding ? { taskBinding } : {}),
      toolUseId: event.toolUseId, tool: event.tool, phase: event.type === "tool_start" ? "start" : "end",
      ...(event.type === "tool_end" ? { isError: event.isError === true, ...(event.executionOutcome ? { outcome: event.executionOutcome } : {}), ...(event.gate ? { gate: event.gate } : {}) } : {}), at: new Date().toISOString() });
  }
  if (event.type === "compacted" || event.type === "retrying") {
    ledger?.observeMaintenance({ event: "maintenance", id: context.turnId, recordId: randomUUID(), executionId: context.executionId,
      attempt: context.attempt, workId: context.workId, agentId: context.agentId, boxId: context.boxId,
      conversation: context.conversation, contextEpoch: context.contextEpoch, ...(taskBinding ? { taskBinding } : {}),
      kind: event.type, at: new Date().toISOString(),
      ...(event.type === "compacted" ? { covers: event.covers, summarised: event.summarised }
        : { delayMs: event.delayMs, retryAttempt: event.attempt }) });
  }
  return stamped;
}

/** Recovery dispatches are real attempts too, even when they reuse a logical turn/call id. */
export async function observedReplay(name: string, input: Record<string, unknown>, context: ToolContext,
  emit: (event: TurnEvent) => void): Promise<ToolOutcome> {
  const base = { agentId: context.agent.id, agentName: context.agent.profile.name, tool: name,
    toolUseId: context.toolUseId, taskBinding: context.taskBinding };
  emit({ ...base, type: "tool_start", input });
  const outcome = await dispatchTool(name, input, context);
  emit({ ...base, type: "tool_end", summary: outcome.text.split("\n")[0]?.slice(0, 200) ?? "", isError: outcome.isError === true, executionOutcome: outcome.approval ? "waiting" : outcome.outcome ?? (outcome.isError ? "failed" : "ok") });
  return outcome;
}
