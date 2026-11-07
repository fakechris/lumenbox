/**
 * CorrectOrgKnowledge (INV-1730, docs/98 §7): an agent applies a correction verb to an organisation
 * item, for the person its turn is for.
 *
 * - **unverify** — anyone who may read the item: it leaves recall, stays citable by id, and its
 *   owner is told. Only takes trust away, so it asks nobody.
 * - **retract** and **supersede** — only when the turn is for the item's owner or an Admin, and
 *   only after that person says yes on the consent card: they change what every reader of the
 *   item is told, and an agent proposes L1 but never decides it alone (docs/98 §5 rule 2).
 *
 * The verbs themselves, their permissions and the lines they write are org-knowledge.ts's; this
 * is the door.
 */

import type { ToolContext } from "./tools.ts";

export const ORG_CORRECTION_TOOL = "CorrectOrgKnowledge";

export function withOrgCorrectionTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: ORG_CORRECTION_TOOL,
    description:
      "Correct an item of the organisation's knowledge, cited by its id (org:…). Nothing is edited or deleted: each verb is a new line in its history. " +
      "unverify — you or the person doubt it: it stops being recalled on its own (still readable by id) and its owner is told; anyone who can read it may do this. " +
      "supersede — replace it with what is true now (text, and evidence such as task:, inv:, commit:, doc:); retract — withdraw it. " +
      "Those two need the turn to be for the item's owner or an Admin, and that person approves on a card first.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["unverify", "supersede", "retract"] },
        id: { type: "string", description: "The item's id, org: and twelve hex characters, as cited in the prompt or by Recall." },
        reason: { type: "string", description: "Why, in one line. Required for unverify and retract; the owner reads it." },
        text: { type: "string", description: "supersede only: the replacing statement, one line." },
        evidence: { type: "array", items: { type: "string" }, description: "supersede only: references the new statement rests on." },
      },
      required: ["action", "id"],
    },
  } as never);
}

export function runOrgCorrectionTool(context: ToolContext, input: Record<string, unknown>): { text: string; isError?: boolean; approval?: { id: string } } {
  const ledger = context.orgKnowledge;
  if (ledger === undefined) return { text: "Outcome: refused — this turn reads no organisation knowledge, so there is nothing to correct.", isError: true };
  const action = String(input.action ?? "");
  const id = String(input.id ?? "").trim();
  const reason = String(input.reason ?? "");
  if (!/^org:[0-9a-f]{12}$/.test(id)) return { text: "Outcome: refused — id is the item's id, org: and twelve hex characters.", isError: true };
  const who = { principalId: context.caller?.userId, agentId: context.agent.id };
  if (action === "retract" || action === "supersede") {
    if (context.policy === undefined) return { text: `Outcome: refused — ${action} changes what every reader is told, and there is no one here to approve it.`, isError: true };
    const decision = context.policy.check({
      kind: "tool",
      agentId: context.agent.id,
      agentName: context.agent.profile.name,
      tool: ORG_CORRECTION_TOOL,
      input,
      irreversible: action === "retract" ? `withdraw ${id} from the organisation's knowledge, for every reader` : `replace ${id} in the organisation's knowledge, for every reader`,
      ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
      principalId: context.caller?.userId,
    });
    if (!decision.allow) return { text: `Outcome: refused — ${decision.reason}`, isError: true, ...(decision.approval !== undefined ? { approval: { id: decision.approval.id } } : {}) };
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence.map(String) : [];
  const result = action === "unverify" ? ledger.unverify(id, who, reason)
    : action === "retract" ? ledger.retract(id, who, reason)
      : action === "supersede" ? ledger.supersede(id, who, String(input.text ?? ""), evidence)
        : undefined;
  if (result === undefined) return { text: "Outcome: refused — action is unverify, supersede or retract.", isError: true };
  if (!result.ok) return { text: `Outcome: refused — ${result.why}`, isError: true };
  if (action === "unverify") return { text: `Outcome: ok. ${id} is marked unverified: it is no longer recalled on its own, stays citable by id, and its owner is told.` };
  if (action === "retract") return { text: `Outcome: ok. ${id} is retracted; it stays in the history, read by id as retracted.` };
  return { text: `Outcome: ok. ${result.view.id} supersedes ${id}; a citation of ${id} now points to it.` };
}
