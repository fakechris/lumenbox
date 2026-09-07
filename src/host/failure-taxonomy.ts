/**
 * What kind of failure a message describes, and what to do about it.
 *
 * Nine classes and a recommended action each, so a failed turn, a pitfall and the
 * autonomy metrics all partition failures the same way. Regex over the message text,
 * which is the level a person reads at; the classes are coarse on purpose — a class that
 * nobody could tell apart by eye is not worth a name. (TurnkeyAI's failure taxonomy is
 * the same idea, nine values; the classes here are ours, named after what this
 * installation has actually seen fail.)
 */

export type FailureCategory =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "network"
  | "permission_denied"
  | "context_overflow"
  | "tool_error"
  | "model_refusal"
  | "unknown";

const RULES: readonly { category: FailureCategory; pattern: RegExp }[] = [
  { category: "rate_limit", pattern: /\b(429|rate[ -]?limit|too many requests|overloaded|quota)\b/i },
  { category: "auth", pattern: /\b(401|403|unauthori[sz]ed|authentication|invalid (api )?key|forbidden|credential)\b/i },
  { category: "timeout", pattern: /\b(timed? ?out|deadline|ETIMEDOUT|took too long)\b/i },
  { category: "network", pattern: /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|unreachable|502|503|504)\b/i },
  { category: "context_overflow", pattern: /\b(context (window|length)|too (long|large)|max(imum)? tokens|prompt is too|request too large|413)\b/i },
  { category: "permission_denied", pattern: /\b(EACCES|EPERM|permission denied|not permitted|refused by policy|needs? (a person's )?approval)\b/i },
  { category: "model_refusal", pattern: /\b(refus(e|ed|al)|cannot (help|comply|assist)|I can't help|policy violation|content filter)\b/i },
  { category: "tool_error", pattern: /\b(exit(ed)? (code )?[1-9]\d*|command failed|non-zero|ENOENT|no such file|syntax error|traceback|exception)\b/i },
];

export function classifyFailure(message: string): FailureCategory {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) return rule.category;
  }
  return "unknown";
}

/** What a person or an agent should do next for each class: the taxonomy's point. */
export const RECOMMENDED_ACTION: Record<FailureCategory, string> = {
  timeout: "retry once with a longer limit; if it repeats, split the work",
  rate_limit: "wait and retry; do not fan out",
  auth: "a credential is wrong or missing — an operator's fix, not a retry",
  network: "retry after a pause; check the box can reach the address",
  permission_denied: "ask the person, or leave the step to whoever may do it",
  context_overflow: "compact or shed history, then continue; do not resend the same request",
  tool_error: "read the tool's output and change the call; do not repeat it verbatim",
  model_refusal: "rephrase the task or take a different route; a second identical ask is a loop",
  unknown: "read the message; if it repeats, report it rather than retry",
};
