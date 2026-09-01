/**
 * The record of which conversation authored each top-level message the bot sent.
 *
 * Inbound topic replies key their conversation on `root_id` — the root message's own
 * id. When the root is a human's message, that id already named a conversation the
 * moment it arrived. When the root is the *bot's* message — a weekly report, a
 * morning note, any push — its id was minted by the vendor at send time and mapped
 * to nothing, so the person's reply under it opened a brand-new empty conversation
 * and the agent answered with no idea what it had itself written one bubble above.
 * (Measured 2026-09-01: a reply to Ada's own 周报 arrived as "记得长版发一个飞书文件啊"
 * in a conversation whose entire history was that one line.)
 *
 * This is the missing half of `ConversationDirectory`: that one maps conversation →
 * chat for the outbound path; this maps sent message id → the conversation key that
 * authored it, for the inbound path. Same ledger discipline: append-only, replayed,
 * a torn last line skipped; incarnation-stamped so an id recorded under a replaced
 * channel tenant routes nowhere rather than to whoever holds the chat id now.
 *
 * Bounded, unlike the directory: every top-level send lands here, so replay keeps
 * only the newest entries. A reply to a message older than the horizon opens a fresh
 * conversation — exactly what happened to every reply before this record existed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "../host/jsonl.ts";

/** Entries kept on compaction. Replies arrive within days; this is months of sends. */
const KEEP = 2000;
/** Appends beyond this and the file is rewritten to the newest KEEP. */
const COMPACT_AT = 4000;

export function sentRootsPath(home: string): string {
  return join(home, "sent-roots.jsonl");
}

export class SentRootsLedger {
  /** Insertion-ordered, oldest first — which is what makes trimming to KEEP honest. */
  private readonly byId = new Map<string, { chatKey: string; incarnation: number }>();
  private lines = 0;
  private readonly incarnationOf: (chatKey: string) => number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly path: string,
    options: {
      incarnationOf?: (chatKey: string) => number;
      warn?: (line: string) => void;
    } = {}
  ) {
    this.incarnationOf = options.incarnationOf ?? (() => 1);
    this.warn = options.warn ?? (line => console.error(`[sent-roots] ${line}`));
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.lines += 1;
      try {
        const record = JSON.parse(line) as {
          id?: string;
          chatKey?: string;
          incarnation?: number;
        };
        if (typeof record.id === "string" && typeof record.chatKey === "string") {
          // Re-inserted so a re-recorded id counts as newest, not as its first sight.
          this.byId.delete(record.id);
          this.byId.set(record.id, {
            chatKey: record.chatKey,
            incarnation: typeof record.incarnation === "number" ? record.incarnation : 1,
          });
        }
      } catch {
        // A torn line from a crash mid-append; everything before it already counted.
      }
    }
    this.trim();
  }

  /** Called where a send just succeeded and both halves are in hand. */
  record(id: string, chatKey: string): void {
    if (id === "" || chatKey === "") return;
    const incarnation = this.incarnationOf(chatKey);
    const existing = this.byId.get(id);
    if (existing?.chatKey === chatKey && existing.incarnation === incarnation) return;
    this.byId.delete(id);
    this.byId.set(id, { chatKey, incarnation });
    appendLine(this.path, JSON.stringify({ id, chatKey, incarnation }));
    this.lines += 1;
    this.trim();
    if (this.lines >= COMPACT_AT) this.compact();
  }

  /**
   * The conversation key that authored a sent message, or undefined for anything
   * unrecorded — and undefined, loudly, past a channel replacement, for the same
   * reason ConversationDirectory refuses: the chat id under the new tenant is a
   * different room with different people.
   */
  chatKeyFor(id: string): string | undefined {
    const entry = this.byId.get(id);
    if (entry === undefined) return undefined;
    if (entry.incarnation !== this.incarnationOf(entry.chatKey)) {
      this.warn(
        `dead letter: sent message ${id} was authored under a replaced channel ` +
          `(${entry.chatKey}); not routing its replies to whoever holds that id now.`
      );
      return undefined;
    }
    return entry.chatKey;
  }

  private trim(): void {
    while (this.byId.size > KEEP) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  private compact(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      [...this.byId.entries()]
        .map(
          ([id, entry]) =>
            `${JSON.stringify({ id, chatKey: entry.chatKey, incarnation: entry.incarnation })}\n`
        )
        .join(""),
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
    this.lines = this.byId.size;
  }
}
