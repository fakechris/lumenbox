/**
 * The Delegate tool acting on a session it already opened (docs/81): steer, cancel, close, or
 * the next brief. Out of tools.ts, which the architecture ratchet holds at its length
 * (INV-1225). The session must be this agent's; a session id someone else holds is not a handle.
 */
import type { ToolContext } from "./tools.ts";

export async function actOnDelegateSession(
  context: ToolContext,
  engine: string,
  input: Record<string, unknown>,
  prompt: string
): Promise<{ text: string; isError?: boolean }> {
  const sessions = context.acpDelegates;
  const sessionId = String(input.session_id);
  const held = sessions?.get(sessionId);
  if (sessions === undefined || held === undefined || held.agentId !== context.agent.id) {
    return { text: `${sessionId} is not an open delegate session of yours. Delegate with mode "session" opens one.`, isError: true };
  }
  try {
    if (input.close === true) {
      await sessions.close(sessionId);
      return { text: `${sessionId} closed.${held.inFlight !== undefined ? " The brief it was working on is recorded as stopped." : ""}` };
    }
    if (input.cancel === true) {
      const sent = await sessions.cancel(sessionId);
      return { text: sent ? `${sessionId}: cancel sent; the engine will confirm, and you will be told the brief was stopped.` : `${sessionId} has no brief in flight; nothing to cancel.` };
    }
    if (typeof input.steer === "string" && input.steer.trim() !== "") {
      const verdict = await sessions.steer(sessionId, input.steer.trim());
      if (verdict === "idle") {
        await sessions.continueWith(sessionId, input.steer.trim(), { engine: engine, ...(context.workId !== undefined ? { workId: context.workId } : {}), ...(context.turnId !== undefined ? { turnId: context.turnId } : {}) });
        return { text: `${sessionId} had no brief in flight, so the text went in as a new brief; you will be told when it finishes.` };
      }
      return { text: verdict === "delivered" ? `${sessionId}: the engine took the steer into its current brief. Taken is not followed — check what it does with it.` : `${sessionId}: that steer was already delivered; not sent twice.` };
    }
    if (prompt !== "") {
      await sessions.continueWith(sessionId, prompt, { engine: engine, ...(context.workId !== undefined ? { workId: context.workId } : {}), ...(context.turnId !== undefined ? { turnId: context.turnId } : {}) });
      return { text: `${sessionId}: next brief sent; you will be told when it finishes.` };
    }
    return { text: `With session_id, say what to do: prompt (the next brief), steer, cancel or close.`, isError: true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
