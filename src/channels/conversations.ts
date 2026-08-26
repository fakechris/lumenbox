/**
 * The record of which chat a conversation belongs to.
 *
 * A conversation's id is derived from its chatKey by flattening every unsafe character
 * to `-` (`conversationIdFor`), and the flattening is one-way: `feishu:oc_x:om_y`
 * becomes `feishu-oc_x-om_y`, and nothing can tell which `-` was a `:`. The web page
 * views conversations by id — it is what the files are named — so when a person typed
 * into a viewed channel thread, the reply had no way back to the chat: the address had
 * been flattened out of existence at the moment it was last known.
 *
 * The adversarial review of the conversation-identity design (docs/13) said re-derived
 * identity should become an explicit record. This is that record's smallest useful
 * slice: id → chatKey, appended where the chatKey is last seen (a channel message
 * arriving), read where only the id survives (the web page interjecting). Append-only
 * and replayed, like every ledger here; a torn last line is skipped by every reader.
 *
 * Not backfilled. Threads from before this record exists become addressable on their
 * next inbound message, and an interjection before that stays local — logged, not
 * silent, because a message that quietly goes nowhere is this codebase's least
 * favourite failure.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "../host/jsonl.ts";

/** Duplicate lines beyond this and the file is rewritten as one line per conversation. */
const COMPACT_AT = 500;

export function conversationsPath(home: string): string {
  return join(home, "conversations.jsonl");
}

export class ConversationDirectory {
  private readonly byId = new Map<string, string>();
  private lines = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.lines += 1;
      try {
        const record = JSON.parse(line) as { conversation?: string; chatKey?: string };
        if (typeof record.conversation === "string" && typeof record.chatKey === "string") {
          // Last write wins, which is what replay means.
          this.byId.set(record.conversation, record.chatKey);
        }
      } catch {
        // A torn line from a crash mid-append; everything before it already counted.
      }
    }
  }

  /** Called wherever a chatKey and its conversation id are both in hand. Idempotent. */
  record(conversation: string, chatKey: string): void {
    if (this.byId.get(conversation) === chatKey) return;
    this.byId.set(conversation, chatKey);
    appendLine(this.path, JSON.stringify({ conversation, chatKey }));
    this.lines += 1;
    if (this.lines >= COMPACT_AT) this.compact();
  }

  /** The chat a conversation came from, or undefined for main and anything unrecorded. */
  chatKeyFor(conversation: string): string | undefined {
    return this.byId.get(conversation);
  }

  private compact(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      [...this.byId.entries()]
        .map(([conversation, chatKey]) => `${JSON.stringify({ conversation, chatKey })}\n`)
        .join(""),
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
    this.lines = this.byId.size;
  }
}
