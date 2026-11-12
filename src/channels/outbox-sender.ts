/**
 * Sends a host message into a chat under a receipt (INV-1460): tried again on a failure that
 * may have been a blink, dropped on a door's verdict, in order per chat, and picked up again
 * after a restart.
 *
 * The order matters as much as the retry: a task's acknowledgement before its result, a
 * question before the answer that mentions it. So each chat has one chain, and a message waits
 * for the one before it — including its retries — rather than overtaking it.
 */

import type { OutboundPurpose } from "../host/outbound.ts";
import { describePurpose } from "../host/outbound.ts";
import { conversationGone, OUTBOX_MAX_ATTEMPTS, outboundId, type Outbox, type Receipt, retryDelayMs } from "../host/outbox.ts";

export interface Sender {
  sendToChat(chatKey: string, text: string): Promise<void>;
}

export interface SendOutcome {
  delivered: boolean;
  why?: string;
  /** This id went before; nothing was sent again. */
  duplicate?: boolean;
}

type SendAuthorization = boolean | { allow: boolean; terminal?: boolean; reason?: string };

export class OutboxSender {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly outbox: Outbox,
    private readonly log: (line: string) => void,
    /** Injectable for tests; defaults to the real timer. */
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly now: () => Date = () => new Date(),
    /** Each try's outcome (INV-1741): the exception list counts a failure and resolves when the chat takes one. */
    private readonly observe?: (event: "sent" | "failed" | "dropped", detail: { id: string; chatKey: string; attempts: number; error?: string }) => void,
    private readonly maySend: (receipt: Receipt) => SendAuthorization = () => true
  ) {}

  /**
   * A person pressed Retry on a chat's messages (INV-1741): every pending one for the chat is tried
   * once more, in order, whatever its count — past the limit is exactly when a person is asked.
   */
  async retry(chatKey: string, adapter: Sender): Promise<{ tried: number; sent: number }> {
    const pending = this.outbox.pending().filter(receipt => receipt.chatKey === chatKey);
    let sent = 0;
    for (const receipt of pending) {
      const outcome = await this.chained(chatKey, () => this.attempt(receipt.id, { adapter, chatKey, text: receipt.text }, receipt.attempts, undefined, true));
      if (outcome.delivered) sent += 1;
    }
    return { tried: pending.length, sent };
  }

  private noted(event: "sent" | "failed" | "dropped", detail: { id: string; chatKey: string; attempts: number; error?: string }): void {
    try { this.observe?.(event, detail); } catch (error) { this.log(`outbox: could not note ${detail.id} — ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Sends under its receipt, after the chat's earlier messages. `after` runs once the words
   * went — the files a text names — and its failure does not unsend the words.
   */
  send(input: { adapter: Sender; chatKey: string; text: string; purpose: OutboundPurpose }, after?: () => Promise<void>): Promise<SendOutcome> {
    const purpose = describePurpose(input.purpose);
    const day = input.purpose.kind === "notice" ? this.now().toISOString().slice(0, 10) : undefined;
    const id = outboundId(input.chatKey, purpose, input.text, day);
    if (this.outbox.enqueue({ id, chatKey: input.chatKey, purpose, text: input.text }) === "duplicate") {
      const receipt = this.outbox.get(id);
      if (receipt?.status === "sent") return Promise.resolve({ delivered: true, duplicate: true });
      if (receipt?.status !== "pending") return Promise.resolve({ delivered: false, why: "The receipt was dropped or is unavailable" });
      return this.chained(input.chatKey, () => this.attempt(id, input, receipt.attempts, after));
    }
    return this.chained(input.chatKey, () => this.attempt(id, input, 0, after));
  }

  /** Whatever was still pending when the process last stopped goes again, oldest first, through the same chains. */
  async resume(adapterFor: (chatKey: string) => Sender | undefined): Promise<number> {
    let resumed = 0;
    for (const receipt of this.outbox.pending()) {
      if (receipt.attempts >= OUTBOX_MAX_ATTEMPTS) continue; // A problem for a person, not for a retry.
      const adapter = adapterFor(receipt.chatKey);
      if (adapter === undefined) continue;
      resumed += 1;
      void this.chained(receipt.chatKey, () => this.attempt(receipt.id, { adapter, chatKey: receipt.chatKey, text: receipt.text }, receipt.attempts));
    }
    return resumed;
  }

  private chained<T>(chatKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatKey) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(chatKey, next.catch(() => undefined));
    return next;
  }

  /** `once`: a person's Retry — one try, whatever the count, and no backoff after it. */
  private async attempt(id: string, input: { adapter: Sender; chatKey: string; text: string }, failures: number, after?: () => Promise<void>, once = false): Promise<SendOutcome> {
    for (let tried = failures; ; tried += 1) {
      const receipt = this.outbox.get(id);
      if (receipt?.status === "sent") return { delivered: true, duplicate: true };
      if (!receipt || receipt.status !== "pending") return { delivered: false, why: "The receipt is no longer pending" };
      let verdict: SendAuthorization;
      try { verdict = this.maySend(receipt); } catch { return { delivered: false, why: "Delivery authority is unavailable; the message is held" }; }
      const allow = typeof verdict === "boolean" ? verdict : verdict.allow;
      if (!allow) {
        const why = typeof verdict === "boolean" ? "Delivery authority requires inspection" : verdict.reason ?? "Delivery authority requires inspection";
        if (typeof verdict !== "boolean" && verdict.terminal) this.outbox.dropped(id, why);
        return { delivered: false, why };
      }
      try {
        await input.adapter.sendToChat(input.chatKey, input.text);
        this.outbox.sent(id);
        this.noted("sent", { id, chatKey: input.chatKey, attempts: tried + 1 });
        try { await after?.(); } catch (error) { this.log(`outbox: ${id} sent, but its files did not follow — ${error instanceof Error ? error.message : String(error)}`); }
        return { delivered: true };
      } catch (error) {
        const why = `could not send to ${input.chatKey} — ${error instanceof Error ? error.message : String(error)}`;
        if (conversationGone(error)) {
          this.outbox.dropped(id, why);
          this.noted("dropped", { id, chatKey: input.chatKey, attempts: tried + 1, error: why });
          this.log(`outbox: ${id} dropped; ${why}`);
          return { delivered: false, why };
        }
        this.outbox.failed(id, why);
        const next = tried + 1;
        this.noted("failed", { id, chatKey: input.chatKey, attempts: next, error: why });
        if (next >= OUTBOX_MAX_ATTEMPTS || once) {
          this.log(`outbox: ${id} failed ${next} times, left pending for a person; ${why}`);
          return { delivered: false, why };
        }
        this.log(`outbox: ${id} failed (${next}/${OUTBOX_MAX_ATTEMPTS}), retrying in ${retryDelayMs(next) / 1000}s; ${why}`);
        await this.wait(retryDelayMs(next));
      }
    }
  }
}
