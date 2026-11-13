/**
 * Who said each message an agent heard, written by the host when the agent starts on it (INV-1845).
 *
 * The page used to work this out afterwards from the transcript, which is written for the model: whether a
 * user-role entry was the person, the host, a teammate or a timer was read off flags that older records lack and
 * off the opening words of the text. Every repair to the conversation view on 2026-11-13 (INV-1838, 1841, 1843)
 * added a rule to that guess. The bus, when it hands a turn its messages, knows each one's sender, the part of
 * the host that wrote it, whether a request stands behind it and which request — set by the host, never by the
 * sender. This keeps that, keyed by the message id the transcript already cites (`causedBy`), so a conversation
 * can be drawn from what was known when it happened. Records from before this file existed keep the old reading.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine, type LedgerKind } from "../host/jsonl.ts";
import type { InboundMessage } from "./admitted-message.ts";
import { personMessage } from "./work-attention.ts";

/** What was heard is what happened: never compacted. */
export const LEDGER_KIND: LedgerKind = "record";

/** Who a message was from, as the host knew it. */
export type Speaker =
  | { by: "person"; principal?: string }
  /** A routine, a webhook, a resume or the host continuing a request: the harness speaking for a person who set it up. */
  | { by: "routine" }
  | { by: "teammate"; from: string }
  /** A part of the host writing on its own account: an audit, a job notice, a reminder. */
  | { by: "host"; origin: string };

export interface HeardRow {
  id: string;
  at: string;
  conversation: string;
  speaker: Speaker;
  /** A request stands behind it (INV-1844): its standing, or the request it belongs to. */
  asked: boolean;
  root?: string;
}

export function speakerOf(message: InboundMessage, isAgent: (id: string) => boolean): Speaker {
  if (personMessage(message)) return { by: "person", ...(message.principalId !== undefined ? { principal: message.principalId } : {}) };
  if (message.fromId === "user") return message.origin !== undefined ? { by: "host", origin: message.origin } : { by: "routine" };
  if (isAgent(message.fromId)) return { by: "teammate", from: message.fromName };
  return { by: "host", origin: message.origin ?? "board" };
}

export class HeardRecord {
  private readonly cache = new Map<string, Map<string, HeardRow>>();
  constructor(private readonly dir: string, private readonly onError: (why: string) => void = () => {}) {}

  /** The messages a turn is about to start on. A failed write is reported and never holds the turn up. */
  note(agentId: string, conversation: string, messages: readonly InboundMessage[], isAgent: (id: string) => boolean): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const rows = this.rows(agentId);
      for (const message of messages) {
        if (rows.has(message.id)) continue;
        const speaker = speakerOf(message, isAgent), root = message.work?.id ?? message.goal?.workId;
        const asked = speaker.by === "person" || speaker.by === "routine" || message.asked === true || root !== undefined;
        const row: HeardRow = { id: message.id, at: message.receivedAt, conversation, speaker, asked, ...(root !== undefined ? { root } : {}) };
        appendLine(this.pathFor(agentId), JSON.stringify(row));
        rows.set(row.id, row);
      }
    } catch (error) {
      this.onError(`heard record: ${messages.length} message(s) to ${agentId} were not recorded (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** What the host knew about one message, or undefined for a message from before this record. */
  get(agentId: string, id: string): HeardRow | undefined {
    return this.rows(agentId).get(id);
  }

  private rows(agentId: string): Map<string, HeardRow> {
    let rows = this.cache.get(agentId);
    if (rows !== undefined) return rows;
    rows = new Map();
    const path = this.pathFor(agentId);
    if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try { const row = JSON.parse(line) as HeardRow; rows.set(row.id, row); } catch { /* a torn last line is the crash it records */ }
    }
    this.cache.set(agentId, rows);
    return rows;
  }

  private pathFor(agentId: string): string {
    return join(this.dir, `${agentId.replace(/[^\w-]/g, "_")}.jsonl`);
  }
}
