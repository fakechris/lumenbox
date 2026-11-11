/** Task execution custody has one rule, shared with context switching. */
import { contextTaskBlockers } from "./context-recovery.ts";
import type { Task } from "./tasks.ts";
import type { AgentBus } from "../agents/bus.ts";
export const taskHoldsAttention = (task: Task | undefined, conversation: string): boolean => !!task && !(task.workRoot?.automatic && !task.pursuit && !task.blockedBy?.length && (task.status==="open" || task.status==="doing")) && contextTaskBlockers([task], conversation).length > 0;
export function taskAttentionChanged(bus: AgentBus, task: Task): void {
  if(task.workRoot?.automatic && !task.pursuit)return; // Execution lifecycle is owned by the root transitions, not inferred from the board.
  const conversation = task.conversation ?? "main";
  if (!task.assigneeId || taskHoldsAttention(task, conversation) || bus.isActive(task.assigneeId, conversation)) return;
  const work = bus.workAttention?.get(task.assigneeId, conversation);
  if (work?.taskId !== task.id) return;
  bus.workAttention!.settle(work, "answered"); void bus.wake(task.assigneeId);
}

/** A task wake keeps its admitted work identity, including a cancelled one. */
export function taskWorkId(task: Task, bus: AgentBus): string | undefined {
  return task.workRoot?.state.id ?? task.pursuit?.workId ?? task.progress?.active?.workId;
}
