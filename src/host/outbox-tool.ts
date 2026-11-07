/**
 * Outbox (INV-1739): an agent puts a message or an outward step in front of the person instead of
 * doing it. The draft and what becomes of it are outbox-drafts.ts's; the person's answer is a
 * consent record (policy.ts `requestConfirmation`), so it reaches every door a consent card does.
 * Nothing is sent from here.
 */

import { currentTaskOf } from "./autonomy-level.ts";
import { DRAFT_KINDS, type DraftKind, draftDescription } from "./outbox-drafts.ts";
import type { ToolContext } from "./tools.ts";

export const OUTBOX_TOOL = "Outbox";

export function withOutboxTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: OUTBOX_TOOL,
    description:
      "Put an outward step in the person's Outbox instead of taking it: a message to someone other than the person you are talking to, a post, a submission, an email. " +
      "On an L4 task this is how anything that reaches outside is sent. Nothing goes until the person approves — as written, or after editing it — or rejects it with a reason. " +
      "An approved message to a chat the host can reach (target \"here\" for this chat, or a chat key such as feishu:oc_…) is delivered for you; for anything else you are told to carry it out with the approved words. " +
      "Either way you are woken with the answer: end your turn after drafting, do not wait or ask again.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...DRAFT_KINDS] },
        target: { type: "string", description: "Who or where it is for: \"here\", a chat key, a person, a site." },
        body: { type: "string", description: "The exact words, or the exact command or content to submit." },
        why: { type: "string", description: "One line: why this should go now. Shown to the person as your case." },
        background: { type: "string", description: "Optional: what the person needs to know to decide." },
      },
      required: ["kind", "target", "body", "why"],
    },
  } as never);
}

export function runOutboxTool(context: ToolContext, input: Record<string, unknown>): { text: string; isError?: boolean } {
  const outbox = context.outbox;
  if (outbox === undefined || context.policy === undefined) return { text: "Outcome: refused — there is no Outbox here and no one to approve it. Put the draft in your answer instead.", isError: true };
  const kind = String(input.kind ?? "") as DraftKind;
  const target = String(input.target ?? "").trim();
  const body = String(input.body ?? "");
  const why = String(input.why ?? "").trim();
  if (!DRAFT_KINDS.includes(kind)) return { text: `Outcome: refused — kind is one of ${DRAFT_KINDS.join(", ")}.`, isError: true };
  if (body.trim() === "" || why === "" || target === "") return { text: "Outcome: refused — target, body and why are all needed: the person decides on the exact words and your reason.", isError: true };
  const task = currentTaskOf(context as never) as { id: string; level?: number } | undefined;
  const id = outbox.newId();
  const description = draftDescription({ id, kind, target, body });
  const approval = context.policy.requestConfirmation({
    agentId: context.agent.id,
    agentName: context.agent.profile.name,
    description,
    action: kind === "message" ? "send a message for you" : `${kind} for you`,
    why,
    ...(task?.level !== undefined ? { taskLevel: task.level as 1 | 2 | 3 | 4 | 5 } : {}),
  });
  const background = typeof input.background === "string" && input.background.trim() !== "" ? input.background.trim().slice(0, 1000) : undefined;
  outbox.record({
    id, agentId: context.agent.id, agentName: context.agent.profile.name, conversation: context.conversation ?? "main",
    ...(task !== undefined ? { taskId: task.id } : {}), ...(task?.level !== undefined ? { level: task.level } : {}),
    kind, target, body, why, ...(background !== undefined ? { background } : {}), approvalId: approval.id,
  });
  return { text: `Outcome: in the Outbox as ${id}, waiting for the person. Nothing has been sent. You will be woken with their answer — end this turn now.` };
}
