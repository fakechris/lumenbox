/**
 * Receipts for what the host sends into a chat (INV-1460): one per message, under an id that
 * is the same for the same message, so a send can be tried again without being sent twice.
 *
 * Inbound has an ingress ledger — every message's arrival and fate — and outbound had nothing:
 * a vendor timeout after a successful send looked exactly like a failed send, so the Feishu
 * door refused to retry at all, and one network blink was one answer lost. The deliveries
 * ledger knows an *answer* is owed; this knows whether a *message* went.
 *
 * Append-only and replayed, like the other ledgers here: `open` carries the text (it is what
 * a retry after a restart needs), `sent`, `failed` and `dropped` settle or count against it.
 * Only pending receipts keep their text once compacted; a sent message's words are the
 * transcript's business. Dropped is a verdict, never a timeout: the door said the conversation
 * cannot take it, so no retry will change the answer.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLine, type LedgerKind } from "./jsonl.ts";

export const LEDGER_KIND: LedgerKind = "queue";

/** Tries before a pending message becomes a problem for a person, and the backoff between them. */
export const OUTBOX_MAX_ATTEMPTS = 3;
export const OUTBOX_BACKOFF_MS = { first: 5_000, cap: 300_000 } as const;

export interface Receipt {
  id: string;
  chatKey: string;
  /** The purpose as `describePurpose` words it; the gate already judged it. */
  purpose: string;
  text: string;
  status: "pending" | "sent" | "dropped";
  attempts: number;
  lastError?: string;
  /** The message id the door returned, when it returns one. */
  sentId?: string;
  reason?: string;
  at: string;
}

type Line =
  | { event: "open"; receipt: Omit<Receipt, "status" | "attempts"> }
  | { event: "sent"; id: string; sentId?: string; at: string }
  | { event: "failed"; id: string; error: string; at: string }
  | { event: "dropped"; id: string; reason: string; at: string };

/**
 * The id a message is sent under: the chat, the purpose and the words. A notice adds the day,
 * because the same digest tomorrow is a new message while the same digest retried is not.
 */
export function outboundId(chatKey: string, purpose: string, text: string, day?: string): string {
  return createHash("sha256").update([chatKey, purpose, text, day ?? ""].join("\u0000")).digest("hex").slice(0, 16);
}

/** How long to wait before attempt `n + 1`, after `n` failures: 5 s doubling to 5 min. */
export function retryDelayMs(failures: number): number {
  return Math.min(OUTBOX_BACKOFF_MS.first * 2 ** Math.max(0, failures - 1), OUTBOX_BACKOFF_MS.cap);
}

/** A door's answer that the conversation can never take the message — not a blink, a verdict. */
export function conversationGone(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /chat (?:not found|does not exist)|not in (?:the )?chat|bot (?:was )?(?:removed|kicked)|no permission|forbidden|conversation (?:is )?(?:gone|closed|locked)|\b(?:230002|230013|230011|99991672)\b/i.test(text);
}

const COMPACT_AT = 500;

export class Outbox {
  private settled = 0;

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Notes the message before it goes; `duplicate` when this id was already sent or is still on its way. */
  enqueue(receipt: { id: string; chatKey: string; purpose: string; text: string }): "queued" | "duplicate" {
    if (this.replay().has(receipt.id)) return "duplicate";
    this.append({ event: "open", receipt: { ...receipt, at: this.now().toISOString() } });
    return "queued";
  }

  sent(id: string, sentId?: string): void {
    this.append({ event: "sent", id, ...(sentId !== undefined ? { sentId } : {}), at: this.now().toISOString() });
    this.settle();
  }

  failed(id: string, error: string): void {
    this.append({ event: "failed", id, error: error.slice(0, 300), at: this.now().toISOString() });
  }

  dropped(id: string, reason: string): void {
    this.append({ event: "dropped", id, reason: reason.slice(0, 300), at: this.now().toISOString() });
    this.settle();
  }

  /** Still on its way, with the text a retry needs. */
  pending(): Receipt[] {
    return [...this.replay().values()].filter(receipt => receipt.status === "pending");
  }

  /** Pending and past the attempt limit: a person's problem now, not a timer's. */
  problems(): Receipt[] {
    return this.pending().filter(receipt => receipt.attempts >= OUTBOX_MAX_ATTEMPTS);
  }

  private replay(): Map<string, Receipt> {
    const receipts = new Map<string, Receipt>();
    if (!existsSync(this.path)) return receipts;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let record: Line;
      try {
        record = JSON.parse(line) as Line;
      } catch {
        continue; // A torn last line is what a crash leaves; skipping it is the recovery.
      }
      if (record.event === "open") {
        receipts.set(record.receipt.id, { ...record.receipt, status: "pending", attempts: 0 });
        continue;
      }
      const receipt = receipts.get(record.id);
      if (receipt === undefined) continue;
      if (record.event === "sent") Object.assign(receipt, { status: "sent", ...(record.sentId !== undefined ? { sentId: record.sentId } : {}), text: "" });
      else if (record.event === "failed") Object.assign(receipt, { attempts: receipt.attempts + 1, lastError: record.error });
      else Object.assign(receipt, { status: "dropped", reason: record.reason, text: "" });
    }
    return receipts;
  }

  private append(line: Line): void {
    appendLine(this.path, JSON.stringify(line));
  }

  private settle(): void {
    this.settled += 1;
    if (this.settled < COMPACT_AT) return;
    // Pending receipts are rewritten whole, with their failures counted into one line each;
    // what went or was dropped is of no further interest here.
    const kept = this.pending().flatMap(receipt => [
      JSON.stringify({ event: "open", receipt: { id: receipt.id, chatKey: receipt.chatKey, purpose: receipt.purpose, text: receipt.text, at: receipt.at } }),
      ...Array.from({ length: receipt.attempts }, () => JSON.stringify({ event: "failed", id: receipt.id, error: receipt.lastError ?? "", at: receipt.at })),
    ]);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, kept.map(line => `${line}\n`).join(""), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.settled = 0;
  }
}
