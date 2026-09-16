/**
 * Who answers when the agent that was asked cannot (INV-556).
 *
 * The research settled the shape (2026-09-15, docs/54): Linear has no primitive for handing
 * a live session to another agent — when one does not respond you delegate to another, open
 * a new session, and rebuild context from the comments and `promptContext`. Harness swaps in
 * the wider ecosystem say the same thing out loud: no transcript migration, a semantic
 * handover plus the durable facts in the repository. **What answers a question is the
 * record, not the process.**
 *
 * So a stand-in is not a resumed session. It is another agent, reading the same item and the
 * same receipts, answering under its own name with the relation stated. Three rules, and the
 * first two are refusals:
 *
 * - **Never in the other one's name.** Answering through the original actor's credential
 *   would put words in its mouth in the ledger, where the author is what people trust.
 *   `standInCheck` is the structural guard, not a convention.
 * - **Never a reconstruction passed off as memory.** A stand-in did not make the decision.
 *   It answers from what is written down and says which parts are inference.
 * - **Silence is reported as silence.** "No answer within the deadline" is a fact; "the
 *   agent is not running" is a guess about somebody else's machine, and usually wrong.
 */

export type Successor =
  | { kind: "agent"; handle: string }
  /** A person: nobody can be made to answer, but a name is what turns silence into a next step. */
  | { kind: "person"; name: string };

/** `@iris` is an agent on this installation; anything else is a person to go and ask. */
export function parseSuccessor(raw: string | undefined): Successor | undefined {
  const value = raw?.trim() ?? "";
  if (value === "") return undefined;
  return value.startsWith("@") ? { kind: "agent", handle: value.slice(1) } : { kind: "person", name: value };
}

export interface StandIn {
  /** The agent that was asked, and did not answer. */
  originalHandle: string;
  originalName: string;
  /** The one answering instead. */
  handle: string;
  name: string;
}

/**
 * The guard that makes impersonation impossible rather than discouraged: the credential
 * posting the answer must belong to whoever the answer says it is from.
 */
export function standInCheck(input: { postingAs: string; standIn: StandIn }): { ok: true } | { ok: false; why: string } {
  if (input.postingAs === input.standIn.handle) return { ok: true };
  return {
    ok: false,
    why:
      `refusing to post @${input.standIn.handle}'s answer through @${input.postingAs}: an answer in the ledger ` +
      `carries an author, and a stand-in that signs the missing agent's name is worse than no answer at all`,
  };
}

/**
 * What the stand-in is asked. The provenance rules are the prompt's whole reason for
 * existing — an agent asked "why did you decide X" about somebody else's decision will
 * produce a fluent, plausible reason unless it is told, in the same breath, not to.
 */
export function standInPrompt(
  input: { body: string; work: string },
  standIn: StandIn,
  context?: { item?: string; receipts?: string }
): string {
  return (
    `[involute ${input.work}] You are @${standIn.handle} on Involute. @${standIn.originalHandle} ` +
    `(${standIn.originalName}) was asked this and did not answer within the deadline, and you are its ` +
    `declared stand-in:\n\n${input.body}\n\n` +
    (context?.item !== undefined && context.item !== "" ? `The work item, as it stands:\n${context.item}\n\n` : "") +
    (context?.receipts !== undefined && context.receipts !== "" ? `${context.receipts}\n\n` : "") +
    `Answer as ${standIn.name}, in your own name. Rules for this answer:\n` +
    `- Open by saying you are not ${standIn.originalName}, and that you are answering in its place.\n` +
    `- Everything you say rests on the record — a run, a PR, a test, a line written down at the time. ` +
    `Cite it. You were not there.\n` +
    `- Where the record does not show why something was decided, say so and mark anything you add as ` +
    `your reconstruction. Do not produce a reason that merely sounds right.\n` +
    `- Do not guess why ${standIn.originalName} did not answer. You do not know, and it does not help.`
  );
}

/** The line a stand-in's answer must carry even if the model forgets: stated, not hoped for. */
export function standInAttribution(standIn: StandIn, evidence: string | undefined): string {
  return (
    `— ${standIn.name} (@${standIn.handle}), standing in for @${standIn.originalHandle}. ` +
    (evidence !== undefined && evidence !== "" ? `Based on ${evidence}.` : "Based on what is written on this item; I did not make this decision.")
  );
}

/**
 * What is said when nobody answered. Deliberately about the answer, not about the agent:
 * we can see that no answer arrived, and we cannot see whether anything is running.
 */
export function unansweredDetail(input: { originalName: string; successor: Successor | undefined; because?: string }): string {
  const who =
    input.successor === undefined
      ? "Nobody is named as its stand-in, so this needs a person to pick it up or a stand-in to be declared."
      : input.successor.kind === "person"
        ? `Ask ${input.successor.name}, who is named as its stand-in.`
        : `@${input.successor.handle} is its stand-in and could not answer either.`;
  // What we *saw* is fair to report — it is this installation's own machine. What the
  // silence means is not, which is why the two are kept in separate sentences.
  const seen = input.because !== undefined && input.because.trim() !== "" ? ` From this side: ${input.because.trim()}.` : "";
  return `${input.originalName} gave no answer within the deadline.${seen} ${who}`;
}
