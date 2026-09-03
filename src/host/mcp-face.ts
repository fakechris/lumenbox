/**
 * The box's MCP face (docs/33): a delegated engine inside the box reaches the host's MCP tools
 * through a per-job route on the host, and never holds a credential.
 *
 * A route is minted when `Delegate` starts an engine with tools named: a key in the path, a
 * bearer token in the job's environment, the exact tool names it may call (expanded from the
 * request at mint, intersected with what the delegating turn itself may call), and a lease the
 * host renews from `box.jobs()` while the job is running. `tools/call` runs the policy gate
 * with `delegated` set (no approval reuse, no input in the log), the PreToolUse/PostToolUse
 * hooks, then `McpManager.call`; the result is clamped and a line goes to the audit ledger with
 * a digest of it. WorkBuddy's `LocalMcpHost` and QwenWork's "MCP Adaptor" are the shape
 * (research/2026-09-02-coordination-mcp-memory.md §二).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";
import type { HookRunner } from "./hooks.ts";
import { appendLine } from "./jsonl.ts";
import { MCP_SEPARATOR, type McpTool } from "./mcp.ts";
import type { PolicyGate } from "./policy.ts";
import type { McpServerTool } from "../web/mcp-server.ts";

export const MCP_FACE_TOKEN_VARIABLE = "LUMENBOX_MCP_TOKEN";
/** Where a route's config file lives in the box: under the work root, never inside a repository. */
export const MCP_FACE_DIR = "/home/box/work/.lumenbox/mcp";
export const ROUTE_PATH = /^\/mcp\/r\/([0-9a-f]{32})$/;

export const LEASE_MS = 30 * 60_000;
export const CEILING_MS = 12 * 60 * 60_000;
export const RENEW_EVERY_MS = 5 * 60_000;
/** Calls in flight per route before the next one is refused. */
export const IN_FLIGHT_LIMIT = 4;
/** A route's result is clamped here; a direct call's is clamped only on replay. */
export const RESULT_MAX_CHARS = 200_000;

export function auditPath(): string {
  return process.env.AGENTBOX_DELEGATE_CALLS ?? join(agentboxHome(), "delegate-calls.jsonl");
}

export interface McpRoute {
  key: string;
  token: string;
  agentId: string;
  agentName: string;
  conversation: string;
  workId?: string;
  jobId?: string;
  /** Exact tool names, expanded at mint. */
  allowed: string[];
  createdAt: number;
  leaseUntil: number;
  ceiling: number;
  inFlight: number;
}

/** What the face needs from the host, narrowed so it can be faked. */
export interface McpFaceDeps {
  mcp: () => { tools(): McpTool[]; call(name: string, input: unknown): Promise<string> } | undefined;
  policy?: PolicyGate;
  hooks?: HookRunner;
  /** The box a job runs in, for the lease's liveness check. */
  jobsOf: (agentId: string) => Promise<{ job_id: string; running?: boolean; status?: string }[]> | undefined;
  /** `null` keeps no audit file. */
  auditPath?: string | null;
  log?: (line: string) => void;
  now?: () => number;
  onEvent?: (event: { type: "delegate_call"; agentId: string; agentName: string; conversation: string; tool: string; ok: boolean; ms: number }) => void;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Expands a request (`server__tool` or `server__*`) against the tools a turn may call.
 *
 * Exact names at mint, never a live wildcard: a server hot-swapped by `mcp reload` must not
 * hand a running engine tools nobody named. A wildcard that matches nothing is an error, so a
 * typo does not become a silent empty face.
 */
export function expandRequested(
  requested: readonly string[],
  allowedMcp: readonly string[]
): { allowed: string[] } | { error: string } {
  const allowed = new Set<string>();
  const known = new Set(allowedMcp);
  for (const raw of requested) {
    const name = raw.trim();
    if (name === "") continue;
    if (name.endsWith(`${MCP_SEPARATOR}*`)) {
      const prefix = name.slice(0, -1);
      const matches = allowedMcp.filter(tool => tool.startsWith(prefix));
      if (matches.length === 0) return { error: `${name} matches no MCP tool you may call.` };
      for (const match of matches) allowed.add(match);
      continue;
    }
    if (!known.has(name)) return { error: `${name} is not an MCP tool you may call, so you cannot lend it.` };
    allowed.add(name);
  }
  if (allowed.size === 0) return { error: "No MCP tools were named." };
  return { allowed: [...allowed].sort() };
}

export class McpFace {
  private readonly routes = new Map<string, McpRoute>();
  /** Where the box reaches this host: set once the web server knows its port and topology. */
  baseUrl: string | undefined;

  constructor(private readonly deps: McpFaceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Mints a route for a job about to start. `allowedMcp` is the delegating turn's own effective
   * MCP list — profile ∩ scope ∩ the chat's bound scope — computed by the turn, never here.
   */
  mint(input: {
    agentId: string;
    agentName: string;
    conversation: string;
    workId?: string;
    requested: readonly string[];
    allowedMcp: readonly string[];
  }): { route: McpRoute; url: string } | { error: string } {
    if (input.conversation.startsWith("fork/")) {
      return { error: "A fork cannot delegate with tools: a child never has more than its parent." };
    }
    if (this.baseUrl === undefined) {
      return { error: "The MCP face has no address yet (the web server has not said where the box can reach it)." };
    }
    const expanded = expandRequested(input.requested, input.allowedMcp);
    if ("error" in expanded) return expanded;
    const now = this.now();
    const route: McpRoute = {
      key: randomBytes(16).toString("hex"),
      token: randomBytes(32).toString("hex"),
      agentId: input.agentId,
      agentName: input.agentName,
      conversation: input.conversation,
      ...(input.workId !== undefined ? { workId: input.workId } : {}),
      allowed: expanded.allowed,
      createdAt: now,
      leaseUntil: now + LEASE_MS,
      ceiling: now + CEILING_MS,
      inFlight: 0,
    };
    this.routes.set(route.key, route);
    this.deps.log?.(`route ${route.key} minted for ${input.agentName}: ${route.allowed.join(", ")}`);
    return { route, url: `${this.baseUrl.replace(/\/$/, "")}/mcp/r/${route.key}` };
  }

  /** The job the route serves, once the box has named it. */
  bindJob(key: string, jobId: string): void {
    const route = this.routes.get(key);
    if (route !== undefined) route.jobId = jobId;
  }

  revoke(key: string, why: string): void {
    if (this.routes.delete(key)) this.deps.log?.(`route ${key} revoked: ${why}`);
  }

  /** Every route, e.g. when the MCP server list changes underneath them (docs/33 §0a). */
  revokeAll(why: string): number {
    const count = this.routes.size;
    for (const key of [...this.routes.keys()]) this.revoke(key, why);
    return count;
  }

  /** Path parsing, then the bearer, then the lease: one 401 for every way to be wrong. */
  authenticate(key: string, presented: string | undefined): McpRoute | undefined {
    const route = this.routes.get(key);
    if (route === undefined || presented === undefined || presented === "") return undefined;
    if (!sameSecret(route.token, presented)) return undefined;
    const now = this.now();
    if (now > route.leaseUntil || now > route.ceiling) {
      this.revoke(key, now > route.ceiling ? "ceiling reached" : "lease lapsed");
      return undefined;
    }
    return route;
  }

  /** For the web log and tests. */
  active(): readonly McpRoute[] {
    return [...this.routes.values()];
  }

  /**
   * Extends the lease of every route whose job the box still lists as running; ends the rest.
   * Called by the web server every `RENEW_EVERY_MS`. A route with no job yet (the start is in
   * flight) keeps its first lease untouched.
   */
  async renew(): Promise<void> {
    const now = this.now();
    for (const route of [...this.routes.values()]) {
      if (now > route.ceiling) {
        this.revoke(route.key, "ceiling reached");
        continue;
      }
      if (route.jobId === undefined) continue;
      let jobs: { job_id: string; running?: boolean; status?: string }[] | undefined;
      try {
        jobs = await this.deps.jobsOf(route.agentId);
      } catch {
        // The box did not answer: the lease is not renewed and lapses on its own if that lasts.
        continue;
      }
      if (jobs === undefined) continue;
      const mine = jobs.find(job => job.job_id === route.jobId);
      const running = mine !== undefined && (mine.running === true || mine.status === "running");
      if (running) route.leaseUntil = Math.min(now + LEASE_MS, route.ceiling);
      else this.revoke(route.key, mine === undefined ? "job gone" : `job ${mine.status ?? "ended"}`);
    }
  }

  /** The MCP tools a route serves, each running through the gate, the hooks and the ledger. */
  toolsFor(route: McpRoute): McpServerTool[] {
    const manager = this.deps.mcp();
    const live = new Map((manager?.tools() ?? []).map(tool => [tool.name, tool]));
    return route.allowed.map(name => {
      const tool = live.get(name);
      return {
        name,
        description: tool?.description ?? `${name} (its server is not up right now)`,
        inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
        // Unknown external tools are not read-only by assumption.
        readOnly: false,
        run: (input: Record<string, unknown>) => this.call(route, name, input),
      };
    });
  }

  private async call(route: McpRoute, name: string, input: Record<string, unknown>): Promise<string> {
    if (route.inFlight >= IN_FLIGHT_LIMIT) {
      throw new Error(`${IN_FLIGHT_LIMIT} calls are already in flight on this route; wait for one to finish.`);
    }
    route.inFlight += 1;
    const started = this.now();
    let ok = false;
    let text = "";
    try {
      const decision = this.deps.policy?.check({
        kind: "tool",
        agentId: route.agentId,
        agentName: route.agentName,
        tool: name,
        input,
        delegated: { ...(route.jobId !== undefined ? { jobId: route.jobId } : {}) },
      });
      if (decision !== undefined && !decision.allow) throw new Error(decision.reason);
      if (this.deps.hooks?.has("PreToolUse", name)) {
        const hook = await this.deps.hooks.run("PreToolUse", {
          session_id: route.jobId ?? route.key,
          agent_name: route.agentName,
          tool_name: name,
          tool_input: input,
          delegated: true,
        });
        if (hook.blocked) throw new Error(`Blocked by a PreToolUse hook: ${hook.reason ?? "no reason given"}`);
      }
      const manager = this.deps.mcp();
      if (manager === undefined) throw new Error("No MCP servers are connected on the host.");
      text = await manager.call(name, input);
      if (text.length > RESULT_MAX_CHARS) text = `${text.slice(0, RESULT_MAX_CHARS)}\n[clamped to ${RESULT_MAX_CHARS} characters]`;
      if (this.deps.hooks?.has("PostToolUse", name)) {
        const hook = await this.deps.hooks.run("PostToolUse", {
          session_id: route.jobId ?? route.key,
          agent_name: route.agentName,
          tool_name: name,
          tool_input: input,
          tool_response: text.slice(0, 20_000),
          is_error: false,
          delegated: true,
        });
        if (hook.blocked && hook.reason) text = `${text}\n\n[PostToolUse hook] ${hook.reason}`;
      }
      ok = true;
      return text;
    } finally {
      route.inFlight -= 1;
      const ms = this.now() - started;
      this.audit({
        at: new Date(this.now()).toISOString(),
        routeKey: route.key,
        agentId: route.agentId,
        ...(route.workId !== undefined ? { workId: route.workId } : {}),
        ...(route.jobId !== undefined ? { jobId: route.jobId } : {}),
        tool: name,
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        resultBytes: Buffer.byteLength(text),
        resultSha256: createHash("sha256").update(text).digest("hex"),
        ok,
        ms,
      });
      this.deps.log?.(`${route.agentName} job ${route.jobId ?? route.key}: ${name} ${ok ? "ok" : "refused/failed"} (${ms} ms)`);
      this.deps.onEvent?.({
        type: "delegate_call",
        agentId: route.agentId,
        agentName: route.agentName,
        conversation: route.conversation,
        tool: name,
        ok,
        ms,
      });
    }
  }

  private audit(record: Record<string, unknown>): void {
    const path = this.deps.auditPath === undefined ? auditPath() : this.deps.auditPath;
    if (path === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendLine(path, JSON.stringify(record));
    } catch (error) {
      this.deps.log?.(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Where a job in this box reaches the web server (docs/33 §1). Self-contained boxes run the
 * orchestrator inside the container, so loopback; otherwise the operator's `AGENTBOX_MCP_FACE_URL`
 * or Docker Desktop's name for the host's loopback — a Linux engine needs the web server bound
 * to the bridge address and the variable set (docs/06).
 */
export function faceBaseUrl(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENTBOX_MCP_FACE_URL;
  if (configured !== undefined && configured !== "") return configured;
  const boxd = env.AGENTBOX_BOXD_URL ?? "";
  const selfContained = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(boxd);
  return selfContained ? `http://127.0.0.1:${port}` : `http://host.docker.internal:${port}`;
}
