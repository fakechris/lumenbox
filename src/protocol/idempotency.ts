/**
 * Whether a call that timed out may be sent again (INV-525).
 *
 * A timeout is not a failure. It is the loss of the answer, and the request may have run:
 * that is the four-state result's `unknown` (docs/49 A3), and it is the state a model is
 * worst at inferring on its own — "no reply" reads as "did not happen" to anything trained
 * on happy paths. So the protocol says it, per tool, before the call is made.
 *
 * Three declarations, and the honest default is the strict one:
 *
 *   - **`read`** — no effect to duplicate. Retry freely.
 *   - **`idempotent`** — running it twice lands the same state, *provided* the call carries
 *     the field that makes it so (an id, a key, a target). Retry once. Without that field
 *     present, it is not idempotent in this particular call, and the strict rule applies.
 *   - **`unsafe`** — running it twice does it twice. Never retried; the model is told the
 *     call may already have taken effect and what to do about it.
 *
 * **A tool nobody declared is `unsafe`.** Not because it probably is, but because the cost
 * of the two mistakes is not symmetrical: an unnecessary "check before repeating" is a
 * sentence, and a duplicated payment is a payment.
 *
 * What this deliberately is not: an exactly-once promise. There is no dedupe store here
 * and no promise that a retried idempotent call reaches the same server. It is a statement
 * about what the caller may do when the answer is lost, and a refusal to guess.
 */

export type Idempotency =
  | { kind: "read" }
  | { kind: "idempotent"; key?: string }
  | { kind: "unsafe" };

/**
 * Our own write tools. Reads are not listed: everything absent is `unsafe`, and a read
 * that is wrongly treated as unsafe costs one retry nobody makes.
 */
export const TOOL_IDEMPOTENCY: Readonly<Record<string, Idempotency>> = {
  // Reads and inspections: repeating them changes nothing.
  Read: { kind: "read" },
  Grep: { kind: "read" },
  Glob: { kind: "read" },
  History: { kind: "read" },
  Recall: { kind: "read" },
  browser_read: { kind: "read" },
  browser_outline: { kind: "read" },
  screenshot: { kind: "read" },
  // Writes that land the same state however many times they run, keyed by what they name.
  Write: { kind: "idempotent", key: "path" },
  browser_open: { kind: "idempotent", key: "url" },
  Tasks: { kind: "idempotent", key: "id" },
  RememberFact: { kind: "idempotent", key: "text" },
  // Writes that do it again when they run again. Named rather than implied, so that
  // adding one and forgetting this file leaves it `unsafe` anyway.
  bash: { kind: "unsafe" },
  RunOnHost: { kind: "unsafe" },
  SendToAgent: { kind: "unsafe" },
  AskUser: { kind: "unsafe" },
  connector_request: { kind: "unsafe" },
  browser_click: { kind: "unsafe" },
  browser_type: { kind: "unsafe" },
  browser_fill_secret: { kind: "unsafe" },
};

export function idempotencyOf(tool: string): Idempotency {
  return TOOL_IDEMPOTENCY[tool] ?? { kind: "unsafe" };
}

/**
 * HTTP's own answer, for the connector door: the method says it, and a caller that sent an
 * idempotency key says it louder. `POST` and `PATCH` are unsafe by definition; `PUT` and
 * `DELETE` are idempotent by definition; `GET` and `HEAD` are reads.
 */
export function idempotencyOfHttp(method: string, headers: Record<string, unknown> = {}): Idempotency {
  const verb = method.trim().toUpperCase();
  if (verb === "GET" || verb === "HEAD") return { kind: "read" };
  if (verb === "PUT" || verb === "DELETE") return { kind: "idempotent", key: "method" };
  const keyed = Object.keys(headers).some(name => /^idempotency-key$/i.test(name));
  return keyed ? { kind: "idempotent", key: "Idempotency-Key" } : { kind: "unsafe" };
}

/** What an MCP server's own annotations say, when it says anything (MCP `tools/list`). */
export function idempotencyOfAnnotations(annotations: Record<string, unknown> | undefined): Idempotency | undefined {
  if (annotations === undefined) return undefined;
  if (annotations.readOnlyHint === true) return { kind: "read" };
  if (annotations.idempotentHint === true) return { kind: "idempotent" };
  if (annotations.idempotentHint === false) return { kind: "unsafe" };
  return undefined;
}

export interface RetryPlan {
  /** Whether the caller may send it again after losing the answer. */
  retry: boolean;
  /** What the model is told, when it is not retried. */
  note?: string;
}

/**
 * What to do when the answer was lost. `input` decides an idempotent tool's case: the
 * declaration names the field that makes it idempotent, and a call without that field
 * does not get the benefit of it.
 */
export function afterTimeout(
  declaration: Idempotency,
  input: Record<string, unknown> = {},
  attempt = 1
): RetryPlan {
  if (declaration.kind === "read") {
    return attempt <= 1 ? { retry: true } : { retry: false, note: "the read did not answer twice; treat it as unread rather than empty" };
  }
  if (declaration.kind === "idempotent") {
    const keyed = declaration.key === undefined || (input[declaration.key] !== undefined && input[declaration.key] !== "");
    if (!keyed) {
      return {
        retry: false,
        note: `this call left out ${declaration.key}, which is what would have made repeating it safe, so it was not repeated — it may already have taken effect`,
      };
    }
    return attempt <= 1
      ? { retry: true }
      : { retry: false, note: "it was already retried once and the answer was lost again; check the target's state before sending a third" };
  }
  return {
    retry: false,
    note: "it may already have taken effect — check before doing it again, and say what you found",
  };
}
