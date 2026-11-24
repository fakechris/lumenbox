/**
 * The approval gate as one person may see it (INV-2083).
 *
 * Authority lives on the box (docs/22): what waits on an agent, what was granted to it for good and
 * whether it is stopped are its box's business, so a person is shown them only for agents in boxes
 * they may enter. An admin's reach is the installation; `sees` says yes to everything for them, and
 * the caller decides that, not this module.
 */

import type { PolicyGate } from "../host/policy.ts";

type Gate = Pick<PolicyGate, "pending" | "standingGrants" | "tierShadow" | "isStopped">;

/** What `GET /api/policy` answers: every list cut to the agents `sees` admits. */
export function policyFor(gate: Gate, agentIds: readonly string[], sees: (agentId: string) => boolean) {
  return {
    pending: gate.pending().filter(item => sees(item.agentId)),
    standing: gate.standingGrants().filter(grant => sees(grant.agentId)),
    // What the side-effect tier gate would have asked about this week (INV-691), so a person can see
    // the cost of enforcing it before choosing to — of their own boxes' agents, like the rest.
    tierShadow: gate.tierShadow(7, sees),
    stopped: agentIds.filter(id => gate.isStopped(id) && sees(id)),
  };
}
