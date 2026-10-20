/**
 * What kind of failure a message describes, and what to do about it.
 *
 * Nine classes and a recommended action each, so a failed turn, a pitfall and the
 * autonomy metrics all partition failures the same way. The classes are coarse on
 * purpose — a class that nobody could tell apart by eye is not worth a name. (TurnkeyAI's
 * failure taxonomy is the same idea, nine values; the classes here are ours, named after
 * what this installation has actually seen fail.)
 *
 * Two readings, structured first (INV-1235). An error object is read for what the
 * provider or the OS said in a field — the SDK's HTTP `status` and `error.type`, an errno
 * `code` — down its `cause` chain, and only when no field decides is the message text
 * matched by regex. The text rules stay as the fallback and as the whole story for a bare
 * string: a provider that rewords a 429, or a relay that wraps one, no longer turns it
 * into `unknown`. transient.ts answers a different question (retry or not) over the
 * same fields; this file answers "what kind of thing went wrong".
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

/** The provider error types the Anthropic wire names, by class; anything else is left to the text. */
const BY_ERROR_TYPE: Readonly<Record<string, FailureCategory>> = {
  rate_limit_error: "rate_limit",
  overloaded_error: "rate_limit",
  authentication_error: "auth",
  permission_error: "auth",
  timeout_error: "timeout",
  api_error: "network",
};

/** Node's errno codes for a connection that never got an answer. */
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** Context overflow is a 400 whose message says so — the same phrases turn.ts sheds history on. */
const OVERFLOW_TEXT = /context (window|length)|context_(window|length)|prompt is too long|maximum context|input token limit|request too large|too many total text bytes|input length and `max_tokens` exceed/i;

/**
 * Classify from an error's fields, walking its `cause` chain. `undefined` when no field decided —
 * the caller falls back to the text. The first decisive field wins, outermost error first, so a
 * relay that wraps a provider error in its own HTTP status reports the wrapper's status: that is
 * the thing the caller actually hit.
 */
function fromFields(error: unknown, seen: Set<unknown>): FailureCategory | undefined {
  if (error === null || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  const record = error as { status?: unknown; code?: unknown; error?: unknown; message?: unknown; cause?: unknown };

  // The Anthropic SDK's APIError: `error` is the provider's body, `{type:"error", error:{type, message}}`.
  const body = record.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  const errorType =
    typeof body?.error?.type === "string" ? body.error.type : typeof body?.type === "string" && body.type !== "error" ? body.type : undefined;
  const status = typeof record.status === "number" ? record.status : undefined;
  const message = typeof record.message === "string" ? record.message : "";

  if (errorType !== undefined && errorType in BY_ERROR_TYPE) return BY_ERROR_TYPE[errorType];
  if (errorType === "invalid_request_error" && OVERFLOW_TEXT.test(message)) return "context_overflow";
  if (status !== undefined) {
    if (status === 429 || status === 529) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status === 408 || status === 504) return "timeout";
    if (status === 413) return "context_overflow";
    if (status === 400 && OVERFLOW_TEXT.test(message)) return "context_overflow";
    if (status === 502 || status === 503) return "network";
  }
  if (typeof record.code === "string") {
    const code = record.code.toUpperCase();
    if (TIMEOUT_CODES.has(code)) return "timeout";
    if (NETWORK_CODES.has(code)) return "network";
  }
  return fromFields(record.cause, seen);
}

/**
 * Classify an error of any shape: fields first, text second. A string has only text.
 */
export function classifyFailureOf(error: unknown): FailureCategory {
  if (typeof error === "string") return classifyFailure(error);
  const structured = fromFields(error, new Set());
  if (structured !== undefined) return structured;
  const message = error instanceof Error ? error.message : String(error);
  return classifyFailure(message);
}

/**
 * The class a turn ends with, given what it saw along the way. The first specific class is kept:
 * a 429 that was retried and then died as a generic "giving up" must still be filed as a rate
 * limit, not overwritten by whatever the last wrapper said (the bug OpenAgentCore fixed in
 * delivery.go:351, and the reason their Claude failures all read harness_error for a while).
 */
export function keepFirstSpecific(kept: FailureCategory | undefined, next: FailureCategory): FailureCategory {
  return kept !== undefined && kept !== "unknown" ? kept : next;
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
