import type { AgentBus } from "../agents/bus.ts";
import type { RoutineReason } from "./routine-runs.ts";

type Attention = Pick<AgentBus, "workAttention">;

/**
 * Why a routine's turn cannot start in a conversation now (INV-2036): an earlier request there is
 * waiting, and nothing else is let into that conversation until it is answered or stopped.
 */
export function routineBlocked(bus: Attention, agentId: string, conversation: string, name: string): RoutineReason | undefined {
  const current = bus.workAttention?.get(agentId, conversation);
  if (current?.status !== "waiting") return undefined;
  const why = current.reason !== undefined ? ` (${current.reason})` : "";
  return { code: "member_busy", text: `${name} is waiting on an earlier request in this chat${why}; answer or stop it there, then run this again` };
}

/**
 * Read after the routine's prompt returned. Its message still queued means no turn ran: it is taken
 * back, so it cannot run hours later, and the run is failed with why rather than a 0-second Done.
 */
export function routineNotStarted(
  bus: Pick<AgentBus, "workAttention" | "dropAdmissionsWhere">,
  agentId: string,
  conversation: string,
  prompt: string,
  name: string
): { result: "failed"; reason: string } | undefined {
  const head = prompt.slice(0, 200);
  const unstarted = bus.dropAdmissionsWhere((at, message, owner) => owner === agentId && at === conversation && message.synthetic === true && message.text.startsWith(head));
  if (unstarted === 0) return undefined;
  const why = routineBlocked(bus, agentId, conversation, name)?.text ?? `${name} did not take it up (paused, or busy with other work)`;
  return { result: "failed", reason: `its turn did not start: ${why}` };
}
