/**
 * Whether anybody asked for the turn that is running (INV-1844).
 *
 * Between 2026-11-02 and 2026-11-10 the agents of one installation made 1,633 cards for themselves
 * and each other and a person made 39. About 660 million input tokens went in over the three days
 * with a usage record, and nothing was delivered to anyone. The audit dispatch that drove it has
 * since been closed three times over; what stayed open is the thing underneath it: a turn woken
 * only by a teammate or by the board, tracing to no request, could still put new work on the board
 * and wake others to do it.
 *
 * Work reaches an agent with standing in four ways: a person says it; a routine a person set fires;
 * the host continues either of those; or a teammate working on one of them asks, and the request's
 * standing travels with the message (`asked`, set by the host from the sending turn, never by the sender). A turn that none of those opened is unrequested. It is not
 * forbidden — an agent that notices something worth doing should say so — but what it wants done is
 * a proposal a person commits, never work it starts or hands out itself.
 *
 * This is deliberately not a count. A routine may run every day and a request may take a thousand
 * steps; neither is limited here. The only question asked is whether the work has a request behind it.
 */

import { SYSTEM_SENDER } from "../agents/bus.ts";

export function unrequestedTurn(
  inbound: readonly { fromId: string; asked?: true }[],
  /** The request's stamp, when the turn carries one: it descends from a person's message by construction. */
  work: unknown,
  personOpened: boolean,
  agents: { tryGet(id: string): unknown }
): boolean {
  if (personOpened || work !== undefined || inbound.length === 0 || inbound.some(message => message.asked === true)) return false;
  // A routine, a webhook, a job notice and the host's other prompts arrive as the harness speaking in the person's
  // place, and are not from an agent or the board: they keep their standing.
  return inbound.every(message => message.fromId === SYSTEM_SENDER || agents.tryGet(message.fromId) !== undefined);
}

/** What an agent is told when a card it made in an unrequested turn was filed as a proposal. */
export const PROPOSED_INSTEAD =
  "Filed as a proposal, not as work: nothing in this turn traces to a person's request, so a person commits it before anyone starts. Do not do it or hand it out yourself.";
