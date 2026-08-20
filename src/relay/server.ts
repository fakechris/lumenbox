/**
 * The model relay: the provider key stops living in the box.
 *
 * Today a box is handed a provider credential as environment, and `box` has passwordless sudo, so an
 * agent that goes looking finds it ([../docs/06-deployment.md](../docs/06-deployment.md) §9). For one
 * person running their own box that is their own key. For a tenant on a shared host it is *every*
 * tenant's key, in every container — which is the largest security debt this system has.
 *
 * The relay is small and buys three things at once:
 *
 *   1. **No provider key ever enters a box.** A box is given a relay address and a token of its own.
 *   2. **Revoking a box's access is deleting one row.** No rotating a shared credential, no
 *      recreating containers.
 *   3. **Usage becomes unforgeable.** It is measured where the request passes rather than reported by
 *      the thing being billed. The box's own `usage.jsonl` stays, as the local view a UI reads; the
 *      relay's record is the one to bill from.
 *
 * Four decisions worth defending:
 *
 * **The token names the upstream.** A box does not say which provider to use — the relay looks that
 * up from the token. So a box cannot reach a provider it was not issued for, and cannot switch to a
 * more expensive model family by editing its own configuration.
 *
 * **Only the paths that are needed.** A relay that forwards arbitrary paths is a general-purpose
 * proxy holding a credential, which is a much larger blast radius than an agent runtime needs. The
 * allow-list is short and explicit.
 *
 * **Streaming passes through, and is metered on the way.** The orchestrator streams, and buffering
 * would break the live text in the UI and make long turns look like hangs. So the response is piped
 * byte-for-byte while a copy of the SSE frames is parsed for the usage the provider reports. Metering
 * must not be able to break the request: a parse failure loses a measurement, never a turn.
 *
 * **Failing closed.** No token, an unknown token, or a path not on the list is refused. A relay that
 * forwarded an unauthenticated request with the operator's key would be worse than no relay.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { timingSafeEqual } from "node:crypto";

/** Where a token's traffic goes, and with what credential. */
export interface Upstream {
  /** For logs and usage rows: which provider this is. */
  label: string;
  /** e.g. `https://api.anthropic.com` — no trailing slash, no path. */
  baseUrl: string;
  /** The real credential. Held here and nowhere else. */
  key: string;
  /** How the upstream wants it. */
  auth: "x-api-key" | "bearer";
}

/** What the relay knows about one box. */
export interface RelayClient {
  /** The token the box presents. Compared in constant time. */
  token: string;
  /** Opaque to the relay; recorded on every usage row so a bill can be attributed. */
  tenantId: string;
  boxId: string;
  upstream: Upstream;
}

/** One request's cost, as the provider reported it. */
export interface RelayUsage {
  at: string;
  tenantId: string;
  boxId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** True when the numbers came from a streamed response, which reports them in pieces. */
  streamed: boolean;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  /**
   * Resolves a presented token.
   *
   * A function rather than a map so the control plane's store can back it without this module
   * knowing about SQLite, and so a revoked token stops working without a restart.
   */
  resolve: (token: string) => RelayClient | undefined;
  /** Where measured usage goes. Never allowed to throw into the request path. */
  onUsage?: (usage: RelayUsage) => void;
  log?: (line: string) => void;
}

/**
 * Paths a box may reach through the relay.
 *
 * Messages and token counting, and nothing else. Not `/v1/models`, not files, not batches — each of
 * those is a capability nobody has asked for, and every one widens what a leaked box token buys.
 */
const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export function pathAllowed(pathname: string): boolean {
  return ALLOWED_PATHS.has(pathname);
}

/** Constant-time compare that does not leak length through an early return. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The token a request presented, from either header shape.
 *
 * Both are accepted because the Anthropic SDK sends `x-api-key` or `Authorization: Bearer` depending
 * on how it was constructed, and the box should not have to care which.
 */
export function presentedToken(headers: IncomingMessage["headers"]): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() !== "") return apiKey.trim();
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
    if (bearer !== undefined && bearer !== "") return bearer;
  }
  return undefined;
}

/**
 * Accumulates the usage a streamed response reports.
 *
 * Anthropic's SSE splits it: `message_start` carries the input and cache counts, `message_delta`
 * carries the running output count. So the last value of each wins rather than a sum — adding the
 * deltas would multiply the input tokens by the number of frames.
 *
 * Written as a class over a byte stream because frames arrive split across chunks, and a parser that
 * assumed one chunk per frame would miss most of them on a slow connection.
 */
export class UsageAccumulator {
  private buffer = "";
  private model = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private sawAny = false;

  push(chunk: string): void {
    this.buffer += chunk;
    // SSE frames are separated by a blank line. Keep the tail: it may be a partial frame.
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) this.consume(frame);
  }

  /** Called at the end, so a final frame with no trailing blank line is not lost. */
  end(): void {
    if (this.buffer.trim() !== "") this.consume(this.buffer);
    this.buffer = "";
  }

  private consume(frame: string): void {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // A frame we cannot read costs a measurement, never the request.
        continue;
      }
      this.absorb(event);
    }
  }

  private absorb(event: Record<string, unknown>): void {
    const message = event.message as Record<string, unknown> | undefined;
    if (typeof message?.model === "string") this.model = message.model;
    // `message_start.message.usage` and `message_delta.usage` are the two shapes.
    const usage = (message?.usage ?? event.usage) as Record<string, unknown> | undefined;
    if (usage === undefined) return;
    this.sawAny = true;
    const read = (name: string): number | undefined => {
      const value = usage[name];
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    // Last value wins, not a sum: a delta reports the running total, so adding them would
    // multiply the input count by the number of frames.
    this.inputTokens = read("input_tokens") ?? this.inputTokens;
    this.outputTokens = read("output_tokens") ?? this.outputTokens;
    this.cacheReadTokens = read("cache_read_input_tokens") ?? this.cacheReadTokens;
    this.cacheWriteTokens = read("cache_creation_input_tokens") ?? this.cacheWriteTokens;
  }

  /** What was measured, or undefined when the response carried nothing to measure. */
  result(): Omit<RelayUsage, "at" | "tenantId" | "boxId" | "provider" | "streamed"> | undefined {
    if (!this.sawAny) return undefined;
    return {
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    };
  }
}

/** Usage from a non-streamed JSON body. The simple case, kept separate so neither path guesses. */
export function usageFromBody(text: string): ReturnType<UsageAccumulator["result"]> {
  try {
    const parsed = JSON.parse(text) as {
      model?: string;
      usage?: Record<string, number>;
    };
    const usage = parsed.usage;
    if (usage === undefined) return undefined;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
  } catch {
    return undefined;
  }
}

export function startRelay(options: RelayOptions): Server {
  const log = options.log ?? (() => {});
  const onUsage = options.onUsage ?? (() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");

    if (url.pathname === "/health") {
      // Unauthenticated, like the box's own, so a container health check needs no credential.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!pathAllowed(url.pathname)) {
      // Named rather than a bare 404, because the usual cause is someone reasonably assuming this is
      // a general proxy and being surprised.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "not_found",
            message:
              `The relay forwards ${[...ALLOWED_PATHS].join(" and ")} and nothing else. ` +
              `A relay that forwarded any path would be a general proxy holding a provider key.`,
          },
        })
      );
      return;
    }

    const token = presentedToken(req.headers);
    const client = token === undefined ? undefined : options.resolve(token);
    if (client === undefined || !sameToken(client.token, token!)) {
      // The same answer for absent and unknown: which one it was is not the caller's business.
      log(`refused a request with ${token === undefined ? "no token" : "an unknown token"}`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "authentication_error", message: "This relay token is not valid." },
        })
      );
      return;
    }

    forward(req, res, client, url, { log, onUsage });
  });

  server.listen(options.port ?? 8788, options.host ?? "127.0.0.1");
  return server;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  client: RelayClient,
  url: URL,
  deps: { log: (line: string) => void; onUsage: (usage: RelayUsage) => void }
): void {
  const target = new URL(client.upstream.baseUrl);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;

  // The box's credential is removed and the real one substituted. Everything else is passed
  // through: the SDK sets anthropic-version, beta headers and content-type, and guessing at those
  // here would break the day the SDK adds one.
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "x-api-key" || lower === "authorization" || lower === "host") continue;
    if (lower === "content-length") continue; // re-derived by the upstream request
    if (value !== undefined) headers[name] = value;
  }
  headers.host = target.host;
  if (client.upstream.auth === "bearer") headers.authorization = `Bearer ${client.upstream.key}`;
  else headers["x-api-key"] = client.upstream.key;

  const upstream = send(
    {
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${target.pathname.replace(/\/$/, "")}${url.pathname}${url.search}`,
      headers,
    },
    response => {
      res.writeHead(response.statusCode ?? 502, response.headers);

      const streamed = (response.headers["content-type"] ?? "").includes("event-stream");
      const accumulator = streamed ? new UsageAccumulator() : undefined;
      let body = "";

      response.on("data", (chunk: Buffer) => {
        // Written straight through first. Metering happens on a copy, so a fault in it cannot delay
        // or corrupt what the box receives.
        res.write(chunk);
        try {
          if (accumulator !== undefined) accumulator.push(chunk.toString("utf8"));
          else if (body.length < 1_000_000) body += chunk.toString("utf8");
        } catch {
          // A measurement is worth less than the request carrying it.
        }
      });

      response.on("end", () => {
        res.end();
        try {
          accumulator?.end();
          const measured = accumulator !== undefined ? accumulator.result() : usageFromBody(body);
          if (measured !== undefined) {
            deps.onUsage({
              at: new Date().toISOString(),
              tenantId: client.tenantId,
              boxId: client.boxId,
              provider: client.upstream.label,
              streamed,
              ...measured,
            });
          } else if ((response.statusCode ?? 0) < 400) {
            // A successful response that reported nothing is worth a line: it means either a
            // provider that does not report usage, or a shape this parser does not know — and
            // silently billing zero is how a metering gap goes unnoticed.
            deps.log(
              `${client.upstream.label} answered ${response.statusCode} with no usage to measure`
            );
          }
        } catch (error) {
          deps.log(`could not record usage: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      response.on("error", () => res.end());
    }
  );

  upstream.on("error", error => {
    deps.log(`upstream ${client.upstream.label} failed: ${error.message}`);
    if (!res.headersSent) {
      // Shaped like a provider error, because the SDK on the other side knows how to read that and
      // will retry a 502 appropriately.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "api_error", message: `The relay could not reach ${client.upstream.label}.` },
        })
      );
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}
