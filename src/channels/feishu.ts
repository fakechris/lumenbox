/**
 * Feishu / Lark, over the long connection.
 *
 * Feishu's no-public-URL path is a websocket whose frames are a proprietary binary
 * protocol — not the documented JSON that DingTalk speaks — so this adapter goes
 * through the vendor's own SDK rather than a hand-rolled client that would break the
 * first time the framing changed. The SDK is imported lazily: it loads only when a
 * Feishu app is actually configured, so the other ninety-nine startups pay nothing.
 *
 * Works for both Feishu (China) and Lark (global): set FEISHU_DOMAIN=lark for the
 * global endpoints; the default is the China domain.
 *
 * The identity the allow list matches is the sender's open_id — a person, not a
 * chat — because in a group the question "who may command the agents" is about who
 * is typing, not where.
 */

import type { ChannelAdapter, InboundMessage } from "./manager.ts";

export class FeishuChannel implements ChannelAdapter {
  readonly name = "feishu";
  // Typed loosely because the SDK is a lazy import; the surface used is tiny.
  private apiClient:
    | {
        im: {
          message: {
            create: (options: {
              params: { receive_id_type: string };
              data: { receive_id: string; msg_type: string; content: string };
            }) => Promise<unknown>;
          };
        };
      }
    | undefined;
  /** The chat each identity last spoke in, for routing a reply or a notice back. */
  private readonly chats = new Map<string, string>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly log: (line: string) => void
  ) {}

  async start(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = process.env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.apiClient = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain,
    }) as unknown as FeishuChannel["apiClient"];

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: {
        sender?: { sender_id?: { open_id?: string } };
        message?: { chat_id?: string; message_type?: string; content?: string; mentions?: unknown[] };
      }) => {
        const openId = data.sender?.sender_id?.open_id ?? "unknown";
        const chatId = data.message?.chat_id ?? "";
        if (data.message?.message_type !== "text" || chatId === "") return {};
        let text = "";
        try {
          text = String(
            (JSON.parse(data.message.content ?? "{}") as { text?: string }).text ?? ""
          )
            // Mention tokens read as noise in an instruction; the bot being mentioned
            // is how the message reached us at all.
            .replace(/@_user_\d+/g, "")
            .trim();
        } catch {
          return {};
        }
        if (text === "") return {};
        const identity = `feishu:${openId}`;
        this.chats.set(identity, chatId);
        void onMessage({ identity, chatKey: `feishu:${chatId}`, senderLabel: openId, text })
          .then(reply => (reply ? this.send(identity, reply) : undefined))
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(`channel feishu: reply failed (${detail})`);
          });
        return {};
      },
    });

    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain,
      // The SDK logs at info by default, which narrates every heartbeat.
      loggerLevel: lark.LoggerLevel.error,
    });
    // The client keeps itself alive through its socket; there is nothing to hold.
    wsClient.start({ eventDispatcher: dispatcher });
  }

  stop(): void {
    // The SDK offers no close; the process ending is the close. Said rather than hidden.
  }

  async send(identity: string, text: string): Promise<void> {
    const chatId = this.chats.get(identity);
    if (chatId === undefined || this.apiClient === undefined) return;
    await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }
}
