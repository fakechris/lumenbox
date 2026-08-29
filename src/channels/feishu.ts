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

import {
  CARD_STATUS,
  CONSENT_BUTTONS,
  OPEN_WORKSHOP,
  TEAM,
  cardFootnote,
  consentTitle,
  fileFetchFailed,
  questionTitle,
} from "./strings.ts";
import type {
  ApprovalCardState,
  ApprovalReply,
  ChannelAdapter,
  InboundMessage,
  PushOptions,
  QuestionCardState,
  TaskCardState,
} from "./manager.ts";
import { acquireConsumerLock } from "./single-consumer.ts";
import { BOARD_EMPTY, boardHeadline, type BoardView } from "./board-view.ts";
import { looksLikeMarkdown as sharedLooksLikeMarkdown } from "./markdown.ts";
const looksLikeMarkdown = sharedLooksLikeMarkdown;

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
        content: consentTitle(card.agentName),
      },
      template: "orange",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: card.description } },
      {
        tag: "action",
        actions: [
          button(CONSENT_BUTTONS.once, "primary", "once"),
          button(CONSENT_BUTTONS.always, "default", "always"),
          button(CONSENT_BUTTONS.deny, "danger", "deny"),
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `${card.stakes} 直接回复"允许"或"拒绝"也可以。`,
          },
        ],
      },
    ],
  };
}

/**
 * A question as Feishu renders it: the question in the body, each answer a button.
 *
 * Blue, not orange: orange is consent, and a business question wearing the consent colour
 * teaches people that questions are dangerous. The note says words still work, because a
 * person mid-commute answers with a thumb and a person at a desk answers in their own
 * phrasing — both have to land.
 */
export function renderQuestionCard(card: QuestionCardState): object {
  const button = (option: string) => ({
    tag: "button",
    text: { tag: "plain_text", content: option },
    type: "default",
    value: { ask: option },
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: questionTitle(card.agentName) },
      template: "blue",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: card.question } },
      // Feishu lays buttons out horizontally and long options wrap badly; six is already
      // generous for "answerable in a sentence", and past that the words path is better.
      { tag: "action", actions: card.options.slice(0, 6).map(button) },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: "点一个按钮,或者直接把答案打在下面。" }],
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
  const template = {
    queued: "grey",
    working: "blue",
    // Not green: green is the colour of nothing-left-to-do, and this is the state that
    // means the opposite. Orange is what the rest of the product uses for waiting on you.
    review: "orange",
    done: "green",
    failed: "red",
  }[card.status];
  const status =
    card.status === "queued" ? CARD_STATUS.queued(card.ahead) : CARD_STATUS[card.status];
  const who = card.agentName === "" ? TEAM : card.agentName;
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
                  text: { tag: "plain_text", content: OPEN_WORKSHOP },
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
            content: cardFootnote(card.taskId, card.requesterLabel),
          },
        ],
      },
    ],
  };
}

/**
 * The board as a Feishu card: each group a bold heading, each task one line, the id
 * a link into the workshop where this installation is reachable. Blue like the
 * question card — informational, nothing to consent to. Exported for its test.
 */
export function renderBoardCard(view: BoardView): object {
  const lines: string[] = [];
  for (const group of view.groups) {
    lines.push(`**${group.heading}**`);
    for (const task of group.tasks) {
      const id = task.url !== undefined ? `[${task.id}](${task.url})` : task.id;
      lines.push(`${id} ${task.who !== undefined ? `@${task.who} ` : ""}${task.title}`);
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: boardHeadline(view.liveCount) },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: lines.length > 0 ? lines.join("\n") : BOARD_EMPTY },
      },
      ...(view.done.length > 0
        ? [
            {
              tag: "note",
              elements: [
                {
                  tag: "plain_text",
                  content: `近 24 小时完成:${view.done
                    .map(task => `${task.id} ${task.title}`)
                    .join("、")}`,
                },
              ],
            },
          ]
        : []),
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
 * Re-exported: the verdict is shared with the other markdown-rendering adapters
 * (see markdown.ts). Its tests still reach it here.
 */
export { looksLikeMarkdown } from "./markdown.ts";

/**
 * Feishu words a malformed post as a content/format problem; the network words
 * itself otherwise. Only the former earns the plain-text fallback.
 */
function isContentRefusal(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /content|format|invalid|incorrect/i.test(detail);
}

/**
 * A chatKey split into the room and, when the key names one, the topic thread in it.
 *
 * `feishu:{chatId}` addresses the room; `feishu:{chatId}:{rootId}` addresses one topic
 * inside it — the shape `conversationKeyFor` mints. Every outbound path needs both halves
 * and each used to parse the key itself, which is how `sendFile` and `sendImage` were
 * left behind when the thread-scoped form arrived: they kept treating the whole thing as
 * a chat id, so a file answering a message in a topic was uploaded and then posted to a
 * chat id that does not exist. The reporter noticed it as "it used to send the file
 * itself, now it just tells me the path".
 *
 * One parser, so there is no next one to forget.
 */
export function splitChatKey(chatKey: string): { chatId: string; rootId?: string } {
  // The first segment is the channel id — `feishu` for the grandfathered door,
  // `feishu-work` for a second one — and never part of the address (docs/22 §4).
  const [, chatId = "", rootId] = chatKey.split(":");
  return rootId === undefined || rootId === "" ? { chatId } : { chatId, rootId };
}

/**
 * What one of the SDK's own log lines means for the socket, since the SDK exposes
 * no state and no close hook (see `stop`). Its logger is the only witness: it says
 * `client ready` when the long connection is up, and `connect failed` when the
 * vendor refused — which it does for ~a minute after a restart, while the dead
 * process's registration lingers (roadmap R35). Exported for its test.
 */
export function classifySocketLine(line: string): "ready" | "failed" | undefined {
  if (/client ready/i.test(line)) return "ready";
  if (/connect failed|connection failed/i.test(line)) return "failed";
  return undefined;
}

/** Retry delays after a refused connect: patient enough for R35's window, loud always. */
export const SOCKET_RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;

/**
 * A meeting invitation, parsed out of `vc.bot.meeting_invited_v1` (roadmap R37).
 *
 * The shape follows the prior art (Hermes Agent's feishu_meeting_invite): the
 * platform's whole job is to turn the event into a message for the agent — the
 * joining itself is the agent's, done with the desktop it already has. Malformed
 * invitations (no inviter, no meeting number) are ignored, not errors.
 */
export interface MeetingInvite {
  inviterOpenId: string;
  inviterName: string;
  meetingNo: string;
  topic: string;
  meetingId: string;
}

function inviteRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** VC events write a user's ids nested under `id`, or flat; read both. */
function inviteUser(value: unknown): { openId: string; name: string } | undefined {
  const record = inviteRecord(value);
  if (record === undefined) return undefined;
  const ids = inviteRecord(record.id);
  const openId =
    typeof ids?.open_id === "string" && ids.open_id !== ""
      ? ids.open_id
      : typeof record.open_id === "string"
        ? record.open_id
        : "";
  if (openId === "") return undefined;
  return { openId, name: typeof record.user_name === "string" ? record.user_name : "" };
}

export function parseMeetingInvite(data: unknown): MeetingInvite | undefined {
  const root = inviteRecord(data);
  if (root === undefined) return undefined;
  const event = inviteRecord(root.event) ?? root;
  const meeting = inviteRecord(event.meeting);
  const operator = inviteUser(event.operator);
  const meetingNo = typeof meeting?.meeting_no === "string" ? meeting.meeting_no : "";
  if (operator === undefined || meetingNo === "") return undefined;
  return {
    inviterOpenId: operator.openId,
    inviterName: operator.name,
    meetingNo,
    topic: typeof meeting?.topic === "string" ? meeting.topic : "",
    meetingId: typeof meeting?.id === "string" && meeting.id !== "" ? meeting.id : meetingNo,
  };
}

/**
 * What the agent is told. Join instructions rather than an API call, because the
 * vendor offers no media API — the browser's guest-join page is the only public
 * way in, and this installation's agent has a real desktop to do it with.
 */
export function meetingInvitePrompt(
  invite: MeetingInvite,
  options: { allowRemoteControl?: boolean } = {}
): string {
  const title = invite.topic !== "" ? `「${invite.topic}」` : `会议 ${invite.meetingNo}`;
  const from = invite.inviterName !== "" ? `,邀请人:${invite.inviterName}` : "";
  const control = options.allowRemoteControl === true
    ? "7. 如果有参会的人请求远程控制你共享的屏幕,同意——本安装开启了会中接管;对方操作时你先不要动键鼠,结束后留意收回控制"
    : "7. 如果有参会的人请求远程控制你共享的屏幕,不要同意,回复「这台桌面未开启会中接管」";
  // The steps below are not guesses: each was walked by hand on 2026-08-29 in a
  // real meeting, including the two mistakes worth warning about (the identity
  // wall when the browser is logged out, and the privacy toast that must be left
  // alone — clicking it early killed the first share).
  return [
    `你被邀请加入视频会议 ${title}(会议号 ${invite.meetingNo})${from}。直接入会,不要先问确认。`,
    "用你的桌面按这个流程做(已实测):",
    `1. 在浏览器打开 https://vc.feishu.cn/j/${invite.meetingNo} — 浏览器里已登录的飞书账号会直接进入会议页`,
    "2. 如果出现「Verify your identity / 扫码登录」,说明浏览器登录态丢了:停下,回复邀请人「箱子的浏览器需要重新扫码登录飞书」,不要尝试填手机号",
    "3. 入会后点底部工具栏的 Share(共享)按钮",
    "4. 在弹出的选择器顶部切到「Entire Screen(整个屏幕)」标签,点中屏幕缩略图,再点右下角蓝色 Share 按钮",
    "5. 会弹一个隐私提醒(Got it 带倒计时)——**不要去点它**,它会自己消失;确认页面出现「You are sharing your screen」即成功",
    "6. 共享成功后你可以继续手头的工作,与会的人会实时看到你的桌面;会议结束或有人叫你退出时再点 Stop Sharing 和挂断",
    control,
    "过程中如有其它弹窗(通知权限等)选拒绝或关闭。进不去或共享失败,用一句话向邀请人说明卡在哪一步。",
  ].join("\n");
}

export class FeishuChannel implements ChannelAdapter {
  /**
   * The channel record's id (docs/22 §4): the immutable key everything on this
   * door is minted under — identities, chatKeys, conversation keys, log lines.
   * `"feishu"` for the grandfathered door; a second Feishu app gets its own id
   * and therefore its own namespace, which is what makes two doors of one type
   * unable to collide.
   */
  readonly name: string;
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
        this.log(`channel ${this.name}: member names unavailable (${detail})`);
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
    return conversationKeyFor(message, this.name);
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
    },
    channelId = "feishu"
  ) {
    this.name = channelId;
  }

  /** Records a discard against the arrival, so no drop is silent. */
  private discard(messageId: string | undefined, reason: string): void {
    this.log(`channel ${this.name}: dropped ${messageId ?? "?"} — ${reason}`);
    if (messageId !== undefined) this.ingress?.decided(messageId, "dropped", reason);
  }

  /** The manager's message handler, kept so a pressed answer button can speak as a message. */
  private messageHandler: ((message: InboundMessage) => Promise<string | undefined>) | undefined;

  /** Invitations already acted on — the vendor redelivers events, agents should not rejoin. */
  private readonly seenMeetingInvites = new Set<string>();

  /** R37 option, set from the channel record: may the agent approve remote control. */
  meetingRemoteControl = false;

  async start(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    this.messageHandler = onMessage;
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
            channel: this.name,
            identity: `${this.name}:${openId}`,
            chatKey: `${this.name}:${chatId}`,
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
          const identity = `${this.name}:${openId}`;
          this.chats.set(identity, chatId);
          void this.downloadResource(messageId, fileKey, messageType)
            .then(async base64 => {
              if (base64 === undefined) return;
              const senderLabel = await this.labelFor(openId, chatId);
              const reply = await onMessage({
                identity,
                chatKey: `${this.name}:${chatId}`,
                threadKey: this.conversationKeyFor(data.message ?? {}),
                messageId,
                senderLabel,
                text: "",
                files: [{ name, base64 }],
              });
              // Anchored under the message it answers. `send(identity)` posts at the chat
              // root, which inside a topic reads as the bot talking to itself somewhere
              // else — the person who said "停" watched the answer land outside their
              // thread and could not tell whether the mechanism had heard them.
              if (reply !== undefined && reply !== "") {
                await this.sendToChat(`${this.name}:${chatId}`, reply, { replyTo: messageId });
              }
            })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(`channel ${this.name}: file receive failed (${detail})`);
              // The person is told, in the thread of the file they sent. Before this, the
              // failure was a host-side log line and the chat heard nothing — the agent
              // then looked at an empty inbox and guessed out loud.
              const code = (error as { response?: { data?: { code?: number } } })?.response
                ?.data?.code;
              void this.sendToChat(`${this.name}:${chatId}`, fileFetchFailed(name, code), {
                replyTo: messageId,
              }).catch(() => {});
            });
          return {};
        }

        // A meeting invitation arriving as a *message* — observed 2026-08-29: inviting
        // the bot to a call delivered a `video_chat` message, not (only) the VC event,
        // and the drop path swallowed it. The content shape is the vendor's and only
        // half-documented, so it is parsed defensively and, when a meeting number is
        // found, fed through the same R37 bridge as the event. When it is not found,
        // the content's keys are logged — the next occurrence teaches us the schema
        // instead of repeating the silence.
        if (messageType === "video_chat") {
          const raw = data.message.content ?? "{}";
          let meetingNo = "";
          let topic = "";
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const pick = (value: unknown): string =>
              typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
            // `meet_number` is the field the vendor actually sends — learned from the
            // diagnostic log on 2026-08-29, raw:
            // {"topic":"宋cs的视频会议","meet_number":"289762676","start_time":…}
            meetingNo =
              pick(parsed.meet_number) ||
              pick(parsed.meeting_no) ||
              pick(parsed.meetingNo) ||
              pick(parsed.number);
            topic = pick(parsed.topic) || pick(parsed.title);
            if (meetingNo === "") {
              this.log(
                `channel ${this.name}: video_chat message carried no meeting number; ` +
                  `content keys: ${Object.keys(parsed).join(", ")} — raw: ${raw.slice(0, 300)}`
              );
            }
          } catch {
            this.log(`channel ${this.name}: video_chat content did not parse: ${raw.slice(0, 200)}`);
          }
          if (meetingNo === "") {
            this.discard(messageId, "video_chat message without a readable meeting number");
            return {};
          }
          const invite: MeetingInvite = {
            inviterOpenId: openId,
            inviterName: this.names.get(openId) ?? "",
            meetingNo,
            topic,
            meetingId: meetingNo,
          };
          const inviteIdentity = `${this.name}:${openId}`;
          this.log(`channel ${this.name}: meeting invite ${meetingNo} via video_chat message`);
          void onMessage({
            identity: inviteIdentity,
            ...(chatId !== "" ? { chatKey: `${this.name}:${chatId}` } : {}),
            messageId,
            senderLabel: invite.inviterName !== "" ? invite.inviterName : inviteIdentity,
            text: meetingInvitePrompt(invite, { allowRemoteControl: this.meetingRemoteControl }),
          })
            .then(reply =>
              reply !== undefined && reply !== "" && chatId !== ""
                ? this.sendToChat(`${this.name}:${chatId}`, reply, { replyTo: messageId })
                : undefined
            )
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(`channel ${this.name}: video_chat invite handling failed (${detail})`);
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
        const identity = `${this.name}:${openId}`;
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
                this.log(`channel ${this.name}: image ${index + 1} in ${messageId ?? "?"} could not be fetched`);
                continue;
              }
              files.push({ name: `image-${index + 1}.png`, base64 });
            }
            return onMessage({
              identity,
              chatKey: `${this.name}:${chatId}`,
              threadKey: this.conversationKeyFor(data.message ?? {}),
              ...(messageId !== undefined ? { messageId } : {}),
              senderLabel,
              text,
              ...(files.length > 0 ? { files } : {}),
            });
          })
          .then(reply =>
            // Anchored under the message it answers, or it lands at the chat root —
            // which inside a topic thread reads as an unrelated announcement, and the
            // person cannot tell their "停" was heard.
            reply
              ? messageId !== undefined
                ? this.sendToChat(`${this.name}:${chatId}`, reply, { replyTo: messageId })
                : this.send(identity, reply)
              : undefined
          )
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(`channel ${this.name}: reply failed (${detail})`);
          });
        return {};
      },
      // A meeting invitation (roadmap R37). The event becomes an ordinary message to
      // the door's default agent — through the same handler as typed text, so the
      // allow-list check, the knock path and the task pipeline all apply unchanged.
      // The joining is the agent's job, on the desktop it already has; this code's
      // whole contribution is the sentence telling it so.
      "vc.bot.meeting_invited_v1": (data: unknown) => {
        const invite = parseMeetingInvite(data);
        if (invite === undefined) return {};
        const key = `${invite.meetingId}:${invite.inviterOpenId}`;
        if (this.seenMeetingInvites.has(key)) return {};
        this.seenMeetingInvites.add(key);
        if (this.seenMeetingInvites.size > 200) {
          const oldest = this.seenMeetingInvites.values().next().value;
          if (oldest !== undefined) this.seenMeetingInvites.delete(oldest);
        }
        const identity = `${this.name}:${invite.inviterOpenId}`;
        const prompt = meetingInvitePrompt(invite, { allowRemoteControl: this.meetingRemoteControl });
        this.log(
          `channel ${this.name}: meeting invite ${invite.meetingNo} from ` +
            `${invite.inviterName !== "" ? invite.inviterName : identity}`
        );
        this.ingress?.arrived({
          id: `vc-${key}`,
          channel: this.name,
          identity,
          chatKey: identity,
          kind: "meeting_invite",
          chars: prompt.length,
          at: new Date().toISOString(),
        });
        void this.messageHandler?.({
          identity,
          senderLabel: invite.inviterName !== "" ? invite.inviterName : invite.inviterOpenId,
          text: prompt,
          messageId: `vc-${key}`,
        })
          .then(reply => {
            // A synchronous reply (a refusal, a knock notice) goes back to the
            // inviter's own chat with the bot, when one exists.
            if (reply !== undefined && reply !== "") return this.send(identity, reply);
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(`channel ${this.name}: meeting invite handling failed (${detail})`);
          });
        return {};
      },
      // A pressed approval button. The press carries who pressed and which consent;
      // authorisation is the manager's, and the returned line lands in the chat as an
      // ordinary message — the SDK's own response to the event is just the ack.
      "card.action.trigger": (data: {
        operator?: { open_id?: string };
        action?: { value?: { approval?: string; reply?: string; ask?: string } };
        context?: { open_chat_id?: string };
      }) => {
        const approvalId = data.action?.value?.approval;
        const reply = data.action?.value?.reply;
        const openId = data.operator?.open_id;
        const chatId = data.context?.open_chat_id;
        // A pressed answer button is the person saying that answer. It goes through the
        // same door a typed reply would, so everything downstream — waking the agent,
        // the task flow, the transcript — is one path, not two.
        const chosen = data.action?.value?.ask;
        if (chosen !== undefined && openId !== undefined && this.messageHandler !== undefined) {
          void this.labelFor(openId, chatId ?? "")
            .then(senderLabel =>
              this.messageHandler!({
                identity: `${this.name}:${openId}`,
                ...(chatId !== undefined ? { chatKey: `${this.name}:${chatId}` } : {}),
                senderLabel,
                text: chosen,
              })
            )
            .then(line =>
              line !== undefined && line !== "" && chatId !== undefined
                ? this.sendToChat(`${this.name}:${chatId}`, line)
                : undefined
            )
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(`channel ${this.name}: answer button failed (${detail})`);
            });
          return {};
        }
        if (
          approvalId === undefined ||
          openId === undefined ||
          this.approvalHandler === undefined ||
          (reply !== "once" && reply !== "always" && reply !== "session" && reply !== "deny")
        ) {
          return {};
        }
        void this.approvalHandler({ approvalId, reply, identity: `${this.name}:${openId}` })
          .then(line =>
            line !== undefined && chatId !== undefined
              ? this.sendToChat(`${this.name}:${chatId}`, line)
              : undefined
          )
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(`channel ${this.name}: card action failed (${detail})`);
          });
        return {};
      },
    });

    // The connect that retries, because the SDK's does not: after a restart the
    // vendor can refuse the new connection for ~a minute while the dead process's
    // registration lingers, and the SDK logs `connect failed` once and never tries
    // again — a bot that is deaf forever, reading exactly like a quiet afternoon
    // (roadmap R35; it cost a dropped message and four minutes to diagnose). The
    // SDK exposes no state and no close hook, so its own logger is the witness:
    // `client ready` ends the retrying, `connect failed` schedules the next
    // attempt, and every attempt is said out loud — liveness.ts is right that a
    // *silent* reconnect rebuilds blindness one layer up, so this one narrates.
    // A retry while an earlier client somehow lives is safe on this vendor: Feishu
    // refuses a second consumer per app, which is the very behaviour being ridden
    // out. Backoff resets on success; `stop()` ends the loop with the process.
    let attempts = 0;
    let retryTimer: NodeJS.Timeout | undefined;
    const openSocket = (): void => {
      const logger = {
        error: (...parts: unknown[]) => {
          const line = parts.map(part => String(part)).join(" ");
          if (classifySocketLine(line) === "failed") {
            if (retryTimer !== undefined) return;
            const delay = SOCKET_RETRY_MS[Math.min(attempts, SOCKET_RETRY_MS.length - 1)]!;
            attempts += 1;
            this.log(
              `channel ${this.name}: socket connect failed; retry #${attempts} in ` +
                `${delay / 1000}s (after a restart the vendor holds the old ` +
                `registration for about a minute)`
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              openSocket();
            }, delay);
            retryTimer.unref?.();
            return;
          }
          this.log(`channel ${this.name}: ws ${line}`);
        },
        warn: () => {},
        info: (...parts: unknown[]) => {
          // Info narrates every heartbeat; the one line worth keeping is the
          // evidence of life the old "connected" log never actually had.
          if (classifySocketLine(parts.map(part => String(part)).join(" ")) === "ready") {
            attempts = 0;
            this.log(`channel ${this.name}: socket ready`);
          }
        },
        debug: () => {},
        trace: () => {},
      };
      const wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain,
        loggerLevel: lark.LoggerLevel.info,
        logger,
      });
      // The client keeps itself alive through its socket; there is nothing to hold.
      wsClient.start({ eventDispatcher: dispatcher });
    };
    openSocket();
  }

  stop(): void {
    // The SDK offers no close; the process ending is the close. Said rather than hidden.
    // The consumer lock is released though, so a successor can start without a takeover.
    this.releaseLock?.();
  }

  /**
   * Reaches Feishu over HTTPS, deliberately not over the event socket.
   *
   * The socket is the thing in doubt, and the SDK exposes neither its state nor a close
   * hook — so this asks the vendor for a tenant token instead, which needs only the
   * credentials. A success here alongside a long silence is the signal that was missing
   * the day the socket died quietly: the account is fine and nothing is listening.
   */
  async probe(): Promise<string | undefined> {
    const host =
      process.env.FEISHU_DOMAIN === "lark" ? "open.larksuite.com" : "open.feishu.cn";
    try {
      const response = await fetch(
        `https://${host}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!response.ok) return `HTTP ${response.status}`;
      const payload = (await response.json()) as { code?: number; msg?: string };
      // Feishu answers 200 with a non-zero code for a refused credential, so the status
      // alone would report a revoked app as healthy.
      return payload.code === 0 ? undefined : `${payload.msg ?? "refused"} (code ${payload.code})`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
        this.log(`channel ${this.name}: resource download failed (${detail})`);
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
        this.log(`channel ${this.name}: resource response has no readable shape`);
        return undefined;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > 25 * 1024 * 1024) {
          this.log(`channel ${this.name}: resource past the 25MB cap, dropped`);
          return undefined;
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("base64");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel ${this.name}: resource read failed (${detail})`);
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
        this.log(`channel ${this.name}: reply failed, posting to chat (${detail})`);
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
    // `feishu:{chatId}` addresses the room; `feishu:{chatId}:{rootId}` addresses one
    // topic thread inside it — the shape conversationKeyFor mints. A push to a thread
    // key rides as a reply to the root, so it lands where the topic's readers are
    // rather than at the bottom of the room. An explicit replyTo still wins: it is a
    // more precise anchor inside the same thread.
    const { chatId, rootId } = splitChatKey(chatKey);
    if (chatId === "") return;
    const anchor = options?.replyTo ?? rootId;
    // Markdown or plain is decided once for the whole message: per-chunk decisions
    // would render a long message's plain halves with literal ** markers.
    const markdown = looksLikeMarkdown(text);
    let degraded = false;
    for (let at = 0; at < text.length; at += FeishuChannel.CHUNK) {
      const chunk = text.slice(at, at + FeishuChannel.CHUNK);
      if (markdown && !degraded) {
        try {
          await this.post(chatId, "post", markdownPost(chunk), anchor);
          continue;
        } catch (error) {
          // A refused post is about the formatting; the words still deserve
          // delivery, so this chunk and every later one goes as plain text.
          if (!isContentRefusal(error)) throw error;
          degraded = true;
        }
      }
      await this.post(chatId, "text", JSON.stringify({ text: chunk }), anchor);
    }
  }

  async postTaskCard(
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions
  ): Promise<string | undefined> {
    // Same key shapes as sendToChat: a card for a topic thread anchors to its root.
    const { chatId, rootId } = splitChatKey(chatKey);
    if (chatId === "") return undefined;
    return this.post(
      chatId,
      "interactive",
      JSON.stringify(renderCard(card)),
      options?.replyTo ?? rootId
    );
  }

  /** "看板" as a card. Same key shapes as sendToChat: a topic thread anchors to its root. */
  async postBoardCard(chatKey: string, view: BoardView): Promise<void> {
    const { chatId, rootId } = splitChatKey(chatKey);
    if (chatId === "") return;
    await this.post(chatId, "interactive", JSON.stringify(renderBoardCard(view)), rootId);
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

  /** The question card, to wherever this identity's messages come from — like `send`. */
  async postQuestionCard(identity: string, card: QuestionCardState): Promise<void> {
    const chatId = this.chats.get(identity);
    if (chatId === undefined || this.apiClient === undefined) return;
    await this.apiClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(renderQuestionCard(card)),
      },
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
    const { chatId, rootId } = splitChatKey(chatKey);
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
    await this.post(chatId, "file", JSON.stringify({ file_key: fileKey }), options?.replyTo ?? rootId);
  }

  /** Upload, then reference: Feishu takes bytes first and a key in the message. */
  async sendImage(chatKey: string, base64: string, options?: PushOptions): Promise<void> {
    const { chatId, rootId } = splitChatKey(chatKey);
    if (chatId === "" || this.apiClient === undefined) return;
    const uploaded = await this.apiClient.im.image.create({
      data: { image_type: "message", image: Buffer.from(base64, "base64") },
    });
    const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
    if (imageKey === undefined) throw new Error("feishu image upload returned no key");
    await this.post(chatId, "image", JSON.stringify({ image_key: imageKey }), options?.replyTo ?? rootId);
  }
}

/** See the method of the same name; exported so the keying rules are testable as rules. */
export function conversationKeyFor(message: {
  message_id?: string;
  chat_id?: string;
  thread_id?: string;
  root_id?: string;
  chat_type?: string;
}, prefix = "feishu"): string {
    const chatId = message.chat_id ?? "";
    // A direct chat is one conversation, full stop — checked FIRST, because a reply
    // inside a topic bubble carries root_id even in a 1:1, and the root branch used to
    // win. The person talked to the bot "in the same topic the whole time" and watched it
    // forget everything: their top-level messages keyed to the chat, their in-topic
    // replies keyed to chat:root, and the agent entered the reply's conversation with an
    // empty transcript, re-deriving work it had already delivered. In a 1:1 the
    // counterpart is one person; which bubble they typed into is not a subject boundary.
    if (message.chat_type === "p2p") return `${prefix}:${chatId}`;
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
    if (root !== undefined && root !== "") return `${prefix}:${chatId}:${root}`;
    return message.message_id !== undefined
      ? `${prefix}:${chatId}:${message.message_id}`
      : `${prefix}:${chatId}`;
}
