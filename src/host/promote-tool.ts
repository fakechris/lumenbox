/**
 * Promote (INV-1729, docs/98 §5 rule 2): an agent proposes that something it already has — a
 * memory, its own or the team's, or a finished task's outcome — become an organisation item.
 *
 * The proposal waits for a person (org-promotion.ts): nobody, the proposer included, reads it
 * until an Admin approves it, and the agent is told so. Its owner is the member who drove the turn
 * (`promotionOwner`); a turn nobody drove is refused, as is one with no organisation knowledge to
 * write — an isolated or guest turn, or a personal installation, which has none (docs/98 §8).
 */

import { outcomeLine } from "../protocol/index.ts";
import { dedupe, dedupeKey } from "./memory.ts";
import { guardMemoryCandidate } from "./memory-guard.ts";
import { type PromotionSource, promotionOwner, propose, readersOf } from "./org-promotion.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";

export const PROMOTE = "Promote";

export function withPromoteTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: PROMOTE,
    description:
      "Propose that something you already have become part of the organisation's knowledge — what every member's agents " +
      "(scope 'org') or this box's (scope 'box') may rely on. Point at a memory (yours or the team's, quoted) or a finished " +
      "task, and say the statement in one sentence. A person always reviews it first: nobody, you included, reads it until " +
      "an Admin approves it. For what is true about the organisation and will stay true — a policy, a decision, how we do " +
      "something — not for your own working notes (RememberFact).",
    input_schema: {
      type: "object",
      properties: {
        memory: { type: "string", description: "The memory to promote, quoted closely enough to recognise." },
        task_id: { type: "string", description: "Or: a finished task whose outcome is promoted, e.g. \"t12\"." },
        statement: { type: "string", description: "The statement for the organisation, one sentence. Required for a task; a memory's own text when omitted." },
        scope: { type: "string", enum: ["org", "box"], description: "'org': every member's agents. 'box': this box's agents, for its members." },
        evidence: { type: "array", items: { type: "string" }, description: "What else it rests on: inv:INV-123, commit:<sha>, doc:docs/98, task:t12." },
      },
      required: ["scope"],
    },
  } as never);
}

function refused(reason: string): ToolOutcome {
  return { text: outcomeLine("refused", reason), isError: true };
}

function sourceOf(context: ToolContext, memory: string, taskId: string): PromotionSource | string {
  if ((memory === "") === (taskId === "")) return "point at exactly one thing: a memory or a task_id";
  if (taskId !== "") {
    const task = context.tasks?.get(taskId);
    return task === undefined ? `there is no task ${taskId}` : { kind: "task", task };
  }
  const key = dedupeKey(memory);
  const own = dedupe(context.registry.readMemoryRecords(context.agent.id)).find(record => dedupeKey(record.text) === key);
  if (own !== undefined) return { kind: "memory", record: own, holder: context.agent.id };
  const team = dedupe(context.registry.readSharedMemory(context.agent.id, context.caller?.userId)).find(record => dedupeKey(record.text) === key);
  if (team !== undefined) return { kind: "memory", record: team, holder: team.via ?? context.agent.id };
  return `nothing you or the team remember matches "${memory}"; quote it more closely`;
}

export function promoteTool(context: ToolContext, input: Record<string, unknown>): ToolOutcome {
  const ledger = context.orgKnowledge;
  if (ledger === undefined) return refused("this turn has no organisation knowledge to propose into");
  const owner = promotionOwner({ ...(context.caller?.userId !== undefined ? { caller: context.caller.userId } : {}) });
  if (owner === undefined) return refused("no member drove this turn, so nobody would be accountable for the item; a member can promote it from their conversation, or an Admin from Settings → Memory");
  const scope = input.scope === "org" ? "org" : input.scope === "box" ? (`box:${context.registry.boxOf(context.agent.id).id}` as const) : undefined;
  if (scope === undefined) return refused("scope is 'org' or 'box'");
  const source = sourceOf(context, String(input.memory ?? "").trim(), String(input.task_id ?? "").trim());
  if (typeof source === "string") return refused(source);
  const statement = String(input.statement ?? "").trim();
  if (statement !== "") {
    const unsafe = guardMemoryCandidate(statement, { held: context.vault?.heldValues() ?? new Map() });
    if (unsafe !== undefined) return refused(unsafe.reason);
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence.map(ref => String(ref).trim()).filter(ref => ref !== "") : [];
  const result = propose(ledger, { source, ...(statement !== "" ? { text: statement } : {}), scope, owner, via: context.agent.id, evidence });
  if (!result.ok) return refused(result.why);
  const readers = readersOf(scope, id => context.registry.boxById(id));
  const who = readers.kind === "org" ? "every member's agents" : readers.kind === "box" ? `the agents of box ${readers.boxName}` : "nobody";
  return {
    text: `${outcomeLine("ok")} Proposed for the organisation's knowledge, waiting for an Admin's approval; once approved it gets an id (org:…) to cite. Until then nobody reads it, you included; once approved, ${who} will. Do not propose it again.`,
  };
}
