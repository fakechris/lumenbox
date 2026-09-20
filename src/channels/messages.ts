/**
 * Every message a person sent through a door, kept once, as it was.
 *
 * Four ledgers already record parts of a message's life — ingress (it arrived, its
 * fate), inbox (it is queued), the transcript (the turn it caused), deliveries (what
 * went back) — and three of them empty themselves once nothing is pending, which is
 * right for a queue and wrong for a record. The transcript survives, but it holds the
 * turn's *prompt*: several messages joined into one text, cut at eight thousand
 * characters, with no channel id. So the honest answer to "what exactly did this person
 * say, and which turn did it become" was a reconstruction from timestamps.
 *
 * This file is the record. One line per admitted message, written at the door the
 * moment it is let in, carrying the id that then travels with it — into the inbox, into
 * the transcript's `causedBy`, into anything that wants to walk back. Never compacted:
 * a record that forgets is a queue. Refused messages are not here; the ingress ledger
 * says they were refused, and what a stranger said is not something to keep.
 *
 * Not scanned for secrets on the way in — the audit export redacts on the way out, and a
 * ledger that edits what a person said is not a record of what they said.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "../host/jsonl.ts";

export const MESSAGES_SCHEMA = "lumenbox.message/v1";

export interface MessageRecord {
  schema: typeof MESSAGES_SCHEMA;
  /** Minted at the door; the same id the inbox and the transcript carry. */
  id: string;
  /** The door's name, e.g. `feishu-personal`. */
  channel: string;
  /** The channel's own id for the message, when the wire gave one. */
  channelMessageId?: string;
  chatKey: string;
  threadKey?: string;
  identity: string;
  senderLabel: string;
  /** Where the turn thinks: the thread if there is one, else the chat. */
  conversationKey: string;
  receivedAt: string;
  /** As sent, whole. The inbox clamps its copy; this one is not clamped. */
  text: string;
  textChars: number;
  files?: { name: string; bytes: number }[];
}

export function messagesPath(home: string): string {
  return join(home, "messages.jsonl");
}

export class Messages {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Writes the record. Called once, at admission, after the door has said yes. */
  admitted(record: Omit<MessageRecord, "schema" | "textChars">): void {
    const line: MessageRecord = { schema: MESSAGES_SCHEMA, ...record, textChars: record.text.length };
    appendLine(this.path, JSON.stringify(line));
  }

  /** Everything, in order. Malformed lines are skipped rather than allowed to hide the rest. */
  list(): MessageRecord[] {
    if (!existsSync(this.path)) return [];
    const out: MessageRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as MessageRecord;
        if (typeof record.id === "string") out.push(record);
      } catch {
        // A torn last line from a crash mid-write; the record before it is intact.
      }
    }
    return out;
  }
}
