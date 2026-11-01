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
import { conversationGone, OUTBOX_MAX_ATTEMPTS, outboundId, type Outbox, retryDelayMs } from "../host/outbox.ts";

export interface Sender {
  sendToChat(chatKey: string, text: string): Promise<void>;
}

export interface SendOutcome {
  delivered: boolean;
  why?: string;
  /** This id went before; nothing was sent again. */
  duplicate?: boolean;
}

export class OutboxSender {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly outbox: Outbox,
    private readonly log: (line: string) => void,
    /** Injectable for tests; defaults to the real timer. */
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Sends under its receipt, after the chat's earlier messages. `after` runs once the words
   * went — the files a text names — and its failure does not unsend the words.
   */
  send(input: { adapter: Sender; chatKey: string; text: string; purpose: OutboundPurpose }, after?: () => Promise<void>): Promise<SendOutcome> {
    const purpose = describePurpose(input.purpose);
    const day = input.purpose.kind === "notice" ? this.now().toISOString().slice(0, 10) : undefined;
    const id = outboundId(input.chatKey, purpose, input.text, day);
    if (this.outbox.enqueue({ id, chatKey: input.chatKey, purpose, text: input.text }) === "duplicate") {
      this.log(`outbox: ${purpose} to ${input.chatKey} already sent as ${id}; not sent again`);
      return Promise.resolve({ delivered: true, duplicate: true });
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

  private async attempt(id: string, input: { adapter: Sender; chatKey: string; text: string }, failures: number, after?: () => Promise<void>): Promise<SendOutcome> {
    for (let tried = failures; ; tried += 1) {
      try {
        await input.adapter.sendToChat(input.chatKey, input.text);
        this.outbox.sent(id);
        try { await after?.(); } catch (error) { this.log(`outbox: ${id} sent, but its files did not follow — ${error instanceof Error ? error.message : String(error)}`); }
        return { delivered: true };
      } catch (error) {
        const why = `could not send to ${input.chatKey} — ${error instanceof Error ? error.message : String(error)}`;
        if (conversationGone(error)) {
          this.outbox.dropped(id, why);
          this.log(`outbox: ${id} dropped; ${why}`);
          return { delivered: false, why };
        }
        this.outbox.failed(id, why);
        const next = tried + 1;
        if (next >= OUTBOX_MAX_ATTEMPTS) {
          this.log(`outbox: ${id} failed ${next} times, left pending for a person; ${why}`);
          return { delivered: false, why };
        }
        this.log(`outbox: ${id} failed (${next}/${OUTBOX_MAX_ATTEMPTS}), retrying in ${retryDelayMs(next) / 1000}s; ${why}`);
        await this.wait(retryDelayMs(next));
      }
    }
  }
}
