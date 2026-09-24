/**
 * Telegram, over long polling.
 *
 * Polling rather than a webhook because this product runs on somebody's machine
 * behind NAT: `getUpdates` with a long timeout is the documented way to receive
 * messages with no public URL, no TLS certificate and no inbound port. One request
 * parked for 50 seconds costs nothing and delivers messages the moment they arrive.
 *
 * The identity the allow list matches is the *chat* id — a person's DM and a group
 * are different grants, which is what an owner actually wants to decide.
 */

import type { ChannelAdapter, InboundMessage } from "./manager.ts";

const API = "https://api.telegram.org";
/** Telegram truncates at 4096; splitting on our side keeps long reports readable. */
const CHUNK = 3900;

export interface Update {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat: { id: number; type?: string };
    from?: { first_name?: string; username?: string };
  };
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram";
  private stopped = false;
  private offset = 0;

  constructor(
    private readonly token: string,
    private readonly log: (line: string) => void
  ) {}

  async start(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    // One real call before claiming to run, so a bad token is a startup error with
    // Telegram's own words, not an eternal silent retry.
    const me = await this.call("getMe", {});
    const username = (me as { username?: string }).username ?? "bot";
    this.log(`channel telegram: @${username}`);
    void this.loop(onMessage);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Undefined: this wire answers nothing a reply to the push could be keyed on. */
  async send(identity: string, text: string): Promise<string | undefined> {
    const chatId = Number(identity.split(":")[1]);
    if (!Number.isFinite(chatId)) return undefined;
    await this.reply(chatId, text);
    return undefined;
  }

  private async loop(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = (await this.call("getUpdates", {
          timeout: 50,
          offset: this.offset,
          allowed_updates: ["message"],
        })) as Update[];
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const inbound = this.inboundOf(update);
          if (inbound === undefined) continue;
          const chatId = update.message!.chat.id;
          // Not awaited: a turn can run for minutes, and polling must not stop
          // receiving while one runs. Ordering per chat is the bus's job.
          void onMessage(inbound)
            .then(reply => (reply ? this.reply(chatId, reply) : undefined))
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(`channel telegram: reply failed (${detail})`);
            });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`channel telegram: ${detail}; retrying in 5s`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * The inbound seam (contract.ts, INV-129): one update to one message, or nothing for
   * an update this door does not handle. Telegram delivers each update once by offset,
   * so there is no redelivery to dedupe; the chat is the identity and the conversation.
   */
  inboundOf(update: Update): InboundMessage | undefined {
    const text = update.message?.text;
    if (text === undefined || update.message === undefined) {
      if (update.message !== undefined) this.log(`channel telegram: dropped update ${update.update_id} — no text`);
      return undefined;
    }
    const chatId = update.message.chat.id;
    const from = update.message.from;
    return {
      identity: `telegram:${chatId}`,
      ...(update.message.chat.type === "private" ? { privateChat: true } : {}),
      senderLabel: from?.username ?? from?.first_name ?? String(chatId),
      text,
      ...(update.message.message_id !== undefined ? { messageId: String(update.message.message_id) } : {}),
    };
  }

  private async reply(chatId: number, text: string): Promise<void> {
    for (let at = 0; at < text.length; at += CHUNK) {
      await this.call("sendMessage", { chat_id: chatId, text: text.slice(at, at + CHUNK) });
    }
  }

  private async call(method: string, body: object): Promise<unknown> {
    const response = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!parsed.ok) throw new Error(`telegram ${method}: ${parsed.description ?? response.status}`);
    return parsed.result;
  }
}
