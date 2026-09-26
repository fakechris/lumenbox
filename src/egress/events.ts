/**
 * The network event log (INV-432, docs/50 J3): what the relay decided, on disk, queryable
 * by box and by time.
 *
 * The one audit face the six-lens inventory found entirely missing. The relay had been
 * logging refusals to its stdout, which is where they died; Claude Tag's Network Event
 * page answers "what did this agent connect to between 14:00 and 15:00", and now so can
 * `agentbox egress events` and `GET /api/network-events`.
 *
 * Append-only JSONL, one event per line, written by the relay process and read by the
 * web server — two processes, so the file is the interface. No retention here: a cap is
 * an operator's setting (INV-462 did the same for xwatchdog) and belongs beside it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { appendLine } from "../host/jsonl.ts";
import type { NetworkEvent } from "./relay.ts";

export function networkEventsPath(): string {
  return process.env.AGENTBOX_NETWORK_EVENTS ?? join(agentboxHome(), "network-events.jsonl");
}

export interface NetworkEventQuery {
  box?: string;
  /** By who made the call (INV-784): an agent id, a turn id, a tool_use id. */
  agent?: string;
  turn?: string;
  toolUse?: string;
  /** ISO instants, inclusive. */
  from?: string;
  to?: string;
  /** Only refusals. */
  refused?: boolean;
  /** Newest first, at most this many. Default 200. */
  limit?: number;
}

export const DEFAULT_EVENT_LIMIT = 200;

export class NetworkEventLog {
  /** Resolved on first use, not at construction: a log nobody reads must not need a home. */
  constructor(private readonly at?: string) {}

  get path(): string {
    return this.at ?? networkEventsPath();
  }

  append(event: NetworkEvent): void {
    appendLine(this.path, JSON.stringify(event));
  }

  /** Every event, oldest first. A torn line costs one event, never the query. */
  readAll(): NetworkEvent[] {
    const path = this.path;
    if (!existsSync(path)) return [];
    const out: NetworkEvent[] = [];
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as Partial<NetworkEvent>;
        if (typeof parsed.at !== "string" || typeof parsed.host !== "string") continue;
        out.push({
          at: parsed.at,
          box: typeof parsed.box === "string" ? parsed.box : "unknown",
          host: parsed.host,
          port: Number(parsed.port ?? 0),
          allowed: parsed.allowed === true,
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          // A line written before INV-784 names no call; read as what it is.
          attribution: parsed.attribution === "call" ? "call" : "unattributed",
          ...(typeof parsed.agentId === "string" ? { agentId: parsed.agentId } : {}),
          ...(typeof parsed.turnId === "string" ? { turnId: parsed.turnId } : {}),
          ...(typeof parsed.toolUseId === "string" ? { toolUseId: parsed.toolUseId } : {}),
          ...(typeof parsed.jobId === "string" ? { jobId: parsed.jobId } : {}),
        });
      } catch {
        // One torn line.
      }
    }
    return out;
  }

  query(query: NetworkEventQuery = {}): { events: NetworkEvent[]; total: number } {
    const selected = filterEvents(this.readAll(), query);
    const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_EVENT_LIMIT));
    return { events: selected.slice(-limit).reverse(), total: selected.length };
  }
}

/** The filter, apart from the file, so it can be tested and reused by the API. */
export function filterEvents(events: readonly NetworkEvent[], query: NetworkEventQuery): NetworkEvent[] {
  return events.filter(event => {
    if (query.box !== undefined && query.box !== "" && event.box !== query.box) return false;
    if (query.agent !== undefined && query.agent !== "" && event.agentId !== query.agent) return false;
    if (query.turn !== undefined && query.turn !== "" && event.turnId !== query.turn) return false;
    if (query.toolUse !== undefined && query.toolUse !== "" && event.toolUseId !== query.toolUse) return false;
    if (query.from !== undefined && query.from !== "" && event.at < query.from) return false;
    if (query.to !== undefined && query.to !== "" && event.at > query.to) return false;
    if (query.refused === true && event.allowed) return false;
    return true;
  });
}

/** A summary a person reads first: per box, how many connections and how many refusals, and the hosts refused. */
export function summariseEvents(events: readonly NetworkEvent[]): { box: string; allowed: number; refused: number; refusedHosts: string[] }[] {
  const byBox = new Map<string, { allowed: number; refused: number; refusedHosts: Set<string> }>();
  for (const event of events) {
    const row = byBox.get(event.box) ?? { allowed: 0, refused: 0, refusedHosts: new Set<string>() };
    if (event.allowed) row.allowed += 1;
    else {
      row.refused += 1;
      row.refusedHosts.add(`${event.host}:${event.port}`);
    }
    byBox.set(event.box, row);
  }
  return [...byBox.entries()]
    .map(([box, row]) => ({ box, allowed: row.allowed, refused: row.refused, refusedHosts: [...row.refusedHosts].sort() }))
    .sort((a, b) => b.refused - a.refused || b.allowed - a.allowed);
}

/**
 * The one line a tool call is told about its refusals (INV-784): "2 outbound connections
 * refused: a.test, b.test". Undefined when there were none, so nothing is appended. Hosts
 * once each, in the order first refused, capped so a sweep cannot flood the result.
 */
export function refusedLine(events: readonly NetworkEvent[], maxHosts = 8): string | undefined {
  const refused = events.filter(event => !event.allowed);
  if (refused.length === 0) return undefined;
  const hosts: string[] = [];
  for (const event of refused) if (!hosts.includes(event.host)) hosts.push(event.host);
  const shown = hosts.slice(0, maxHosts);
  const more = hosts.length - shown.length;
  return `${refused.length} outbound connection${refused.length === 1 ? "" : "s"} refused: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
