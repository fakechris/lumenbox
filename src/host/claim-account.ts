/**
 * What an executor says about its own claim of completion (INV-1574): the decisions it made on
 * the person's behalf, and what its checks did not cover.
 *
 * The goal gate proves the checklist; it says nothing about the choices the work embodies — the
 * default picked, what was treated as out of scope, how a requirement was read — nor about what
 * the checks never touched. A green verdict reads as "all of it is right", and a person reviewing
 * has to reconstruct the rest from the transcript or skip it. So a claim carries both, the gate
 * refuses one without them, the verifier is asked whether the decisions match the artifacts, and
 * the review shows them above the verdict.
 */

export interface ClaimAccount {
  /** What the executor decided, each with the assumption behind it. */
  decisions: string[];
  /** What the executor's own checks did not cover. */
  unchecked: string[];
}

const MAX_ENTRIES = 12;
const MAX_CHARS = 300;

/** The Goal tool's two fields, spread into its input schema beside `evidence`. */
export const CLAIM_ACCOUNT_SCHEMA = {
  decisions: {
    type: "array",
    description: "For claim_complete, required: each decision you made on the person's behalf and the assumption behind it (a default you chose, what you treated as out of scope, how you read a requirement). Say 'none' only if you truly made none.",
    items: { type: "string" },
  },
  unchecked: {
    type: "array",
    description: "For claim_complete, required: what your own checks did not cover — what a passing check does not prove. Say 'none' only if every claim is proven by a check.",
    items: { type: "string" },
  },
} as const;

/** The account from the tool input, trimmed and bounded; entries that are empty are dropped. */
export function claimAccountOf(input: Record<string, unknown>): ClaimAccount {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
      // Only text counts: an object would become "[object Object]" and pass for a decision.
      .map(entry => (typeof entry === "string" || typeof entry === "number" ? String(entry).trim().slice(0, MAX_CHARS) : ""))
      .filter(entry => entry !== "")
      .slice(0, MAX_ENTRIES);
  return { decisions: list(input.decisions), unchecked: list(input.unchecked) };
}

/** Why a claim without its account is refused, or undefined when it is complete. */
export function accountRefusal(account: ClaimAccount): string | undefined {
  const missing = [account.decisions.length === 0 ? "decisions" : "", account.unchecked.length === 0 ? "unchecked" : ""].filter(Boolean);
  if (missing.length === 0) return undefined;
  return `Not claimed: give ${missing.join(" and ")} with claim_complete — the decisions you made on the person's behalf and the assumptions behind them, and what your checks did not cover. A person reviews this before accepting; write "none" only when that is true.`;
}

/** The verifier's part: the executor's account to test, and the one extra line to answer with. */
export function accountForVerifier(account: ClaimAccount | undefined): { section: string[]; answer: string[] } {
  if (account === undefined || (account.decisions.length === 0 && account.unchecked.length === 0)) return { section: [], answer: [] };
  return {
    section: [
      "",
      "The executor's account (claims to test, not facts):",
      ...account.decisions.map(entry => `- decided: ${entry}`),
      ...account.unchecked.map(entry => `- says it did not check: ${entry}`),
    ],
    answer: ["Decisions: consistent|mismatch — whether the decisions above match what the artifacts actually do, naming any that do not"],
  };
}

/** The verifier's `Decisions:` line, when it gave one. */
export function decisionsVerdictOf(text: string): string | undefined {
  const line = /^Decisions:\s*(consistent|mismatch)\b\s*(?:[—–:-]\s*(.*))?$/im.exec(text);
  if (line === null) return undefined;
  return `${line[1]!.toLowerCase()}${line[2]?.trim() ? `: ${line[2].trim().slice(0, MAX_CHARS)}` : ""}`;
}

/** The account as the person reads it, above the verdict. */
export function accountLines(account: ClaimAccount | undefined, decisionsVerdict: string | undefined): string[] {
  if (account === undefined) return [];
  return [
    ...(account.decisions.length > 0 ? ["它替你做的决定：", ...account.decisions.map(entry => `- ${entry}`)] : []),
    ...(account.unchecked.length > 0 ? ["它的检查没有覆盖：", ...account.unchecked.map(entry => `- ${entry}`)] : []),
    ...(decisionsVerdict !== undefined ? [`验证者对这些决定的核对：${decisionsVerdict}`] : []),
  ];
}
