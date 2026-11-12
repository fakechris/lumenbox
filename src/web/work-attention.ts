/** The selected conversation reads its own work, never another background plan. */
import { workStateConversation } from "../agents/work-attention.ts";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";

export function conversationProgress(registry: AgentRegistry, bus: AgentBus, agent: string, conversation: string) {
  const work = bus.workAttention?.get(agent, conversation);
  return { ...registry.readDurableState(agent, workStateConversation(work, conversation)),
    attention: work ? { taskId: work.taskId, status: work.status, reason: work.reason, held: bus.heldCount(agent, conversation) } : undefined };
}
