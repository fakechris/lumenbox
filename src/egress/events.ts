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

import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { appendLine } from "../host/jsonl.ts";
import type { NetworkEvent } from "./relay.ts";

/** When the event file rotates: twenty megabytes is weeks of a busy box, and two of them are kept. */
export const NETWORK_EVENTS_MAX_BYTES = 20 * 1024 * 1024;

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
  constructor(private readonly at?: string, private readonly maxBytes = NETWORK_EVENTS_MAX_BYTES) {}

  get path(): string {
    return this.at ?? networkEventsPath();
  }

  /**
   * One line per event. Rotation is one generation (INV-1224): past `maxBytes` the file is
   * renamed to `<path>.1`, replacing the previous `.1`, and a fresh file starts — bounded disk,
   * and the last two windows still readable by hand.
   */
  append(event: NetworkEvent): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size >= this.maxBytes) renameSync(this.path, `${this.path}.1`);
    } catch {
      // Rotation that fails leaves the file growing, which is the lesser harm than losing the line.
    }
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
          ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
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
 * What the relay refused while one tool call ran, as a block on the call's result (INV-784,
 * INV-1345). The model learns that `pip install` failed because vendor.test is not allowed,
 * rather than reading a timeout — and learns the rule each host hit, so the next step is
 * obvious: a host nobody listed stays refused; a listed one is reached without asking.
 * One line per host:port and reason, oldest first, at most `maxLines` before "+N more";
 * never the call token. The shape follows the `<sandbox_violations>` block
 * (research 2026-10-24).
 */
export function egressDeniedBlock(events: readonly NetworkEvent[], maxLines = 10): string | undefined {
  const refused = events.filter(event => !event.allowed);
  if (refused.length === 0) return undefined;
  const lines: string[] = [];
  for (const event of [...refused].sort((a, b) => a.at.localeCompare(b.at))) {
    const line = `${event.host}:${event.port} — ${reasonOf(event)}`;
    if (!lines.includes(line)) lines.push(line);
  }
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  return [
    "<egress_denied>",
    ...shown,
    ...(more > 0 ? [`+${more} more`] : []),
    "</egress_denied>",
    "Outbound connections the egress relay refused during this call. A host outside this box's allow " +
      "list (the bundle's egressHosts, or `agentbox egress --allow`) stays refused until a person lists it; " +
      "a hard-denied target can never be listed.",
  ].join("\n");
}

function reasonOf(event: NetworkEvent): string {
  switch (event.reason) {
    case "hard-denied":
      return `hard-denied${event.detail !== undefined ? `: ${event.detail}` : ""}`;
    case "unauthorized":
      return "unauthorized (the stream's token named no box)";
    case "not allowed":
    case undefined:
      return "not allowed (outside this box's allow list)";
    default:
      return event.reason;
  }
}
