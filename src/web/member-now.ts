/**
 * What a member says it is doing now, in its own words (INV-1926).
 *
 * The member row read "Working" or the member's job title, and a work row read a sentence from a
 * fixed table — a category, not this work. A member already says what it is doing, for anybody
 * watching: the step of its to-do list it marks `doing` (SetTodos; the prompt's "Work somebody can
 * watch" asks for exactly that). That step is the row's line. Nothing is added to what the member is
 * sent or asked: no model call, no tool, no prompt sentence. The language is the member's, which is
 * the conversation's.
 *
 * The line has to go stale honestly. A step written an hour ago by a member that has since stopped
 * would read as "doing" when nothing is. So the line is only said while a turn of that conversation is
 * running, and only while the list was written in the last NOW_FRESH_MS: a turn that has run longer
 * than that without touching its list falls back to the plain "working", which is still true.
 */
import { statSync } from "node:fs";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { workStateConversation } from "../agents/work-attention.ts";
import type { TodoItem } from "../host/durable.ts";

/** How long a step stays "now" after the list was last written. */
export const NOW_FRESH_MS = 15 * 60_000;
/** The longest line sent; the row cuts it shorter still, and shows the whole on hover. */
const NOW_MAX = 200;

/** The member's line, when it was written, the conversation it is about, and the work it is on there, if any. */
export interface MemberNow { text: string; at: string; conversation: string; taskId?: string }

/** The step a list marks as being done, while a turn is running and the list is fresh enough to still be true. */
export function nowOf(todos: readonly TodoItem[] | undefined, writtenAt: string | undefined, running: boolean, now: number): { text: string; at: string } | undefined {
  if (!running || todos === undefined || writtenAt === undefined || now - Date.parse(writtenAt) > NOW_FRESH_MS) return undefined;
  const step = todos.find(item => item.status === "doing" && item.text.trim() !== "")?.text.trim().replace(/\s+/g, " ");
  return step === undefined ? undefined : { text: step.length > NOW_MAX ? `${step.slice(0, NOW_MAX)}…` : step, at: writtenAt };
}

/** The member's newest line across the conversations it has a turn running in. */
export function memberNow(registry: AgentRegistry, bus: AgentBus, agentId: string, now = Date.now()): MemberNow | undefined {
  let best: MemberNow | undefined;
  for (const conversation of bus.activeConversationsOf(agentId)) {
    // The list lives where the work's state lives, as the plan the conversation shows does (work-attention.ts).
    const work = bus.workAttention?.get(agentId, conversation), key = workStateConversation(work, conversation);
    let at: string | undefined;
    try { at = statSync(registry.todosPathFor(agentId, key)).mtime.toISOString(); } catch { continue; } // no list: nothing said
    const line = nowOf(registry.readDurableState(agentId, key).todos, at, true, now);
    if (line !== undefined && (best === undefined || line.at > best.at)) best = { ...line, conversation, ...(work?.taskId ? { taskId: work.taskId } : {}) };
  }
  return best;
}
