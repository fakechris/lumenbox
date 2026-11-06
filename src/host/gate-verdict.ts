/**
 * The gate's verdict on one tool step, as the chat shows it (INV-1664).
 *
 * The policy gate already wrote every decision to its ledger before the action, but the step a
 * person watches in the chat did not carry it: whether a call ran because nothing asks for it,
 * because a person allowed it, or was refused by a rule was visible only in Settings, in
 * aggregate. A verdict is that decision, tied to the step by the model's tool_use id, with the
 * reason in words — which rule, whose setting, which floor.
 *
 *   allowed — ran without asking anybody (and why nothing asked)
 *   asked   — ran because a person allowed it (once, for the session, or standing)
 *   waiting — a consent card is out; nothing ran
 *   refused — the gate said no (a rule, the task's level, a stop) or the person did
 *
 * Kept by the gate, keyed by call, rebuilt from the ledger on start (the `checked` row carries
 * it), so a reloaded chat shows the same marks the live one did; and updated when the card it
 * waited on is answered, so "waiting" does not outlive the answer.
 */

import type { Rule } from "./rules.ts";

export type GateVerdictKind = "allowed" | "asked" | "waiting" | "refused";

export interface GateVerdict {
  verdict: GateVerdictKind;
  /** Why, in a sentence a person can act on: the rule, the setting, the floor or the grant. */
  basis: string;
  /** The rule that decided it, when one did: an operator's file id or `agent:<name>/<tool|group>`. */
  rule?: string;
  /** The consent card this step waited on, so its answer can settle the mark. */
  approvalId?: string;
}

/** A rule as a person reads its source: whose words decided this. */
export function ruleWords(rule: Rule): string {
  return rule.source === "agent" ? `the agent's setting (${rule.name})` : `operator rule ${rule.id}`;
}

/** Everything that made a call ask, strongest first; empty when nothing did. */
export function askReasons(facts: {
  rule?: Rule;
  hostCommand: boolean;
  irreversible?: string;
  tainted: boolean;
  approvalList: boolean;
  tierEnforced?: string;
  levelAsks?: number;
}): string[] {
  const out: string[] = [];
  if (facts.rule?.effect === "ask") out.push(ruleWords(facts.rule));
  if (facts.hostCommand) out.push("a command on the person's own machine always asks");
  if (facts.irreversible !== undefined) out.push(`the box found it cannot be undone (${facts.irreversible})`);
  if (facts.tainted) out.push("this turn read a secret or outside content first");
  // An operator's allow rule lifts the configured lists; it never lifts the three above.
  if (facts.rule?.effect !== "allow") {
    if (facts.approvalList) out.push("the installation's approval list");
    if (facts.tierEnforced !== undefined) out.push(`the side-effect gate asks for ${facts.tierEnforced} calls`);
    if (facts.levelAsks !== undefined) out.push(`the task is at L${facts.levelAsks}: outward steps are confirmed`);
  }
  return out;
}

/** The verdict for one check, from what the gate decided and why. */
export function verdictOf(facts: {
  allow: boolean;
  reason?: string;
  approvalId?: string;
  /** How the person's consent covered it, when a grant was used. */
  grant?: "once" | "session" | "standing";
  rule?: Rule;
  asks: readonly string[];
  /** Allowed while the tier gate only watches, and it would have asked. */
  wouldAsk: boolean;
}): GateVerdict {
  const rule = facts.rule !== undefined ? { rule: facts.rule.id } : {};
  const because = facts.asks.length > 0 ? ` — asked because of ${facts.asks.join("; ")}` : "";
  if (facts.allow && facts.grant !== undefined) {
    const how = facts.grant === "standing" ? "a standing approval" : facts.grant === "session" ? "an approval for this session" : "a person's approval, once";
    return { verdict: "asked", basis: `ran on ${how}${because}`, ...rule };
  }
  if (facts.allow) {
    const basis = facts.rule?.effect === "allow"
      ? `${ruleWords(facts.rule)} allows it`
      : facts.wouldAsk ? "nothing asks for this yet; the side-effect gate is watching and would have asked" : "nothing asks for this";
    return { verdict: "allowed", basis, ...rule };
  }
  if (facts.approvalId !== undefined) {
    return { verdict: "waiting", basis: `waiting for a person${because}`, approvalId: facts.approvalId, ...rule };
  }
  const first = (facts.reason ?? "refused").split(/(?<=\.)\s/)[0]!;
  return { verdict: "refused", basis: facts.rule?.effect === "deny" ? `${ruleWords(facts.rule)} refuses it` : first.slice(0, 240), ...rule };
}

/** How many steps' verdicts are kept for the chat. A sample of the recent past, not a second ledger. */
const KEEP = 5_000;

export class GateVerdicts {
  private readonly byCall = new Map<string, GateVerdict>();

  note(callId: string, verdict: GateVerdict): void {
    this.byCall.delete(callId);
    this.byCall.set(callId, verdict);
    if (this.byCall.size > KEEP) this.byCall.delete(this.byCall.keys().next().value!);
  }

  /** The card a step waited on was answered: its mark says how, not "waiting" forever. */
  settle(approvalId: string, how: "allowed" | "refused"): void {
    for (const [callId, verdict] of this.byCall) {
      if (verdict.approvalId !== approvalId || verdict.verdict !== "waiting") continue;
      this.byCall.set(callId, {
        ...verdict,
        verdict: how === "allowed" ? "asked" : "refused",
        basis: how === "allowed" ? verdict.basis.replace(/^waiting for a person/, "a person allowed it; the agent went on") : verdict.basis.replace(/^waiting for a person/, "a person refused it"),
      });
    }
  }

  get(callId: string): GateVerdict | undefined {
    return this.byCall.get(callId);
  }
}
