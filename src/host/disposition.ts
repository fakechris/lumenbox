/**
 * What to do with a provider error, read from the vendor's own code (INV-1612).
 *
 * The nine-class failure taxonomy and the retry kinds stay where they are. This file only
 * answers a narrower question those two collapse: a 429 is not one thing. MiniMax 2056 is the
 * plan window, 2062 is requests-per-minute. OpenAI puts the same split in `error.code`
 * (`insufficient_quota` against `rate_limit_exceeded`). Anthropic puts a spend cap in
 * `details.error_code` and uses the presence of `retry-after` to tell it from an ordinary
 * rate limit. LiteLLM's mistake is the one to avoid: every 429 becomes RateLimitError and is
 * retried by status, which retries a plan that is empty.
 *
 * Four dispositions, decided in this order, and only the first two are produced here.
 * Permanent failures and context overflow already have their own paths; this table does not
 * re-decide them.
 *
 *   - quota_hold: the plan, the balance, or a spend cap. Stop. Do not retry.
 *   - retry_after: the provider is busy. Honour Retry-After. Do not rest the account.
 *   - permanent: auth or a bad request. Not this file.
 *   - shed: the context does not fit. Not this file.
 *
 * An unknown 429 stays undecided here, so the caller keeps treating it as capacity. A code
 * this table has not verified must not stop the fleet.
 *
 * Nothing in the retry loop names 2056 or 2062. The codes live in the sets below.
 */

export type Disposition = "quota_hold" | "retry_after";

/** Plan, balance, or a spend cap. Status is often still 429. */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "2056",
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "enforced_spend_limit_reached",
]);

/** Busy. A short retry, paced by the provider when it says how long. */
const RATE_CODES: ReadonlySet<string> = new Set(["2062", "rate_limit_exceeded", "slow_down"]);

/**
 * `type` is read only when it is one of these. `rate_limit_error` is not one of them:
 * MiniMax puts that type on both 2056 and 2062, so treating the type as a rate code would
 * rest nothing and would also miss the quota.
 */
const TYPED_CODES: ReadonlySet<string> = new Set([...QUOTA_CODES, ...RATE_CODES]);

const CODE_ORDER = [
  "2056",
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "enforced_spend_limit_reached",
  "2062",
  "rate_limit_exceeded",
  "slow_down",
];

const MAX_DEPTH = 8;

interface Walk {
  codes: Set<string>;
  retryAfter: boolean;
}

/** A code from a field, or undefined when the value is not one we can name. */
function norm(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^\d+$/.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

/** Parenthetical vendor codes, and a known code that survived only as text in a stringified body. */
function harvestText(text: string, codes: Set<string>): void {
  for (const match of text.matchAll(/\((2056|2062)\)/g)) codes.add(match[1]!);
  const lower = text.toLowerCase();
  for (const code of TYPED_CODES) {
    if (!/^\d+$/.test(code) && lower.includes(code)) codes.add(code);
  }
}

function headerText(headers: object, name: string): string | undefined {
  const bag = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
  try {
    if (typeof bag.get === "function") {
      const value = bag.get(name) ?? bag.get(name.toLowerCase());
      if (typeof value === "string") return value;
    }
  } catch {
    // A header bag that throws is not a retry instruction.
  }
  const raw = bag[name] ?? bag[name.toLowerCase()];
  return typeof raw === "string" ? raw : undefined;
}

/** Whether the provider attached a retry-after, not how long it asked for. */
function readsRetryAfter(record: Record<string, unknown>): boolean {
  const direct = Number(record.retryAfter);
  if (Number.isFinite(direct) && direct > 0) return true;
  const headers = record.headers;
  if (headers === null || typeof headers !== "object") return false;
  for (const name of ["retry-after", "retry-after-ms"]) {
    const raw = headerText(headers, name);
    if (raw !== undefined && raw.trim() !== "" && raw.trim() !== "0") return true;
  }
  return false;
}

function walk(value: unknown, into: Walk, seen: Set<unknown>, depth: number): void {
  if (typeof value === "string") {
    harvestText(value, into.codes);
    return;
  }
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return;
  if (seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["code", "error_code"]) {
    const code = norm(record[key]);
    if (code !== undefined) into.codes.add(code);
  }
  const typed = norm(record.type);
  if (typed !== undefined && TYPED_CODES.has(typed)) into.codes.add(typed);
  if (typeof record.message === "string") harvestText(record.message, into.codes);
  if (!into.retryAfter && readsRetryAfter(record)) into.retryAfter = true;
  if (record.details !== undefined) walk(record.details, into, seen, depth + 1);
  if (record.error !== undefined) walk(record.error, into, seen, depth + 1);
  if (record.cause !== undefined) walk(record.cause, into, seen, depth + 1);
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) walk(inner, into, seen, depth + 1);
  }
}

function inspect(error: unknown): Walk {
  const into: Walk = { codes: new Set(), retryAfter: false };
  walk(error, into, new Set(), 0);
  return into;
}

/**
 * quota_hold or retry_after, or undefined when this error names no code in the table.
 *
 * A spend cap with retry-after is the provider asking for a pause, not an empty plan, so it
 * is retry_after. The same code without retry-after is the cap. Any other quota code wins
 * over that, and over a rate code sitting beside it.
 */
export function dispositionOf(error: unknown): Disposition | undefined {
  const { codes, retryAfter } = inspect(error);
  const specificQuota = [...codes].some(code => QUOTA_CODES.has(code) && code !== "enforced_spend_limit_reached");
  if (specificQuota) return "quota_hold";
  if (codes.has("enforced_spend_limit_reached")) return retryAfter ? "retry_after" : "quota_hold";
  if ([...codes].some(code => RATE_CODES.has(code))) return "retry_after";
  return undefined;
}

/** The vendor code worth writing on a rejected-call row, if one was found. */
export function vendorCodeOf(error: unknown): string | undefined {
  const { codes } = inspect(error);
  return CODE_ORDER.find(code => codes.has(code));
}
