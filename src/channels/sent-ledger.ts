/**
 * What went out through a chat door, as it went (INV-1841).
 *
 * Every arrival has had a line since `ingress.jsonl`; nothing that left did. A reconciliation of the live
 * record on 2026-11-13 (INV-1840) could count 225 arrivals and could not say what one chat had been sent:
 * replies were reconstructed from the transcript, and the acknowledgement, the cards, the files, the
 * screenshot and the host's own notices were written nowhere. The page drew the transcript and the chat
 * showed the sends, and nothing could hold the two together.
 *
 * So the record is taken at the one place every send passes: the adapter. `recording` wraps a door, and
 * each outbound method that returns leaves a line under the conversation the chat maps to. A send that
 * threw leaves none — the line means it went. Bytes are not kept, names are; text is kept as sent, which
 * is after the outbound redaction, so nothing is here that the chat did not already receive.
 *
 * One file per conversation, because the reader is a thread being drawn and a single file would be
 * scanned whole for each one.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationIdFor } from "../agents/registry.ts";
import { appendLine, type LedgerKind } from "../host/jsonl.ts";
import type { ChannelAdapter } from "./manager.ts";

/** What was sent is what happened: never compacted, never dropped. */
export const LEDGER_KIND: LedgerKind = "record";

/** Text beyond this is the reply itself, which the transcript holds whole; the record keeps enough to match it. */
const TEXT_KEPT = 4_000;

export interface SentRow {
  at: string;
  door: string;
  /** The chat it went to — thread part included — or the person's identity where the wire has no rooms. */
  chatKey: string;
  kind: "text" | "image" | "file" | "card";
  /** Which card, when it is one. */
  card?: "task" | "question" | "approval" | "surface" | "board";
  /** The words, or a card's headline. */
  text?: string;
  /** A file's name. */
  name?: string;
}

export class SentLedger {
  constructor(
    private readonly dir: string,
    private readonly onError: (why: string) => void = () => {},
    private readonly now: () => Date = () => new Date()
  ) {}

  /** A send that returned. Failing to write the line is reported and never fails the send it describes. */
  note(row: Omit<SentRow, "at">): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const text = row.text === undefined ? undefined : row.text.length > TEXT_KEPT ? `${row.text.slice(0, TEXT_KEPT)}…` : row.text;
      appendLine(this.pathFor(conversationIdFor(row.chatKey)), JSON.stringify({ at: this.now().toISOString(), ...row, ...(text !== undefined ? { text } : {}) }));
    } catch (error) {
      this.onError(`sent ledger: ${row.kind} to ${row.chatKey} was sent but not recorded (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Everything recorded as sent into a conversation, oldest first. */
  in(conversation: string): SentRow[] {
    const path = this.pathFor(conversation);
    if (!existsSync(path)) return [];
    const rows: SentRow[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try { rows.push(JSON.parse(line) as SentRow); } catch { /* a torn last line is the crash it records, not a row */ }
    }
    return rows;
  }

  private pathFor(conversation: string): string {
    return join(this.dir, `${conversation}.jsonl`);
  }
}

type Card = { title?: string; question?: string; description?: string };
/** Each outbound method, and the row a call to it leaves. Anything not listed is not a send. */
const SENDS: Record<string, (args: unknown[]) => Omit<SentRow, "door" | "at">> = {
  send: ([identity, text]) => ({ chatKey: String(identity), kind: "text", text: String(text) }),
  sendToChat: ([chatKey, text]) => ({ chatKey: String(chatKey), kind: "text", text: String(text) }),
  sendImage: ([chatKey]) => ({ chatKey: String(chatKey), kind: "image" }),
  sendFile: ([chatKey, name]) => ({ chatKey: String(chatKey), kind: "file", name: String(name) }),
  postTaskCard: ([chatKey, card]) => ({ chatKey: String(chatKey), kind: "card", card: "task", text: (card as Card).title ?? "" }),
  postQuestionCard: ([identity, card, chatKey]) => ({ chatKey: String(chatKey ?? identity), kind: "card", card: "question", text: (card as Card).question ?? "" }),
  postApprovalCard: ([identity, card, chatKey]) => ({ chatKey: String(chatKey ?? identity), kind: "card", card: "approval", text: (card as Card).description ?? "" }),
  postSurfaceCard: ([identity, card, chatKey]) => ({ chatKey: String(chatKey ?? identity), kind: "card", card: "surface", text: (card as Card).title ?? "" }),
  postBoardCard: ([chatKey]) => ({ chatKey: String(chatKey), kind: "card", card: "board" }),
};

/** The same door, leaving a line for each thing it sends. A method the door lacks stays lacking. */
export function recording(adapter: ChannelAdapter, ledger: SentLedger): ChannelAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      const row = typeof property === "string" ? SENDS[property] : undefined;
      if (row === undefined || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const result = await (value as (...all: unknown[]) => Promise<unknown>).apply(target, args);
        ledger.note({ door: target.name, ...row(args) });
        return result;
      };
    },
  });
}
