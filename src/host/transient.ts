/**
 * Surviving a network blip in the middle of a long turn.
 *
 * A turn's round used to end the whole turn if the stream failed for any reason that was not an abort
 * or a context overflow: the error was rethrown, the orchestrator's caller logged it, and forty
 * minutes of work was gone. The SDK's own retries cover *establishing* a request — a stream that
 * breaks after content has arrived is not resumable, and that is exactly the failure a long turn is
 * most exposed to, because it is open the longest.
 *
 * Three things make retrying correct rather than merely hopeful:
 *
 * **Retry only what a retry could fix.** A rejected request, a bad credential, or an overflow that
 * cannot be shed further will fail identically forever; retrying those burns money and hides the real
 * error behind a delay. So the classifier says which kind of failure this was, and only two kinds are
 * retried.
 *
 * **Look through the wrapping.** Node buries the interesting error: a failed `fetch` is a generic
 * `TypeError` whose `cause` holds the `ECONNRESET`, and a multi-address connection failure is an
 * `AggregateError` whose `errors` hold several. A classifier that reads only the top-level message
 * misses most real transients, which is the failure mode of every naive version of this.
 *
 * **A silent stream is a failure.** A stream can open and then deliver nothing. That is not a slow
 * generation — a slow generation produces tokens — and waiting on it forever is indistinguishable
 * from a hang. So there is a deadline on the *first* token, separate from any limit on the whole
 * response.
 *
 * The backoff uses equal jitter — half the delay fixed, half random — so retries neither pile up at
 * the same instant nor line up in lockstep across several agents. Where the provider says how long to
 * wait, that wins: backing off for less than a server asked for is how a rate limit becomes a harder
 * rate limit.
 */

import { envNumber } from "../config.ts";

/** Codes that mean the connection broke, not that the request was wrong. */
const TRANSIENT_ERRNO_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENETRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Phrases that mean the same thing when no code survived the wrapping.
 *
 * A second channel rather than a replacement: some layers preserve `code`, some only stringify. Both
 * are needed, and neither alone is enough.
 */
const TRANSIENT_PHRASES: readonly string[] = [
  "econnreset",
  "etimedout",
  "epipe",
  "econnaborted",
  "econnrefused",
  "enetunreach",
  "ehostunreach",
  "socket hang up",
  "premature close",
  "stream closed",
  "closed stream",
  "connection reset",
  "connection closed",
  "connection terminated",
  "connection error",
  "network error",
  "fetch failed",
  "terminated",
  "other side closed",
];

/** Phrases that mean the provider is busy. Retried differently: sooner, and fewer times. */
const CAPACITY_PHRASES: readonly string[] = [
  "overloaded",
  "rate limit",
  "rate_limit",
  "too many requests",
  "capacity",
  "server is busy",
  "service unavailable",
  "try again later",
];

/** Phrases that will fail the same way forever. Named so they are never retried by accident. */
const PERMANENT_PHRASES: readonly string[] = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "invalid api key",
  "invalid x-api-key",
  "credit balance",
  "billing",
];

export type FailureKind =
  /** The connection broke. Retry, patiently. */
  | "transient"
  /** The provider is busy. Retry, sooner and fewer times, and obey any retry-after. */
  | "capacity"
  /** Will fail identically forever. Do not retry. */
  | "permanent"
  /** Unrecognised. Not retried: an unknown error retried in a loop is how a bug becomes a bill. */
  | "unknown";

/**
 * A stream that opened and then produced nothing within the deadline.
 *
 * Its own class so the retry decision can treat it as retryable without having to recognise it by
 * message — and so the message a person sees says what actually happened rather than "aborted".
 */
export class FirstTokenStallError extends Error {
  readonly isFirstTokenStall = true as const;
  constructor(deadlineMs: number) {
    super(
      `The model produced nothing for ${Math.round(deadlineMs / 1000)}s after the request opened. ` +
        `A slow answer still produces tokens, so this is a stalled connection rather than a long think.`
    );
    this.name = "FirstTokenStallError";
  }
}

export function isFirstTokenStall(error: unknown): boolean {
  return (
    error instanceof FirstTokenStallError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { isFirstTokenStall?: unknown }).isFirstTokenStall === true)
  );
}

/**
 * What kind of failure this is, looking through however many layers wrap it.
 *
 * Every signal in the chain is collected and then decided between, rather than the first one found
 * being returned — see the comment inside for the bug that distinction fixes.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (isFirstTokenStall(error)) return "transient";

  // Every signal in the whole chain, then decided — not the first one found.
  //
  // Returning early on the outermost signal is a bug I wrote and a test caught: a permanent error
  // wrapped in something whose message says "connection closed" would be classified transient and
  // retried four times, each attempt paying for input tokens on a request that can never succeed.
  const found = new Set<FailureKind>();
  collect(error, new Set(), found);

  // Permanent wins, because the two mistakes are not symmetrical. Calling a transient failure
  // permanent loses the turn — which is what happened before any of this existed. Calling a
  // permanent failure transient spends money repeatedly on a request that cannot succeed, and hides
  // the real error behind a delay.
  if (found.has("permanent")) return "permanent";
  if (found.has("capacity")) return "capacity";
  if (found.has("transient")) return "transient";
  return "unknown";
}

function collect(error: unknown, seen: Set<unknown>, into: Set<FailureKind>): void {
  if (typeof error === "string") {
    const kind = fromText(error);
    if (kind !== undefined) into.add(kind);
    return;
  }
  if (error === null || typeof error !== "object") return;
  // Cycles are possible once `cause` chains are involved, and a classifier that loops is worse than
  // one that misses.
  if (seen.has(error)) return;
  seen.add(error);

  const record = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };

  if (typeof record.message === "string") {
    const kind = fromText(record.message);
    if (kind !== undefined) into.add(kind);
  }

  const status = typeof record.status === "number" ? record.status : undefined;
  if (status !== undefined) {
    if (status === 429 || status === 529 || status === 503) into.add("capacity");
    // 408 and 504 are the server saying it gave up waiting, which a retry can fix.
    else if (status === 408 || status === 504 || status >= 500) into.add("transient");
    // Every other 4xx is the request being wrong. Retrying it is how a bug becomes a bill.
    else if (status >= 400) into.add("permanent");
  }

  if (typeof record.code === "string" && TRANSIENT_ERRNO_CODES.has(record.code.toUpperCase())) {
    into.add("transient");
  }

  collect(record.cause, seen, into);
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) collect(inner, seen, into);
  }
}

function fromText(text: string): FailureKind | undefined {
  const lower = text.toLowerCase();
  if (PERMANENT_PHRASES.some(phrase => lower.includes(phrase))) return "permanent";
  if (CAPACITY_PHRASES.some(phrase => lower.includes(phrase))) return "capacity";
  if (TRANSIENT_PHRASES.some(phrase => lower.includes(phrase))) return "transient";
  return undefined;
}

/** How patiently to retry, per kind of failure. */
export interface RetryPolicy {
  /** Attempts in total, including the first. One disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Capacity is retried sooner and fewer times than a broken connection.
 *
 * A busy provider usually recovers in seconds or not at all, and hammering it is what turns a rate
 * limit into a longer one. A dropped connection is worth more patience, because the thing on the
 * other end is probably fine.
 */
export const CAPACITY_POLICY: RetryPolicy = {
  maxAttempts: envNumber("AGENTBOX_CAPACITY_ATTEMPTS", 3),
  baseDelayMs: envNumber("AGENTBOX_CAPACITY_BASE_MS", 750),
  maxDelayMs: envNumber("AGENTBOX_CAPACITY_MAX_MS", 6_000),
};

export const TRANSIENT_POLICY: RetryPolicy = {
  maxAttempts: envNumber("AGENTBOX_TRANSIENT_ATTEMPTS", 4),
  baseDelayMs: envNumber("AGENTBOX_TRANSIENT_BASE_MS", 1_000),
  maxDelayMs: envNumber("AGENTBOX_TRANSIENT_MAX_MS", 15_000),
};

export function policyFor(kind: FailureKind): RetryPolicy | undefined {
  if (kind === "capacity") return CAPACITY_POLICY;
  if (kind === "transient") return TRANSIENT_POLICY;
  return undefined;
}

/** How long to wait before a stream that has produced nothing is given up on. */
export const FIRST_TOKEN_DEADLINE_MS = envNumber("AGENTBOX_FIRST_TOKEN_DEADLINE_MS", 120_000);

/** The most of a server's `retry-after` to honour, so a bad header cannot stall a turn for an hour. */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The provider's own instruction about when to come back, if it gave one.
 *
 * Honoured because waiting less than asked is how a rate limit becomes a harder one. Read from both
 * shapes the SDK surfaces: a `headers` bag and a `retryAfter` field.
 */
export function serverRetryAfterMs(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as {
    headers?: unknown;
    retryAfter?: unknown;
    cause?: unknown;
  };

  const direct = Number(record.retryAfter);
  if (Number.isFinite(direct) && direct > 0) return Math.min(direct * 1000, MAX_RETRY_AFTER_MS);

  const headers = record.headers;
  if (headers !== null && typeof headers === "object") {
    const bag = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
    const raw =
      typeof bag.get === "function"
        ? bag.get("retry-after")
        : (bag["retry-after"] as string | undefined);
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return record.cause !== undefined ? serverRetryAfterMs(record.cause) : undefined;
}

/**
 * Exponential backoff with equal jitter: half the delay fixed, half random.
 *
 * Pure jitter can put two retries at nearly the same instant; no jitter puts every agent's retry at
 * exactly the same instant. Half and half avoids both. `attempt` is 1-based — the delay after the
 * first failure.
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random
): number {
  const base = Math.max(0, policy.baseDelayMs);
  const cap = Math.max(base, policy.maxDelayMs);
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.min(cap, Math.round(exponential / 2 + random() * (exponential / 2)));
}

export interface RetryDecision {
  retry: boolean;
  /** How long to wait first. Zero when not retrying. */
  delayMs: number;
  kind: FailureKind;
  /** For the log and the event: why this was or was not retried. */
  reason: string;
  /** True when the provider asked for this delay rather than it being computed. */
  serverPaced: boolean;
}

export interface RetryInput {
  error: unknown;
  /** 1-based; the attempt that just failed. */
  attempt: number;
  /** True when a person or a signal ended this deliberately. */
  aborted: boolean;
  /**
   * Whether this attempt already sent text to whoever is watching.
   *
   * The correctness question, not a cosmetic one. Nothing is written to the transcript until a round
   * completes, so a retry cannot duplicate stored history or re-run a tool — but a partial answer
   * already shown to a person would appear twice. Retrying is still the right trade, and the caller
   * is told so it can say the partial is being discarded.
   */
  outputProduced: boolean;
  random?: () => number;
}

export function decideRetry(input: RetryInput): RetryDecision {
  const kind = classifyFailure(input.error);

  // First, and unconditionally: a deliberate stop is not a failure to recover from.
  if (input.aborted) {
    return { retry: false, delayMs: 0, kind, reason: "the turn was stopped", serverPaced: false };
  }

  const policy = policyFor(kind);
  if (policy === undefined) {
    return {
      retry: false,
      delayMs: 0,
      kind,
      reason:
        kind === "permanent"
          ? "the provider rejected the request, and would reject it again"
          : "the failure was not recognised as one a retry could fix",
      serverPaced: false,
    };
  }

  if (input.attempt >= policy.maxAttempts) {
    return {
      retry: false,
      delayMs: 0,
      kind,
      reason: `${kind} failure, and ${policy.maxAttempts} attempts is the limit`,
      serverPaced: false,
    };
  }

  const asked = serverRetryAfterMs(input.error);
  const computed = backoffMs(input.attempt, policy, input.random);
  // The larger of the two, so a server's instruction is a floor rather than a suggestion.
  const serverPaced = asked !== undefined && asked > computed;
  return {
    retry: true,
    delayMs: serverPaced ? asked : computed,
    kind,
    reason: serverPaced
      ? `${kind} failure; the provider asked for ${asked}ms`
      : `${kind} failure; attempt ${input.attempt + 1} of ${policy.maxAttempts}`,
    serverPaced,
  };
}
