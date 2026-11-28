/**
 * Answering an Outbox draft (INV-1739), for the page (outbox-routes.ts) and the client API (INV-2214):
 * the answer is written on the draft first (outbox-drafts.ts), then its consent record is settled
 * through the policy gate, which is what delivers it or tells the agent — the path a click on the
 * chat card takes.
 */

import type { Decision, Draft, OutboxDrafts } from "../host/outbox-drafts.ts";
import type { PolicyGate } from "../host/policy.ts";

export interface OutboxAnswerDeps {
  drafts: Pick<OutboxDrafts, "get" | "decide">;
  policy: Pick<PolicyGate, "pending" | "grant" | "deny">;
  /** Told once the consent record is settled, so the chat's copy of the card settles too. */
  answered?: (draft: Draft, how: "allowed" | "refused") => void;
}

export type OutboxAnswer = { ok: true; draft: Draft } | { ok: false; why: "unknown" | "settled" | "empty-body" | "no-reason" };

/** `by`: the name the draft is answered under; `decider`: who answered, as the consent record names them (`user:<person>`). */
export function answerDraft(deps: OutboxAnswerDeps, id: string, answer: Decision, by: string, decider: string): OutboxAnswer {
  const draft = deps.drafts.get(id);
  if (draft === undefined) return { ok: false, why: "unknown" };
  // A draft whose consent record is gone (expired, or answered from the chat a moment ago) is not this answer's to decide.
  if (draft.status !== "waiting" || !deps.policy.pending().some(approval => approval.id === draft.approvalId)) return { ok: false, why: "settled" };
  const decided = deps.drafts.decide(draft.id, answer, by);
  if (!decided.ok) return { ok: false, why: decided.why === "empty-body" ? "empty-body" : decided.why === "no-reason" ? "no-reason" : "settled" };
  if (answer.decision === "reject") deps.policy.deny(draft.approvalId, decider, answer.reason);
  else deps.policy.grant(draft.approvalId, decider, "once");
  deps.answered?.(draft, answer.decision === "reject" ? "refused" : "allowed");
  return { ok: true, draft: decided.draft };
}
