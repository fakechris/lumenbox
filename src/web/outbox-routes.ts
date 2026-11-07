/**
 * The Outbox on the page (INV-1739): a person approves a draft as written, edits and approves it,
 * or rejects it with a reason. The answer is written on the draft first (outbox-drafts.ts), then
 * its consent record is settled through the policy gate, which is what delivers it or tells the
 * agent — the same path a click on the chat card takes.
 */

import type { Decision, Draft, OutboxDrafts } from "../host/outbox-drafts.ts";
import type { PolicyGate } from "../host/policy.ts";
import { apiError } from "./api-error.ts";

export async function outboxRoute(
  route: string,
  deps: {
    drafts: Pick<OutboxDrafts, "get" | "decide" | "waiting">;
    policy: Pick<PolicyGate, "pending" | "grant" | "deny">;
    readJson: () => Promise<Record<string, unknown>>;
    /** Whether this caller may answer for the agent that drafted it; driving, like any consent. */
    mayAnswer: (agentId: string) => boolean;
    /** Told once the consent record is settled, so the chat's copy of the card settles too. */
    answered?: (draft: Draft, how: "allowed" | "refused") => void;
    by: () => string;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/outbox") return { status: 200, body: { drafts: deps.drafts.waiting().filter(draft => deps.mayAnswer(draft.agentId)) } };
  if (route !== "POST /api/outbox/decide") return undefined;
  const body = await deps.readJson();
  const draft = deps.drafts.get(String(body.id ?? ""));
  if (draft === undefined || !deps.mayAnswer(draft.agentId)) return { status: 404, body: apiError("outbox-unknown") };
  const answer: Decision | undefined =
    body.decision === "approve" ? { decision: "approve" }
      : body.decision === "edit" ? { decision: "edit", body: String(body.body ?? "") }
        : body.decision === "reject" ? { decision: "reject", reason: String(body.reason ?? "") }
          : undefined;
  if (answer === undefined) return { status: 400, body: apiError("outbox-decision") };
  // A draft whose consent record is gone (expired, or answered from the chat a moment ago) is not the page's to decide.
  if (draft.status !== "waiting" || !deps.policy.pending().some(approval => approval.id === draft.approvalId)) return { status: 409, body: apiError("outbox-settled") };
  const decided = deps.drafts.decide(draft.id, answer, deps.by());
  if (!decided.ok) return { status: decided.why === "settled" ? 409 : 400, body: apiError(decided.why === "empty-body" ? "outbox-empty-body" : decided.why === "no-reason" ? "outbox-no-reason" : "outbox-settled") };
  if (answer.decision === "reject") deps.policy.deny(draft.approvalId, "user", answer.reason);
  else deps.policy.grant(draft.approvalId, "user", "once");
  deps.answered?.(draft, answer.decision === "reject" ? "refused" : "allowed");
  return { status: 200, body: { id: draft.id, status: decided.draft.status } };
}
