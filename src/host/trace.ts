import { randomBytes } from "node:crypto";

/**
 * Where LLM-call spans go: an OTLP/HTTP endpoint (an opik collector, a Jaeger
 * OTLP receiver, anything that speaks the protocol). Off unless configured —
 * the default box has no tracer at all, and this file is the only place that
 * knows the wire format.
 *
 * Zero-dependency by design (the repo rule): OTLP/HTTP JSON is one POST, and
 * delivery is fire-and-forget in the webhookDelivery sense — a dead collector
 * must never slow, fail, or even be visible to the turn being traced.
 */

export type SpanAttributeValue = string | number | boolean;

export interface SpanHandle {
  /**
   * Closes the span and queues it for delivery. `error` marks it failed and
   * records the message; the span is still sent — a failed call is exactly
   * the one a trace backend is for.
   */
  end(attributes?: Record<string, SpanAttributeValue>, error?: unknown): void;
}

export interface Tracer {
  /**
   * Opens a span. `traceId` groups spans across calls: pass a uuid and its
   * dashes are stripped to the 32 hex characters OTLP wants, so every round
   * of one turn lands in one trace.
   */
  start(
    name: string,
    attributes?: Record<string, SpanAttributeValue>,
    opts?: { traceId?: string }
  ): SpanHandle;
  /** Sends whatever is queued now. Exists for tests and clean shutdowns. */
  flush(): Promise<void>;
}

export interface OtlpTracerOptions {
  /** Injectable for tests, the repo's standing convention. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Extra resource attributes, beyond service.name. */
  resource?: Record<string, SpanAttributeValue>;
  /** Flush cadence and batch size; tests shrink them. */
  flushIntervalMs?: number;
  flushAt?: number;
}

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function otlpValue(value: SpanAttributeValue): OtlpValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  // int64 is a string in OTLP JSON: a 2^53-safe integer survives, a double would not.
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function otlpAttributes(attributes: Record<string, SpanAttributeValue>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/** A uuid without its dashes is already a valid OTLP trace id; anything else gets a fresh one. */
function traceIdOf(hint: string | undefined): string {
  const stripped = hint?.replace(/-/g, "") ?? "";
  return /^[0-9a-f]{32}$/i.test(stripped) ? stripped.toLowerCase() : randomBytes(16).toString("hex");
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: ReturnType<typeof otlpAttributes>;
  status: { code: number; message?: string };
}

/**
 * The collector address, configured as the *base* (opik: `http://host:8080/api/v1/private/otel`)
 * with `/v1/traces` appended here — one thing to document, and a URL pasted with the path
 * already on it is not double-suffixed.
 */
export function tracesEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

/**
 * A minimal OTLP/HTTP tracer. Spans are buffered and posted in batches; every
 * failure is logged (throttled, so a dead endpoint does not spam one line per
 * round) and dropped, never thrown into the caller.
 */
export function otlpTracer(baseUrl: string, options?: OtlpTracerOptions): Tracer {
  const endpoint = tracesEndpoint(baseUrl);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const log = options?.log ?? (() => {});
  const flushAt = options?.flushAt ?? 32;
  const resource = otlpAttributes({
    "service.name": "agentbox-host",
    ...(options?.resource ?? {}),
  });
  const queue: FinishedSpan[] = [];
  let sending = false;
  let lastFailureLog = 0;

  const timer = setInterval(() => {
    if (queue.length > 0) void flush();
  }, options?.flushIntervalMs ?? 5_000);
  timer.unref?.();

  async function flush(): Promise<void> {
    // A send already in flight owns the queue's contents; draining here too would post them twice.
    if (sending || queue.length === 0) return;
    sending = true;
    const batch = queue.splice(0, queue.length);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: resource },
              scopeSpans: [{ scope: { name: "agentbox-host" }, spans: batch }],
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`collector returned ${response.status}`);
      }
    } catch (error) {
      // The batch is dropped either way: retrying a dead collector would pile spans up
      // without bound, which is how an observability feature becomes the outage.
      const now = Date.now();
      if (now - lastFailureLog > 60_000) {
        lastFailureLog = now;
        log(
          `dropped ${batch.length} span(s): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      sending = false;
    }
  }

  return {
    start(name, attributes, opts) {
      const spanId = randomBytes(8).toString("hex");
      const traceId = traceIdOf(opts?.traceId);
      const startNanos = String(Date.now() * 1_000_000);
      return {
        end(extra, error) {
          const merged = { ...(attributes ?? {}), ...(extra ?? {}) };
          queue.push({
            traceId,
            spanId,
            name,
            kind: 3, // CLIENT: every span here is an outbound LLM call.
            startTimeUnixNano: startNanos,
            endTimeUnixNano: String(Date.now() * 1_000_000),
            attributes: otlpAttributes(merged),
            status:
              error === undefined
                ? { code: 1 }
                : {
                    code: 2,
                    // Bounded: provider errors can carry a whole request echo.
                    message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
                  },
          });
          if (queue.length >= flushAt) void flush();
        },
      };
    },
    flush,
  };
}

/**
 * The tracer the environment asks for, or none. `AGENTBOX_TRACE_URL` unset or
 * blank means no tracer exists at all — the turn engine's `deps.tracer?.` then
 * costs one property lookup per round, and the system behaves exactly as before.
 */
export function tracerFromEnv(env: NodeJS.ProcessEnv = process.env): Tracer | undefined {
  const url = env.AGENTBOX_TRACE_URL?.trim();
  if (url === undefined || url === "") return undefined;
  return otlpTracer(url, { log: line => console.error(`[trace] ${line}`) });
}
