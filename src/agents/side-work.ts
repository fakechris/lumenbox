/**
 * A colleague's errand, beside a person's work (docs/99 §5, INV-1824).
 *
 * A message from another agent that has nothing to do with the person's unfinished work used to be
 * held until that work ended — which, when the work was waiting for the person, could be days. It
 * now runs on a lane of its own, one at a time per agent, in a conversation that is not the person's.
 * Three rules keep the person first:
 *
 *   - it starts only while the person's work is waiting on something outside the agent — the person, an
 *     approval, a tool, a colleague's result — and none of their turns is running. Work that is between
 *     two slices of its own, or queued, is about to move: nothing starts beside it;
 *   - it never reads or writes the person's thread, plan or todo list;
 *   - when the person's work can move again it is interrupted, and tried again afterwards.
 *
 * What stays held: everything else. A routine's result, a goal that is not this work's, a note marked
 * informational — those are for the person's conversation, and they wait for it.
 */
import type { InboundMessage } from "./admitted-message.ts";
import type { WorkAttention } from "./work-attention.ts";
import { personMessage } from "./work-attention.ts";

/** The key side work serialises on. Never a conversation's name: nothing is written under it. */
export const SIDE_LANE = "\u0001side";
/** How often one message is tried again after the person interrupted it, before its sender is told it failed. */
export const SIDE_RETRIES = 3;

/** Model calls one errand without a host-issued work stamp may make: enough to answer a colleague, not to start a project on the person's budget. */
export const SIDE_CALLS = 12;

/** A side turn's budget: capped unless the host stamped the errand as part of somebody's work. */
export function sideTurnBudget<T extends { calls: number }>(inbound: readonly InboundMessage[], configured: T | undefined): T | undefined {
  const capped = configured !== undefined && inbound.some(message => message.side === true) && inbound.every(message => message.work === undefined);
  return capped ? { ...configured, calls: Math.min(configured.calls, SIDE_CALLS) } : configured;
}

/** What a side turn is told: whose work comes first, and what this turn is for. */
export const SIDE_TURN_NOTE = "\n\nThis turn answers a colleague while a person's own request to you waits elsewhere. That request has priority: this turn may be interrupted for it, and is tried again afterwards. Deal only with the colleague's message here. Do not work on, describe or change the person's request, and do not address the person.";

/** Whether this queued message is a colleague's errand that may run beside the person's waiting work. */
export function isSideWork(focus: WorkAttention | undefined, agentId: string, message: InboundMessage): boolean {
  if (focus === undefined || message.fromId === "user" || message.fromId === "system" || personMessage(message)) return false;
  if (message.lane !== undefined && message.lane !== "agent") return false;
  if (message.informational || message.goal !== undefined || message.resumeOf !== undefined || message.audit !== undefined) return false;
  const conversation = message.conversation ?? "main";
  // Something that may go where it was addressed goes there: a result the person's work is waiting for.
  if (focus.cancelledMessage(message) || focus.eligible(agentId, conversation, message)) return false;
  const held = focus.get(agentId, conversation);
  return held?.status === "waiting" && held.wait !== undefined && OUTSIDE_WAITS.has(held.wait);
}

/** Waits that end when somebody or something else acts. `execution` and `queue` end by the host's own next step. */
const OUTSIDE_WAITS: ReadonlySet<string> = new Set(["confirmation", "capability", "dependency", "plan", "focus", "interrupted"]);

/** The first sender's messages, in order: one colleague's errand per side turn. */
export function sideBatch(ready: readonly InboundMessage[]): InboundMessage[] {
  const first = ready[0];
  return first === undefined ? [] : ready.filter(message => message.fromId === first.fromId && message.work?.id === first.work?.id);
}
