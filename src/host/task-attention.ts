/** Task execution custody has one rule, shared with context switching. */
import { contextTaskBlockers } from "./context-recovery.ts";
import type { Task } from "./tasks.ts";
import type { AgentBus } from "../agents/bus.ts";
export const taskHoldsAttention = (task: Task | undefined, conversation: string): boolean => !!task && contextTaskBlockers([task], conversation).length > 0;
export function taskAttentionChanged(bus: AgentBus, task: Task): void {
  const conversation = task.conversation ?? "main";
  if (!task.assigneeId || taskHoldsAttention(task, conversation)) return;
  const work = bus.workAttention?.get(task.assigneeId, conversation);
  if (work?.taskId !== task.id) return;
  bus.workAttention!.settle(work, "answered"); void bus.wake(task.assigneeId);
}
