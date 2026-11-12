/** A card press continues its host-recorded work; UI text is never a new-work admission. */
import type { WorkAttention, WorkStamp } from "../agents/work-attention.ts";
import type { SurfaceLedger } from "./show-ui.ts";
import { parseActionText } from "./show-ui.ts";
import type { TaskStore } from "./tasks.ts";

export function surfaceActionWork(input: { action: unknown; text: string; agentId: string; conversation: string; surfaces: SurfaceLedger; focus?: WorkAttention; tasks?: TaskStore }): { work?: WorkStamp; taskBinding: { taskId: string; role: "executor" } } | { error: string } {
  const action = input.action as { surface?: unknown; name?: unknown } | null;
  const parsed = parseActionText(input.text);
  if (!action || typeof action.surface !== "string" || typeof action.name !== "string" || parsed?.surfaceId !== action.surface || parsed.name !== action.name) return { error: "The card action does not match its recorded surface." };
  const record = input.surfaces.get(input.agentId, input.conversation, action.surface), work = record?.work;
  const current = work && input.focus?.get(input.agentId, input.conversation);
  if (!work || !current || current.id !== work.id || current.generation !== work.generation || current.epoch !== work.epoch || current.unresolved || current.status === "cancelled" || input.focus?.cancelled(work.id) || work.owner !== input.agentId || work.conversation !== input.conversation) return { error: "The card's original work is missing, ended or changed. Return to the conversation to give a new instruction explicitly." };
  const task = work.taskId ? input.tasks?.get(work.taskId) : undefined;
  if (!task || task.status === "done" || task.status === "dropped" || task.workRoot?.state.id !== work.id || task.workRoot.cancellation) return { error: "The card's original work has ended or cannot be verified. The press did not create new work." };
  return { ...(input.focus!.valid(work, input.agentId) ? { work } : {}), taskBinding: { taskId: task.id, role: "executor" } };
}
