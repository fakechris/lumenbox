/**
 * The case that travels with a decision put to a person (INV-1651): why the agent wants this
 * step, in its own words, and which answer it leans to on a question.
 *
 * Two rules keep this honest. The agent's reason is shown as the agent's claim — labelled,
 * unverified, beside the facts the harness knows — never folded into the action text, because
 * consent binds to the action verbatim and a request that argued its own case inside that text
 * would be the asking party editing what is consented to. And the reason is kept out of the
 * fingerprint: the same command with a reworded reason is the same command.
 */

/** The schema fragment a tool spreads into its properties so the model can say why. */
export const WHY_FIELD = {
  why: {
    type: "string",
    description: "One sentence on why this step is needed now, for the person who may be asked to approve it. Shown beside the action as your own words; it does not change what is approved.",
  },
} as const;

/** The reason lifted off the input, and the input without it, so the fingerprint and the tool see the action alone. */
export function splitWhy(input: Record<string, unknown>): { input: Record<string, unknown>; why?: string } {
  const raw = input.why;
  if (typeof raw !== "string" || raw.trim() === "") return { input };
  const { why: _why, ...rest } = input;
  return { input: rest, why: raw.trim().slice(0, 300) };
}

/** One line for the card and the strip: whose claim it is, and that it is a claim. */
export function agentCaseText(agentName: string, why: string | undefined): string | undefined {
  if (why === undefined || why.trim() === "") return undefined;
  return `${agentName} says (its own words, not checked): ${why.trim()}`;
}

/** What the agent leans to on a question, when it said. */
export function questionLeanText(agentName: string, recommended: string | undefined): string | undefined {
  if (recommended === undefined || recommended.trim() === "") return undefined;
  return `${agentName} leans to: ${recommended.trim()}`;
}
