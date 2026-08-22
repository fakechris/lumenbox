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

import type {
  ApprovalCardState,
  ApprovalReply,
  ChannelAdapter,
  InboundMessage,
  TaskCardState,
} from "./manager.ts";

/**
 * The consent request as a card: the original action verbatim in the body, the three
 * answers as buttons, and a note that the words still work — because a person typing
 * "允许" at a card is right, not wrong.
 */
export function renderApprovalCard(card: ApprovalCardState): object {
  const button = (label: string, type: string, reply: string) => ({
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value: { approval: card.approvalId, reply },
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `${card.agentName || "An agent"} needs your consent`,
      },
      template: "orange",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: card.description } },
      {
        tag: "action",
        actions: [
          button("Allow once", "primary", "once"),
          button("Allow always", "default", "always"),
          button("Deny", "danger", "deny"),
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "The turn is paused until someone answers. Replying allow / deny works too.",
          },
        ],
      },
    ],
  };
}

/**
 * A task card as Feishu renders it: header carries the instruction and the status
 * colour, the body says who is on it and what it is doing right now, the footnote
 * says who asked. Exported for its test — the mapping from state to card is the
 * part that can be wrong quietly.
 */
export function renderCard(card: TaskCardState): object {
  const template = { queued: "grey", working: "blue", done: "green", failed: "red" }[card.status];
  const status =
    card.status === "queued"
      ? `Queued${card.ahead !== undefined ? ` — ${card.ahead} ahead` : ""}`
      : card.status === "working"
        ? "Working"
        : card.status === "done"
          ? "Done"
          : "Failed";
  const who = card.agentName === "" ? "The team" : card.agentName;
  const lines = [`**${who}** · ${status}`];
  if (card.action !== undefined) lines.push(`\`${card.action}\``);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: card.title }, template },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "note", elements: [{ tag: "plain_text", content: `for ${card.requesterLabel}` }] },
    ],
  };
}

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
            }) => Promise<{ data?: { message_id?: string } } | undefined>;
            /** What updates a posted card in place. Quiet: Feishu does not notify for it. */
            patch: (options: {
              path: { message_id: string };
              data: { content: string };
            }) => Promise<unknown>;
          };
          image: {
            /** Uploads bytes; the returned key is what an image message references. */
            create: (options: {
              data: { image_type: string; image: Buffer };
            }) => Promise<{ data?: { image_key?: string } } | undefined>;
          };
        };
      }
    | undefined;
  /** The chat each identity last spoke in, for routing a reply or a notice back. */
  private readonly chats = new Map<string, string>();
  /**
   * Message ids already handled, id → arrival ms. Feishu redelivers events across
   * reconnects and slow acks, and a redelivered event is a duplicate turn. Keyed on
   * message_id (the id of the *message*, which is what must run once), TTL-pruned.
   * In memory only for now: a restart re-answering one message is the cost accepted;
   * the mature reference persists this map, which is the upgrade path if it bites.
   */
  private readonly seenMessages = new Map<string, number>();

  /** Records an id and says whether it was already seen. Prunes by TTL and size. */
  private alreadySeen(messageId: string): boolean {
    const now = Date.now();
    const ttlMs = 24 * 60 * 60_000;
    if (this.seenMessages.has(messageId)) return true;
    this.seenMessages.set(messageId, now);
    if (this.seenMessages.size > 2048) {
      for (const [id, at] of this.seenMessages) {
        if (now - at > ttlMs || this.seenMessages.size > 2048) this.seenMessages.delete(id);
        else break;
      }
    }
    return false;
  }

  /** Set by the manager before start; a press with no handler is acknowledged and dropped. */
  private approvalHandler:
    | ((press: {
        approvalId: string;
        reply: ApprovalReply;
        identity: string;
      }) => Promise<string | undefined>)
    | undefined;

  onApprovalAction(handler: NonNullable<FeishuChannel["approvalHandler"]>): void {
    this.approvalHandler = handler;
  }

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
        message?: {
          message_id?: string;
          chat_id?: string;
          message_type?: string;
          content?: string;
          mentions?: unknown[];
        };
      }) => {
        const openId = data.sender?.sender_id?.open_id ?? "unknown";
        const chatId = data.message?.chat_id ?? "";
        if (data.message?.message_type !== "text" || chatId === "") return {};
        const messageId = data.message.message_id;
        if (messageId !== undefined && this.alreadySeen(messageId)) return {};
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
      // A pressed approval button. The press carries who pressed and which consent;
      // authorisation is the manager's, and the returned line lands in the chat as an
      // ordinary message — the SDK's own response to the event is just the ack.
      "card.action.trigger": (data: {
        operator?: { open_id?: string };
        action?: { value?: { approval?: string; reply?: string } };
        context?: { open_chat_id?: string };
      }) => {
        const approvalId = data.action?.value?.approval;
        const reply = data.action?.value?.reply;
        const openId = data.operator?.open_id;
        const chatId = data.context?.open_chat_id;
        if (
          approvalId === undefined ||
          openId === undefined ||
          this.approvalHandler === undefined ||
          (reply !== "once" && reply !== "always" && reply !== "session" && reply !== "deny")
        ) {
          return {};
        }
        void this.approvalHandler({ approvalId, reply, identity: `feishu:${openId}` })
          .then(line =>
            line !== undefined && chatId !== undefined
              ? this.sendToChat(`feishu:${chatId}`, line)
              : undefined
          )
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(`channel feishu: card action failed (${detail})`);
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

  /**
   * Pushes to the chat itself, not to wherever the sender last spoke.
   *
   * `send` routes through the identity's last chat, which is right for a notice to a
   * person and wrong for a task result: the person may have moved on to another group
   * while the task ran, and the answer belongs to the room that asked.
   */
  async sendToChat(chatKey: string, text: string): Promise<void> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "" || this.apiClient === undefined) return;
    await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }

  async postTaskCard(chatKey: string, card: TaskCardState): Promise<string | undefined> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "" || this.apiClient === undefined) return undefined;
    const response = await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(renderCard(card)),
      },
    });
    return response?.data?.message_id;
  }

  async updateTaskCard(handle: string, card: TaskCardState): Promise<void> {
    if (this.apiClient === undefined) return;
    await this.apiClient.im.message.patch({
      path: { message_id: handle },
      data: { content: JSON.stringify(renderCard(card)) },
    });
  }

  /** The consent card, to wherever this identity's messages come from — like `send`. */
  async postApprovalCard(identity: string, card: ApprovalCardState): Promise<void> {
    const chatId = this.chats.get(identity);
    if (chatId === undefined || this.apiClient === undefined) return;
    await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(renderApprovalCard(card)),
      },
    });
  }

  /** Upload, then reference: Feishu takes bytes first and a key in the message. */
  async sendImage(chatKey: string, base64: string): Promise<void> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "" || this.apiClient === undefined) return;
    const uploaded = await this.apiClient.im.image.create({
      data: { image_type: "message", image: Buffer.from(base64, "base64") },
    });
    const imageKey = uploaded?.data?.image_key;
    if (imageKey === undefined) throw new Error("feishu image upload returned no key");
    await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }
}
