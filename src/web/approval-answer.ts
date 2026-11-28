/**
 * Answering an approval, for the page (`POST /api/approve`, `/api/deny`) and the client API
 * (`POST /api/v1/approvals/{id}`, INV-2214): one path, so what a phone answers is recorded and
 * followed through exactly as a click on the page is.
 *
 * The gate records who answered (`decider`, auth.ts `deciderOf`: `user:<person>`, and for a device
 * `user:<person> device:<id>`), the page and the chat's card hear that it settled, and the agent is
 * told — unless the harness continues by itself (an extension's confirmation, INV-861) or the call
 * is parked and resumes on its own.
 */

import { MAIN_CONVERSATION } from "../agents/registry.ts";
import type { WorkStamp } from "../agents/work-attention.ts";
import { approvedCallNotice } from "../host/approval-notice.ts";
import type { PendingApproval, PolicyGate } from "../host/policy.ts";

export interface ApprovalAnswerDeps {
  policy: Pick<PolicyGate, "pending" | "grant" | "deny">;
  /** A call parked on this approval resumes by itself once it is answered. */
  parked(id: string): boolean;
  broadcast(event: { type: "approval_settled"; id: string; agentId: string; how: "allowed" | "refused"; scope?: "once" | "session" | "always" }): void;
  deliverSystem(agentId: string, text: string, conversation: string, work?: WorkStamp): void;
}

/** Allows or refuses the approval `id`. False when it is not waiting (answered already, expired, or never). */
export function answerApproval(deps: ApprovalAnswerDeps, input: { id: string; allow: boolean; scope: "once" | "session" | "always"; reason?: string | undefined; decider: string }): boolean {
  const waiting: PendingApproval | undefined = deps.policy.pending().find(item => item.id === input.id);
  const parked = deps.parked(input.id);
  const answered = input.allow ? deps.policy.grant(input.id, input.decider, input.scope) : deps.policy.deny(input.id, input.decider, input.reason);
  if (!answered) return false;
  // The answer reaches the agent as a message, so it goes on by itself. It used to sit until the person typed
  // something — the strip even said so — which read as the approval not having worked (docs/41 §4, 2026-09-08).
  if (waiting !== undefined) {
    deps.broadcast({ type: "approval_settled", id: input.id, agentId: waiting.agentId, how: input.allow ? "allowed" : "refused", ...(input.allow ? { scope: input.scope } : {}) });
    // An extension's confirmation is continued by the harness itself (INV-861): the agent hears the result from there,
    // and a "go ahead" here would send it to retry nothing.
    if (waiting.harnessResumes !== true && !parked) {
      deps.deliverSystem(
        waiting.agentId,
        input.allow ? approvedCallNotice(waiting.description, input.scope) : `[The person refused it: ${waiting.description}. Do not retry it; do without, or say what cannot be done.]`,
        waiting.returnTo?.conversation ?? MAIN_CONVERSATION, waiting.returnTo?.work,
      );
    }
  }
  return true;
}
