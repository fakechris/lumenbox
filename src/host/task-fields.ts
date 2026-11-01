/**
 * The fields of a task that are text with a limit: the description, the due date and the
 * five-field contract. Pure, so the store stays about the board's rules and these stay about
 * the shape of what a person typed.
 */

/**
 * How much of the request a task keeps, and what it says when it kept less.
 *
 * The cut is real — a snapshot is one line and an unbounded description makes the board
 * file unbounded — but it used to be silent, and that is what makes it dangerous rather
 * than merely lossy. A 4,200-character request whose last sentence is "do not deduplicate
 * the invoice rows" persisted without that sentence, and every later reader — a person
 * scanning the board, an auditor told to re-derive the constraints from the original
 * request — saw a complete-looking request that was not complete. Found by review.
 *
 * So the truncation announces itself in the text, in the reader's own line of sight. It
 * cannot make the words come back; it can stop them from being missed.
 */
export const DESCRIPTION_LIMIT = 4_000;

/** A due date as stored: an ISO instant, from a date or an instant; nothing for anything else. */
export function dueOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59Z` : text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function clampDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_LIMIT) return trimmed;
  const note = `\n\n[截断:原文 ${trimmed.length} 字,此处只保留前 ${DESCRIPTION_LIMIT} 字。完整内容在原始消息里。]`;
  return `${trimmed.slice(0, DESCRIPTION_LIMIT - note.length)}${note}`;
}

export interface TaskContract {
  outcome?: string;
  scope?: string;
  constraints?: string;
  acceptance?: string;
  verification?: string;
}

export function clampContract(input: Partial<Record<keyof TaskContract, unknown>> | undefined): TaskContract | undefined {
  if (input === undefined) return undefined;
  const out: TaskContract = {};
  for (const key of ["outcome", "scope", "constraints", "acceptance", "verification"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim().slice(0, 1_000);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
