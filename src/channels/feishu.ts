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
  PushOptions,
  TaskCardState,
} from "./manager.ts";
import { acquireConsumerLock } from "./single-consumer.ts";

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
            content: `${card.stakes} Replying allow / deny works too.`,
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
      // The way into the workshop: the desktop it is working on, the evidence behind
      // each step, the history of who moved it. A chat can carry the conclusion; only
      // the workshop can carry the proof.
      ...(card.taskUrl !== undefined
        ? [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "Open in the workshop" },
                  type: "default",
                  url: card.taskUrl,
                },
              ],
            },
          ]
        : []),
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              (card.taskId !== undefined ? `${card.taskId} · ` : "") + `for ${card.requesterLabel}`,
          },
        ],
      },
    ],
  };
}

/**
 * Markdown travels as a post's `md` element — the one wire form Feishu renders
 * as formatted text (CommonMark + GFM, tables included) rather than as literal
 * asterisks. The element owns its paragraph, so a chunk rides as one element.
 */
export function markdownPost(text: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });
}

/**
 * Whether a message means markdown: the block constructs plain prose never
 * contains. Snake_case is deliberately not read as emphasis — code speaks in
 * underscores, people rarely italicize, and a false positive only changes the
 * wire form, not the words.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s+\S/m.test(text) ||
    /```/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /^\s*[-*+]\s+\S/m.test(text) ||
    /^\s*\d+\.\s+\S/m.test(text) ||
    /^\s*>/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /^\s*\|.*\|\s*$/m.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  );
}

/**
 * Feishu words a malformed post as a content/format problem; the network words
 * itself otherwise. Only the former earns the plain-text fallback.
 */
function isContentRefusal(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /content|format|invalid|incorrect/i.test(detail);
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
            /** A threaded reply: under a topic it stays there; on a chat message it opens one. */
            reply: (options: {
              path: { message_id: string };
              data: { content: string; msg_type: string; reply_in_thread?: boolean };
            }) => Promise<{ data?: { message_id?: string }; message_id?: string } | undefined>;
          };
          messageResource: {
            /** Binary download; the SDK wraps the stream, shape probed defensively. */
            get: (options: {
              path: { message_id: string; file_key: string };
              params: { type: string };
            }) => Promise<unknown>;
          };
          messageReaction: {
            create: (options: {
              path: { message_id: string };
              data: { reaction_type: { emoji_type: string } };
            }) => Promise<{ data?: { reaction_id?: string }; reaction_id?: string } | undefined>;
            delete: (options: {
              path: { message_id: string; reaction_id: string };
            }) => Promise<unknown>;
          };
          chatMembers: {
            /** Members of a chat, names included — no extra scope, unlike contact. */
            get: (options: {
              path: { chat_id: string };
              params: { member_id_type: string; page_size: number; page_token?: string };
            }) => Promise<
              | {
                  data?: {
                    items?: { member_id?: string; name?: string }[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }
              | undefined
            >;
          };
          image: {
            /**
             * Uploads bytes; the returned key is what an image message references.
             * Verified live: the SDK returns `{image_key}` at the top level for this
             * multipart call, unlike message.create which nests under `data`.
             */
            create: (options: {
              data: { image_type: string; image: Buffer };
            }) => Promise<{ image_key?: string; data?: { image_key?: string } } | undefined>;
          };
          file: {
            /** Uploads a file; the SDK's multipart reader wants a stream with a name. */
            create: (options: {
              data: { file_type: string; file_name: string; file: NodeJS.ReadableStream };
            }) => Promise<{ file_key?: string; data?: { file_key?: string } } | undefined>;
          };
        };
      }
    | undefined;
  /** The chat each identity last spoke in, for routing a reply or a notice back. */
  private readonly chats = new Map<string, string>();
  /** Held while this process is the app's websocket consumer. */
  private releaseLock: (() => void) | undefined;
  /** The Typing reaction placed on each in-progress message, for removal when it lands. */
  private readonly typingReactions = new Map<string, string>();
  /**
   * open_id → display name, filled a chat at a time. The event does not carry the
   * sender's name, and a knock list or a principal named `ou_…` is unreadable — the
   * chat-members listing has the names and needs no scope the app does not already
   * hold. A miss refetches once (a member who just joined), then honestly stays an id.
   */
  private readonly names = new Map<string, string>();

  private async labelFor(openId: string, chatId: string): Promise<string> {
    const known = this.names.get(openId);
    if (known !== undefined) return known;
    if (this.apiClient !== undefined) {
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < 5; page++) {
          const response = await this.apiClient.im.chatMembers.get({
            path: { chat_id: chatId },
            params: {
              member_id_type: "open_id",
              page_size: 100,
              ...(pageToken !== undefined ? { page_token: pageToken } : {}),
            },
          });
          for (const member of response?.data?.items ?? []) {
            if (member.member_id !== undefined && member.name !== undefined) {
              this.names.set(member.member_id, member.name);
            }
          }
          if (response?.data?.has_more !== true || response.data.page_token === undefined) break;
          pageToken = response.data.page_token;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`channel feishu: member names unavailable (${detail})`);
      }
    }
    return this.names.get(openId) ?? openId;
  }
  /**
   * Message ids already handled, id → arrival ms. Feishu redelivers events across
   * reconnects and slow acks, and a redelivered event is a duplicate turn. Keyed on
   * message_id (the id of the *message*, which is what must run once), TTL-pruned.
   * In memory only for now: a restart re-answering one message is the cost accepted;
   * the mature reference persists this map, which is the upgrade path if it bites.
   */
  private readonly seenMessages = new Map<string, number>();

  /** Records an id and says whether it was already seen. Prunes by TTL and size. */
  /**
   * A Feishu rich-text body as plain text.
   *
   * Links keep their address: an agent handed "see the docs" without the URL cannot
   * follow it, and following it is usually the point of pasting one.
   */
  private renderPostBody(
    title: unknown,
    content: unknown
  ): { text: string; imageKeys: string[] } {
    const lines: string[] = [];
    const imageKeys: string[] = [];
    if (typeof title === "string" && title.trim() !== "") lines.push(title.trim());
    for (const paragraph of Array.isArray(content) ? content : []) {
      const runs: string[] = [];
      for (const run of Array.isArray(paragraph) ? paragraph : []) {
        const part = run as {
          tag?: string;
          text?: string;
          href?: string;
          user_name?: string;
          image_key?: string;
        };
        if (part.tag === "img" && typeof part.image_key === "string") {
          // Collected rather than skipped. An image pasted into rich text was vanishing
          // in silence — the words arrived and the picture did not, and nothing said so.
          imageKeys.push(part.image_key);
          runs.push(`[image ${imageKeys.length}]`);
        } else if (part.tag === "a" && typeof part.href === "string") {
          runs.push(part.text ? `${part.text} (${part.href})` : part.href);
        } else if (part.tag === "at") {
          runs.push(part.user_name ? `@${part.user_name}` : "");
        } else if (typeof part.text === "string") {
          runs.push(part.text);
        }
      }
      lines.push(runs.join(""));
    }
    return { text: lines.join("\n"), imageKeys };
  }

  /**
   * Which conversation a message belongs to.
   *
   * The thread if it has one, the reply chain's root if it is a reply, and otherwise the
   * message itself when this is a group — a new top-level message in a room is a new
   * subject, and keying it on the room is what made one room one endless conversation.
   *
   * A direct message falls back to the chat, because there the chat *is* the subject and
   * a per-message key would throw away every follow-up.
   */
  private conversationKeyFor(message: {
    message_id?: string;
    chat_id?: string;
    thread_id?: string;
    root_id?: string;
    chat_type?: string;
  }): string {
    const chatId = message.chat_id ?? "";
    // `root_id`, deliberately not `thread_id`. The root of a chain *is* the first message,
    // so `root_id` equals that message's own id and the opening message and its replies
    // agree. `thread_id` is a separate identifier Feishu mints when the first reply
    // arrives, which the opening message never carries — so preferring it split every
    // topic in two: the question in one conversation and every answer in another, and the
    // agent never saw how the subject began.
    //
    // Verified against the ledger: a root arrived with neither field and was keyed on its
    // own id; its replies carried `root_id` equal to that id and `thread_id` equal to
    // something else entirely.
    const root = message.root_id;
    if (root !== undefined && root !== "") return `feishu:${chatId}:${root}`;
    // A direct chat is its own subject, and keying per message there would discard every
    // follow-up somebody makes.
    if (message.chat_type === "p2p") return `feishu:${chatId}`;
    return message.message_id !== undefined
      ? `feishu:${chatId}:${message.message_id}`
      : `feishu:${chatId}`;
  }

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
    private readonly log: (line: string) => void,
    /** Where arrivals and discards are recorded. Absent in tests. */
    private readonly ingress?: {
      arrived: (a: {
        id: string;
        channel: string;
        identity: string;
        chatKey: string;
        kind: string;
        chars: number;
        at: string;
      }) => void;
      decided: (id: string, fate: "admitted" | "refused" | "dropped", reason?: string) => void;
    }
  ) {}

  /** Records a discard against the arrival, so no drop is silent. */
  private discard(messageId: string | undefined, reason: string): void {
    this.log(`channel feishu: dropped ${messageId ?? "?"} — ${reason}`);
    if (messageId !== undefined) this.ingress?.decided(messageId, "dropped", reason);
  }

  async start(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    // Before anything connects: a second consumer on the same app id would not fail,
    // it would silently take half the events. Refused loudly instead.
    this.releaseLock = acquireConsumerLock(this.appId);
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
          /**
           * Which topic or reply chain this belongs to.
           *
           * Feishu has sent these all along — its own SDK types declare them — and we
           * read none of them, so every message in a group landed in one unbounded
           * conversation. Recorded before deciding anything, so the choice of what to key
           * a conversation on is made against how this installation is actually used
           * rather than against a guess.
           */
          thread_id?: string;
          root_id?: string;
          parent_id?: string;
          chat_type?: string;
        };
      }) => {
        const openId = data.sender?.sender_id?.open_id ?? "unknown";
        const chatId = data.message?.chat_id ?? "";
        const messageType = data.message?.message_type;
        // Logged before anything can drop it. A message that arrives and is discarded —
        // no chat id, a duplicate, an unhandled type — left no trace at all, so "the bot
        // is not answering" and "the connection is delivering nothing" looked identical
        // from the log, and the only way to tell them apart was to add this and ask
        // somebody to type again.
        const arrivedId = data.message?.message_id;
        if (arrivedId !== undefined) {
          this.ingress?.arrived({
            id: arrivedId,
            channel: "feishu",
            identity: `feishu:${openId}`,
            chatKey: `feishu:${chatId}`,
            kind: messageType ?? "unknown",
            chars: String(data.message?.content ?? "").length,
            ...(data.message?.thread_id !== undefined ? { threadId: data.message.thread_id } : {}),
            ...(data.message?.root_id !== undefined ? { rootId: data.message.root_id } : {}),
            ...(data.message?.chat_type !== undefined ? { chatType: data.message.chat_type } : {}),
            at: new Date().toISOString(),
          });
        }
        if (chatId === "" || data.message === undefined) return {};
        const messageId = data.message.message_id;
        if (messageId !== undefined && this.alreadySeen(messageId)) {
          this.discard(messageId, "delivered more than once");
          return {};
        }

        // A file or an image is bytes to fetch, then an ordinary inbound message that
        // carries them. The download happens here because the wire (key, resource
        // API, quirks) is this adapter's business and nobody else's.
        if ((messageType === "file" || messageType === "image") && messageId !== undefined) {
          let parsed: { file_key?: string; image_key?: string; file_name?: string } = {};
          try {
            parsed = JSON.parse(data.message.content ?? "{}") as typeof parsed;
          } catch {
            return {};
          }
          const fileKey = parsed.file_key ?? parsed.image_key;
          if (fileKey === undefined) return {};
          const name = parsed.file_name ?? `image-${messageId.slice(-8)}.png`;
          const identity = `feishu:${openId}`;
          this.chats.set(identity, chatId);
          void this.downloadResource(messageId, fileKey, messageType)
            .then(async base64 => {
              if (base64 === undefined) return;
              const senderLabel = await this.labelFor(openId, chatId);
              const reply = await onMessage({
                identity,
                chatKey: `feishu:${chatId}`,
                threadKey: this.conversationKeyFor(data.message ?? {}),
                messageId,
                senderLabel,
                text: "",
                files: [{ name, base64 }],
              });
              if (reply !== undefined && reply !== "") await this.send(identity, reply);
            })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(`channel feishu: file receive failed (${detail})`);
            });
          return {};
        }

        if (messageType !== "text" && messageType !== "post") {
          this.discard(messageId, `unhandled message type ${messageType ?? "?"}`);
          return {};
        }
        let text = "";
        let postImages: string[] = [];
        try {
          const parsed = JSON.parse(data.message.content ?? "{}") as {
            text?: string;
            title?: string;
            content?: unknown;
          };
          // Rich text arrives as `post`, not `text`, and was being dropped whole. Anything
          // pasted with a link, a line break or an emoji is a post — which is most of what
          // a person actually sends — so the bot appeared to ignore them at random.
          //
          // The shape is paragraphs of runs: [[{tag:"text",text}, {tag:"a",text,href}, …]].
          // Flattened here rather than anywhere else, because the wire format is this
          // adapter's business and everything downstream wants a string.
          if (messageType === "post") {
            const rendered = this.renderPostBody(parsed.title, parsed.content);
            text = rendered.text;
            postImages = rendered.imageKeys;
          } else {
            text = String(parsed.text ?? "");
          }
          text = text
            // Mention tokens read as noise in an instruction; the bot being mentioned
            // is how the message reached us at all.
            .replace(/@_user_\d+/g, "")
            .trim();
        } catch {
          this.discard(messageId, "content did not parse");
          return {};
        }
        if (text === "") {
          // A bare mention is a person addressing you, not an empty message. Dropping it
          // silently is the worst possible answer: they get nothing back and reasonably
          // conclude the bot is broken, which is exactly what happened — "@bot" with no
          // other words went nowhere and looked like an outage.
          //
          // Passed on as a real message saying what it was, so the agent answers it as
          // being spoken to rather than being handed an empty string.
          const mentionOnly = /@_user_\d+/.test(String(data.message.content ?? ""));
          if (!mentionOnly) {
            this.discard(
              messageId,
              `no usable text; raw=${String(data.message.content ?? "").slice(0, 100)}`
            );
            return {};
          }
          text =
            "(They mentioned you with no other words — they are getting your attention. " +
            "Say briefly that you are here and what you are in the middle of, if anything.)";
        }
        const identity = `feishu:${openId}`;
        this.chats.set(identity, chatId);
        void this.labelFor(openId, chatId)
          .then(async senderLabel => {
            // Pictures pasted into rich text are fetched like a standalone image message,
            // because to the person who sent it there is no difference — they put a
            // screenshot in the message and expect it to be looked at.
            const files: { name: string; base64: string }[] = [];
            for (const [index, key] of postImages.entries()) {
              const base64 = await this.downloadResource(messageId ?? "", key, "image").catch(
                () => undefined
              );
              if (base64 === undefined) {
                this.log(`channel feishu: image ${index + 1} in ${messageId ?? "?"} could not be fetched`);
                continue;
              }
              files.push({ name: `image-${index + 1}.png`, base64 });
            }
            return onMessage({
              identity,
              chatKey: `feishu:${chatId}`,
              threadKey: this.conversationKeyFor(data.message ?? {}),
              ...(messageId !== undefined ? { messageId } : {}),
              senderLabel,
              text,
              ...(files.length > 0 ? { files } : {}),
            });
          })
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
    // The consumer lock is released though, so a successor can start without a takeover.
    this.releaseLock?.();
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
   * The bytes of a message's file or image, base64, or undefined with the reason
   * logged. Audio and media downloads sometimes refuse their own type and answer to
   * `type=file` — the mature reference retries exactly that way, so this does too.
   * Capped at 25MB: past that, the box is the wrong transport.
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    kind: string
  ): Promise<string | undefined> {
    if (this.apiClient === undefined) return undefined;
    const fetchAs = (type: string) =>
      this.apiClient!.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
    let resource: unknown;
    try {
      resource = await fetchAs(kind === "image" ? "image" : "file");
    } catch {
      try {
        resource = await fetchAs("file");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`channel feishu: resource download failed (${detail})`);
        return undefined;
      }
    }
    try {
      if (Buffer.isBuffer(resource)) return resource.toString("base64");
      const wrapped = resource as {
        getReadableStream?: () => NodeJS.ReadableStream;
        on?: unknown;
      };
      const stream =
        typeof wrapped.getReadableStream === "function"
          ? wrapped.getReadableStream()
          : typeof wrapped.on === "function"
            ? (resource as NodeJS.ReadableStream)
            : undefined;
      if (stream === undefined) {
        this.log("channel feishu: resource response has no readable shape");
        return undefined;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > 25 * 1024 * 1024) {
          this.log("channel feishu: resource past the 25MB cap, dropped");
          return undefined;
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("base64");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel feishu: resource read failed (${detail})`);
      return undefined;
    }
  }

  /**
   * One message out: a threaded reply when there is an anchor, a chat post when not.
   *
   * The reply carries `reply_in_thread`, so under a topic it stays there and on a
   * plain chat message it opens one — which is the whole task-thread choreography in
   * a single rule. A failed reply (anchor withdrawn, unreachable) degrades to a loose
   * chat post: that cannot create a stray topic, so it is safe where a reply was not.
   */
  private async post(
    chatId: string,
    msgType: string,
    content: string,
    replyTo?: string
  ): Promise<string | undefined> {
    if (this.apiClient === undefined) return undefined;
    if (replyTo !== undefined) {
      try {
        const response = await this.apiClient.im.message.reply({
          path: { message_id: replyTo },
          data: { content, msg_type: msgType, reply_in_thread: true },
        });
        return response?.data?.message_id ?? response?.message_id;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`channel feishu: reply failed, posting to chat (${detail})`);
      }
    }
    // Only the plain create retries: a failed *reply* is usually a withdrawn anchor,
    // which three attempts will not un-withdraw, while a failed create is usually the
    // network having a moment.
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.apiClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: msgType, content },
        });
        return response?.data?.message_id;
      } catch (error) {
        last = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    throw last;
  }

  /** Feishu renders very long texts poorly and refuses truly long ones; split like a person would. */
  private static readonly CHUNK = 8000;

  /**
   * Pushes to the chat itself, not to wherever the sender last spoke.
   *
   * `send` routes through the identity's last chat, which is right for a notice to a
   * person and wrong for a task result: the person may have moved on to another group
   * while the task ran, and the answer belongs to the room that asked.
   */
  async sendToChat(chatKey: string, text: string, options?: PushOptions): Promise<void> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "") return;
    // Markdown or plain is decided once for the whole message: per-chunk decisions
    // would render a long message's plain halves with literal ** markers.
    const markdown = looksLikeMarkdown(text);
    let degraded = false;
    for (let at = 0; at < text.length; at += FeishuChannel.CHUNK) {
      const chunk = text.slice(at, at + FeishuChannel.CHUNK);
      if (markdown && !degraded) {
        try {
          await this.post(chatId, "post", markdownPost(chunk), options?.replyTo);
          continue;
        } catch (error) {
          // A refused post is about the formatting; the words still deserve
          // delivery, so this chunk and every later one goes as plain text.
          if (!isContentRefusal(error)) throw error;
          degraded = true;
        }
      }
      await this.post(chatId, "text", JSON.stringify({ text: chunk }), options?.replyTo);
    }
  }

  async postTaskCard(
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions
  ): Promise<string | undefined> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "") return undefined;
    return this.post(chatId, "interactive", JSON.stringify(renderCard(card)), options?.replyTo);
  }

  /**
   * The state of the message that started a task, as a reaction on it: "Typing"
   * while the work runs, removed when it lands, swapped for a cross when it broke.
   * The cheap presence a wire without a typing API can still give.
   */
  async noteStatus(messageId: string, status: "working" | "done" | "failed"): Promise<void> {
    if (this.apiClient === undefined) return;
    if (status === "working") {
      const response = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "Typing" } },
      });
      const reactionId = response?.data?.reaction_id ?? response?.reaction_id;
      if (reactionId !== undefined) this.typingReactions.set(messageId, reactionId);
      return;
    }
    const typing = this.typingReactions.get(messageId);
    this.typingReactions.delete(messageId);
    if (typing !== undefined) {
      try {
        await this.apiClient.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: typing },
        });
      } catch {
        // A stuck Typing mark is cosmetic; the failure mark below still lands.
      }
    }
    if (status === "failed") {
      await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "CrossMark" } },
      });
    }
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

  /**
   * A named file into the chat: upload, then a file message referencing the key.
   *
   * The typed-document routing (pdf/doc/xls/ppt get their own file_type, everything
   * else is a stream) is what makes Feishu render a preview instead of a blob.
   */
  async sendFile(
    chatKey: string,
    name: string,
    base64: string,
    options?: PushOptions
  ): Promise<void> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "" || this.apiClient === undefined) return;
    const extension = name.toLowerCase().split(".").pop() ?? "";
    const fileType = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp4", "opus"].includes(
      extension
    )
      ? extension
      : "stream";
    const { Readable } = await import("node:stream");
    const stream = Readable.from(Buffer.from(base64, "base64")) as NodeJS.ReadableStream & {
      path?: string;
    };
    // The SDK's multipart encoder reads the name off the stream, like fs streams have.
    stream.path = name;
    const uploaded = await this.apiClient.im.file.create({
      data: { file_type: fileType, file_name: name, file: stream },
    });
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key;
    if (fileKey === undefined) throw new Error("feishu file upload returned no key");
    await this.post(chatId, "file", JSON.stringify({ file_key: fileKey }), options?.replyTo);
  }

  /** Upload, then reference: Feishu takes bytes first and a key in the message. */
  async sendImage(chatKey: string, base64: string, options?: PushOptions): Promise<void> {
    const chatId = chatKey.replace(/^feishu:/, "");
    if (chatId === "" || this.apiClient === undefined) return;
    const uploaded = await this.apiClient.im.image.create({
      data: { image_type: "message", image: Buffer.from(base64, "base64") },
    });
    const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
    if (imageKey === undefined) throw new Error("feishu image upload returned no key");
    await this.post(chatId, "image", JSON.stringify({ image_key: imageKey }), options?.replyTo);
  }
}
