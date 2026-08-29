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
  private readonly byId = new Map<string, { chatKey: string; incarnation: number }>();
  private lines = 0;
  private readonly incarnationOf: (chatKey: string) => number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly path: string,
    options: {
      /** Current incarnation of a chatKey's channel. Defaults to 1 for everything. */
      incarnationOf?: (chatKey: string) => number;
      warn?: (line: string) => void;
    } = {}
  ) {
    this.incarnationOf = options.incarnationOf ?? (() => 1);
    this.warn = options.warn ?? (line => console.error(`[conversations] ${line}`));
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.lines += 1;
      try {
        const record = JSON.parse(line) as {
          conversation?: string;
          chatKey?: string;
          incarnation?: number;
        };
        if (typeof record.conversation === "string" && typeof record.chatKey === "string") {
          // Last write wins, which is what replay means. Lines from before the stamp
          // existed were written under the grandfathered incarnation, which is 1.
          this.byId.set(record.conversation, {
            chatKey: record.chatKey,
            incarnation: typeof record.incarnation === "number" ? record.incarnation : 1,
          });
        }
      } catch {
        // A torn line from a crash mid-append; everything before it already counted.
      }
    }
  }

  /** Called wherever a chatKey and its conversation id are both in hand. Idempotent. */
  record(conversation: string, chatKey: string): void {
    const incarnation = this.incarnationOf(chatKey);
    const existing = this.byId.get(conversation);
    if (existing?.chatKey === chatKey && existing.incarnation === incarnation) return;
    this.byId.set(conversation, { chatKey, incarnation });
    appendLine(this.path, JSON.stringify({ conversation, chatKey, incarnation }));
    this.lines += 1;
    if (this.lines >= COMPACT_AT) this.compact();
  }

  /**
   * The chat a conversation came from, or undefined for main and anything unrecorded —
   * and undefined, loudly, for an address recorded under a channel incarnation that
   * has since been replaced (docs/22 §4): the same vendor chat id under the new tenant
   * is a different room with different people, and a reply routed there by string
   * equality would hand one tenant's conversation to another.
   */
  chatKeyFor(conversation: string): string | undefined {
    const entry = this.byId.get(conversation);
    if (entry === undefined) return undefined;
    if (entry.incarnation !== this.incarnationOf(entry.chatKey)) {
      this.warn(
        `dead letter: conversation ${conversation} is addressed to ${entry.chatKey} ` +
          `under a replaced channel; not routing to whoever holds that id now.`
      );
      return undefined;
    }
    return entry.chatKey;
  }

  private compact(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      [...this.byId.entries()]
        .map(
          ([conversation, entry]) =>
            `${JSON.stringify({ conversation, chatKey: entry.chatKey, incarnation: entry.incarnation })}\n`
        )
        .join(""),
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
    this.lines = this.byId.size;
  }
}
