/** Task execution custody has one rule, shared with context switching. */
import { contextTaskBlockers } from "./context-recovery.ts";
import type { Task } from "./tasks.ts";
import type { AgentBus } from "../agents/bus.ts";
export const taskHoldsAttention = (task: Task | undefined, conversation: string): boolean => !!task && contextTaskBlockers([task], conversation).length > 0;
export function taskAttentionChanged(bus: AgentBus, task: Task): void {
  const conversation = task.conversation ?? "main";
  if (!task.assigneeId || taskHoldsAttention(task, conversation) || bus.isActive(task.assigneeId, conversation)) return;
  const work = bus.workAttention?.get(task.assigneeId, conversation);
  if (work?.taskId !== task.id) return;
  bus.workAttention!.settle(work, "answered"); void bus.wake(task.assigneeId);
}

/** A task wake keeps its admitted work identity, including a cancelled one. */
export function taskWorkId(task: Task, bus: AgentBus): string | undefined {
  const focus=task.assigneeId?bus.workAttention?.get(task.assigneeId,task.conversation ?? "main"):undefined;
  return task.progress?.active?.workId ?? task.pursuit?.workId ?? (focus?.taskId===task.id?focus.id:undefined);
}
