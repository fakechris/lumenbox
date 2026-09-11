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
  constructor(private readonly path: string = networkEventsPath()) {}

  append(event: NetworkEvent): void {
    appendLine(this.path, JSON.stringify(event));
  }

  /** Every event, oldest first. A torn line costs one event, never the query. */
  readAll(): NetworkEvent[] {
    if (!existsSync(this.path)) return [];
    const out: NetworkEvent[] = [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
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
