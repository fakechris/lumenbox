/**
 * The model relay: a delegated engine's model traffic, through the host, on a per-job route.
 *
 * Claude Code, pi and opencode all speak to a model over HTTP with a credential in the
 * environment. The rule here is that no credential enters the box (docs/08 §7), and the
 * presets file has said since docs/25 that the seam for that is a relay "nothing in this
 * repository provides yet". This provides it: a route minted per delegation, a bearer that
 * is only good for that route, a lease the engine keeps alive by using it, and one place
 * where the provider's real key is attached. The engine is told `ANTHROPIC_BASE_URL` (or
 * the OpenAI equivalent, or a models.json entry) pointing here, and it never learns more.
 *
 * Same address and lifetime rules as the MCP face (docs/33): reached at `faceBaseUrl`,
 * which an attached box cannot reach, so an attached box gets no relay and is told so.
 *
 * Bytes are forwarded, not rewritten — the wire is the provider's own, so a Claude Code
 * that expects Anthropic's Messages API gets exactly that, streaming included. The relay
 * reads the stream as it passes only to count tokens, which is how a delegated run becomes
 * a row in usage.jsonl with the agent, the work and the job on it (kind `delegate`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderProfile } from "./provider.ts";
import type { UsageLog } from "./usage.ts";

export const RELAY_PATH = /^\/relay\/([0-9a-f]{32})(\/.*)?$/;
/** How long a route lives without traffic, and the absolute ceiling with it. */
export const RELAY_LEASE_MS = 30 * 60_000;
export const RELAY_CEILING_MS = 12 * 60 * 60_000;
const IN_FLIGHT_LIMIT = 8;
const BODY_LIMIT_BYTES = 32 * 1024 * 1024;
/** What an engine may call. Anything else on the provider is not the engine's business. */
const ALLOWED_SUFFIX = /^\/(v1\/)?(messages|chat\/completions|responses|models)(\/.*)?$/;

export interface RelayRoute {
  key: string;
  token: string;
  agentId: string;
  agentName: string;
  conversation: string;
  workId?: string;
  jobId?: string;
  preset: string;
  createdAt: number;
  leaseUntil: number;
  ceiling: number;
  inFlight: number;
  calls: number;
}

export interface ModelRelayDeps {
  /** The provider a delegated engine's traffic goes to, and the key for it. */
  provider: () => ProviderProfile;
  key: (profile: ProviderProfile) => string | undefined;
  usage?: () => UsageLog | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface Counted {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Token counts out of whatever the provider answered: an Anthropic message or stream, an
 * OpenAI completion or stream. Best effort — a body this cannot read counts as nothing,
 * which understates rather than invents.
 */
export function countUsage(body: string): Counted {
  const counted: Counted = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const absorb = (usage: unknown) => {
    if (typeof usage !== "object" || usage === null) return;
    const u = usage as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    // Anthropic names.
    if ("input_tokens" in u) counted.inputTokens = Math.max(counted.inputTokens, n(u.input_tokens));
    if ("output_tokens" in u) counted.outputTokens = Math.max(counted.outputTokens, n(u.output_tokens));
    if ("cache_read_input_tokens" in u) counted.cacheReadTokens = Math.max(counted.cacheReadTokens, n(u.cache_read_input_tokens));
    if ("cache_creation_input_tokens" in u) counted.cacheWriteTokens = Math.max(counted.cacheWriteTokens, n(u.cache_creation_input_tokens));
    // OpenAI names.
    if ("prompt_tokens" in u) counted.inputTokens = Math.max(counted.inputTokens, n(u.prompt_tokens));
    if ("completion_tokens" in u) counted.outputTokens = Math.max(counted.outputTokens, n(u.completion_tokens));
    const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
    if (details !== undefined && "cached_tokens" in details) {
      counted.cacheReadTokens = Math.max(counted.cacheReadTokens, n(details.cached_tokens));
    }
  };
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
    if (line === "" || line === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    absorb(event.usage);
    const message = event.message as Record<string, unknown> | undefined;
    if (message !== undefined) absorb(message.usage);
  }
  return counted;
}

export class ModelRelay {
  /** Where the box reaches this host; set by the web server once it listens. */
  baseUrl: string | undefined;
  private readonly routes = new Map<string, RelayRoute>();
  private readonly now: () => number;

  constructor(private readonly deps: ModelRelayDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The provider's wire, as a preset needs to know it to speak through the relay. */
  wire(): "anthropic" | "openai" {
    return this.deps.provider().wire === "openai" ? "openai" : "anthropic";
  }

  /** The model the provider is configured for, in the provider's own name. */
  model(): string {
    return this.deps.provider().model;
  }

  mint(input: {
    agentId: string;
    agentName: string;
    conversation: string;
    workId?: string;
    preset: string;
  }): { route: RelayRoute; url: string } | { error: string } {
    if (this.baseUrl === undefined) {
      return { error: "The model relay has no address yet (the web server has not said where the box can reach it)." };
    }
    const profile = this.deps.provider();
    if (this.deps.key(profile) === undefined) {
      return { error: `The relay has no credential for ${profile.label}: set ${profile.keyEnv} on the host.` };
    }
    const now = this.now();
    const route: RelayRoute = {
      key: randomBytes(16).toString("hex"),
      token: randomBytes(32).toString("hex"),
      agentId: input.agentId,
      agentName: input.agentName,
      conversation: input.conversation,
      ...(input.workId !== undefined ? { workId: input.workId } : {}),
      preset: input.preset,
      createdAt: now,
      leaseUntil: now + RELAY_LEASE_MS,
      ceiling: now + RELAY_CEILING_MS,
      inFlight: 0,
      calls: 0,
    };
    this.routes.set(route.key, route);
    this.deps.log?.(`relay route ${route.key} minted for ${input.agentName} (${input.preset} → ${profile.label})`);
    return { route, url: `${this.baseUrl.replace(/\/$/, "")}/relay/${route.key}` };
  }

  bindJob(key: string, jobId: string): void {
    const route = this.routes.get(key);
    if (route !== undefined) route.jobId = jobId;
  }

  revoke(key: string, why: string): void {
    if (this.routes.delete(key)) this.deps.log?.(`relay route ${key} revoked: ${why}`);
  }

  revokeAll(why: string): number {
    const count = this.routes.size;
    for (const key of [...this.routes.keys()]) this.revoke(key, why);
    return count;
  }

  /** The bearer, or the x-api-key an Anthropic-wire engine sends instead; one 401 for every way to be wrong. */
  authenticate(key: string, headers: IncomingMessage["headers"]): RelayRoute | undefined {
    const route = this.routes.get(key);
    if (route === undefined) return undefined;
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1]?.trim();
    const apiKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : undefined;
    const presented = bearer ?? apiKey;
    if (presented === undefined || presented === "" || !sameSecret(route.token, presented)) return undefined;
    const now = this.now();
    if (now > route.leaseUntil || now > route.ceiling) {
      this.revoke(key, now > route.ceiling ? "ceiling reached" : "lease lapsed");
      return undefined;
    }
    // Using the route is what keeps it: an engine mid-task renews itself by talking.
    route.leaseUntil = Math.min(route.ceiling, now + RELAY_LEASE_MS);
    return route;
  }

  active(): readonly RelayRoute[] {
    return [...this.routes.values()];
  }

  /** Drops routes past their lease; called on a timer beside the face's renew. */
  sweep(): number {
    const now = this.now();
    let dropped = 0;
    for (const [key, route] of this.routes) {
      if (now > route.leaseUntil || now > route.ceiling) {
        this.revoke(key, now > route.ceiling ? "ceiling reached" : "lease lapsed");
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Forwards one request. The engine's own credential headers are dropped and the
   * provider's attached; everything else about the request rides as sent.
   */
  async proxy(req: IncomingMessage, res: ServerResponse, route: RelayRoute, suffix: string): Promise<void> {
    if (!ALLOWED_SUFFIX.test(suffix)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `The relay does not forward ${suffix}.` } }));
      return;
    }
    if (route.inFlight >= IN_FLIGHT_LIMIT) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `${IN_FLIGHT_LIMIT} requests are already in flight on this route.` } }));
      return;
    }
    const profile = this.deps.provider();
    const key = this.deps.key(profile);
    if (key === undefined) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `The host has no credential for ${profile.label}.` } }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > BODY_LIMIT_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Request body too large for the relay." } }));
        return;
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    let model = profile.model;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
      if (typeof parsed.model === "string" && parsed.model !== "") model = parsed.model;
    } catch {
      // Not JSON, or empty: a models listing.
    }

    const upstream = `${(profile.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}${suffix}`;
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent", "x-stainless-lang", "x-app"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (profile.auth === "bearer") headers.authorization = `Bearer ${key}`;
    else headers["x-api-key"] = key;

    route.inFlight += 1;
    route.calls += 1;
    const doFetch = this.deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(upstream, {
        method: req.method ?? "POST",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (error) {
      route.inFlight -= 1;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `The relay could not reach ${profile.label}: ${error instanceof Error ? error.message : String(error)}` } }));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of ["content-type", "cache-control", "anthropic-ratelimit-requests-remaining", "retry-after", "request-id"]) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders[name] = value;
    }
    res.writeHead(response.status, responseHeaders);
    // Counted as it passes: the whole body is kept only up to a cap, which is far more
    // than the usage events need, and a stream longer than that is still forwarded whole.
    const seen: string[] = [];
    let seenBytes = 0;
    try {
      if (response.body === null) {
        res.end();
      } else {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          if (seenBytes < 4 * 1024 * 1024) {
            seen.push(Buffer.from(value).toString("utf8"));
            seenBytes += value.length;
          }
          if (!res.write(value)) await new Promise<void>(resolve => res.once("drain", resolve));
        }
        res.end();
      }
    } catch (error) {
      this.deps.log?.(`relay route ${route.key}: stream ended early (${error instanceof Error ? error.message : String(error)})`);
      res.end();
    } finally {
      route.inFlight -= 1;
      const counted = countUsage(seen.join(""));
      const usage = this.deps.usage?.();
      if (usage !== undefined && response.status < 400) {
        usage.record({
          kind: "delegate",
          agentId: route.agentId,
          agentName: route.agentName,
          ...(route.workId !== undefined ? { workId: route.workId } : {}),
          conversation: route.conversation,
          provider: profile.label,
          model,
          round: route.calls,
          ...counted,
        });
      }
    }
  }
}
