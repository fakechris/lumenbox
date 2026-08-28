/**
 * DingTalk, over Stream Mode.
 *
 * Stream Mode is DingTalk's documented no-public-URL path: open a gateway
 * connection with the app credentials, get a websocket endpoint and ticket, and
 * bot messages arrive as JSON frames. Hand-rolled rather than through the vendor
 * SDK because the protocol is small, documented JSON — a subscription frame, a ping
 * to answer, an ack per message — and Node's built-in WebSocket covers it.
 *
 * The wire, spelled out, because several of these facts cost a debugging session:
 *
 * - Every frame carries a transport id (`headers.messageId`) that must be acked,
 *   and every message a business id (`msgId`) that may arrive twice across a
 *   reconnect. Acking twice is required; answering twice is a duplicate turn.
 * - A message carries `conversationId` (the room — feeds `chatKey`, so results go
 *   back to the room that asked rather than to wherever the sender spoke last)
 *   and `senderStaffId` (the person — feeds `identity`, what the allow list
 *   matches). `sessionWebhook` is the pre-authorised way out of that exact
 *   conversation: scoped to it, expiring at `sessionWebhookExpiredTime`.
 * - Pictures, files, audio and video arrive as a `downloadCode`; the bytes are
 *   exchanged from it over the REST twin of this topic, with an access token.
 * - Pushes into a conversation nobody just spoke in ride the robot REST APIs
 *   (`groupMessages/send`, `oToMessages/batchSend`) — what a scheduled digest or a
 *   long task's late result arrives by.
 *
 * What this adapter deliberately does not have, said so the absence reads as a
 * decision rather than a gap:
 *
 * - No threads. Conversations between a person and a DingTalk bot have no topic
 *   structure, so there is no `threadKey`: the chat *is* the subject, the reading
 *   every platform without threads takes.
 * - No reactions. Robot messages carry no emoji marks, so there is no `noteStatus`:
 *   a task's working/done state lives on the task card (or the plain ack line), not
 *   on the message that asked.
 *
 * Outbound media files and images ARE supported, without a public URL: the box's
 * bytes go up through the legacy `media/upload` endpoint for a `mediaId`, and the
 * robot REST APIs deliver them as `sampleFile` / `sampleImageMsg` messages — the
 * same upload-then-reference bargain Feishu's adapter strikes.
 *
 * Interactive cards ARE supported, conditionally: with `DINGTALK_CARD_TEMPLATE_ID`
 * configured, consent requests render as an interactive card whose three buttons
 * answer over the stream (`/v1.0/card/instances/callback`, `callbackType: STREAM`),
 * no public URL needed; without it the method stays undefined and approvals run on
 * the text verbs ("允许", "deny") exactly as before. With
 * `DINGTALK_TASK_CARD_TEMPLATE_ID` also configured, long tasks render a task card
 * whose status and current action are rewritten in place (`PUT /v1.0/card/instances`)
 * — the progress surface Feishu shows, on the wire DingTalk has. Both templates are
 * built in the card console (they carry the app's identity), so both are opt-in.
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
import { looksLikeMarkdown } from "./markdown.ts";

const GATEWAY = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/**
 * The callback topic a bot's messages arrive on, and its REST twin's path.
 *
 * Note the delivery model this topic implies: in group conversations DingTalk
 * delivers only the frames where the sender @-mentioned the robot — other
 * chatter is never pushed, and no console toggle exists to change that. (Feishu's
 * bot subscribes to every message in chats it joins, which is why the Feishu
 * adapter answers un-@'d lines and this one cannot.) Direct sessions deliver
 * everything. So an unanswered group question with no ledger record means the
 * sender did not @-mention us — said here because it reads exactly like a bug.
 */
export const TOPIC = "/v1.0/im/bot/messages/get";
const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
/** The REST twin of the stream topic: exchanges a media downloadCode for bytes. */
const DOWNLOAD_URL = "https://api.dingtalk.com/v1.0/im/bot/messages/get";
const GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
const OTO_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
/** Interactive-card lifecycle: create the instance, then deliver it into a space. */
const CARD_CREATE_URL = "https://api.dingtalk.com/v1.0/card/instances";
const CARD_DELIVER_URL = "https://api.dingtalk.com/v1.0/card/instances/deliver";
/** Rewrites an existing card instance's variables in place; the handle is `outTrackId`. */
const CARD_UPDATE_URL = "https://api.dingtalk.com/v1.0/card/instances";
/**
 * The legacy media endpoint. Old host, old envelope, new token still accepted —
 * this is the documented upload-then-reference path behind `sampleFile` and
 * `sampleImageMsg`, and the reason outbound media needs no public URL.
 */
const MEDIA_UPLOAD_URL = "https://oapi.dingtalk.com/media/upload";
/**
 * Button presses on an interactive card arrive as callback frames over the same
 * stream connection — no public URL involved — when the template was created with
 * `callbackType: STREAM` and this topic is subscribed.
 */
export const CARD_CALLBACK_TOPIC = "/v1.0/card/instances/callback";

/**
 * The stream subscriptions for one installation: bot messages always, card button
 * callbacks only when a card template is configured.
 */
export function subscriptionsFor(cardTemplateId: string | undefined): {
  type: string;
  topic: string;
}[] {
  return [
    { type: "CALLBACK", topic: TOPIC },
    ...(cardTemplateId !== undefined && cardTemplateId !== ""
      ? [{ type: "CALLBACK", topic: CARD_CALLBACK_TOPIC }]
      : []),
  ];
}

/** A pressed button as the wire delivers it, narrowed to everything read here. */
export interface CardCallbackFrame {
  userId?: string;
  /** Stringified JSON of whatever parameters the pressed button was configured to send. */
  content?: string;
  /** The card instance id this press belongs to — our handle back to the approval. */
  outTrackId?: string;
  spaceType?: string;
  spaceId?: string;
  type?: string;
}

/**
 * Parses one callback frame into a decision, or undefined when anything is off.
 * The buttons carry a single static parameter `{ action: once | always | deny }`;
 * anything else is not a decision we advertised.
 */
export function approvalPressFrom(
  frame: CardCallbackFrame
): { reply: ApprovalReply; userId: string; instanceId: string; spaceType?: string; spaceId?: string } | undefined {
  const reply = (() => {
    try {
      const parsed = JSON.parse(frame.content ?? "{}") as { action?: unknown };
      if (parsed.action === "once") return "once" as const;
      if (parsed.action === "always") return "always" as const;
      if (parsed.action === "deny") return "deny" as const;
      return undefined;
    } catch {
      return undefined;
    }
  })();
  const userId = typeof frame.userId === "string" ? frame.userId : "";
  const instanceId = typeof frame.outTrackId === "string" ? frame.outTrackId : "";
  if (reply === undefined || userId === "" || instanceId === "") return undefined;
  return {
    reply,
    userId,
    instanceId,
    ...(frame.spaceType !== undefined ? { spaceType: frame.spaceType } : {}),
    ...(frame.spaceId !== undefined ? { spaceId: frame.spaceId } : {}),
  };
}

/** The card variables the lumenbox-approval template renders. */
export function approvalVarsFor(card: ApprovalCardState): {
  title: string;
  description: string;
} {
  return {
    title: `${card.agentName || "An agent"} needs your consent`,
    // The original action verbatim, then what answering means — an approval that
    // paraphrases either is the injection surface the verbatim rule exists to close.
    description: `${card.description}\n\n${card.stakes}`,
  };
}

/**
 * The card variables a task-card template renders. The contract a console template
 * has to bind, all strings because `cardParamMap` carries strings only: `title`,
 * `agentName`, `requesterLabel`, `status` (queued | working | done | failed),
 * `action`, `ahead`, `taskId`, `taskUrl`. A variable the state does not carry right
 * now is sent empty rather than omitted, so a template that binds it re-renders a
 * blank instead of keeping a stale line alive.
 */
export function taskVarsFor(card: TaskCardState): Record<string, string> {
  return {
    title: card.title,
    agentName: card.agentName,
    requesterLabel: card.requesterLabel,
    status: card.status,
    ...(card.action !== undefined ? { action: card.action } : { action: "" }),
    ...(card.ahead !== undefined ? { ahead: String(card.ahead) } : { ahead: "" }),
    ...(card.taskId !== undefined ? { taskId: card.taskId } : { taskId: "" }),
    ...(card.taskUrl !== undefined ? { taskUrl: card.taskUrl } : { taskUrl: "" }),
  };
}

/** Where in the card system's space taxonomy a conversation lives. */
export function imSpaceIdFor(route: "group" | "direct", spaceKey: string): string {
  return route === "group"
    ? `dtv1.card//IM_GROUP.${spaceKey}`
    : `dtv1.card//IM_ROBOT.${spaceKey}`;
}

/** Auth header every api.dingtalk.com call except the token endpoint wants. */
const AUTH_HEADER = "x-acs-dingtalk-access-token";

/**
 * Where one message ends and the next begins. The session webhook refuses bodies
 * past a ceiling measured in UTF-8 bytes, and Chinese text spends three bytes per
 * character — 3500 characters keeps a full report comfortably under it while
 * leaving room for the JSON envelope around the text.
 */
export const CHUNK_CHARS = 3500;

interface StreamFrame {
  specVersion?: string;
  type?: string;
  headers?: { topic?: string; messageId?: string };
  data?: string;
}

export interface AtUser {
  dingtalkId?: string;
  staffId?: string;
}

export interface RichRun {
  type?: string;
  text?: string;
  downloadCode?: string;
}

export interface MessageContent {
  downloadCode?: string;
  fileName?: string;
  spaceId?: string;
  richText?: unknown;
}

/** One bot message as the wire delivers it, narrowed to everything read here. */
export interface BotMessage {
  msgtype?: string;
  msgId?: string;
  conversationId?: string;
  /** `"1"` is a direct session, `"2"` a group. */
  conversationType?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  atUsers?: AtUser[];
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: { content?: string };
  content?: MessageContent;
}

export interface ChatTarget {
  route: "group" | "direct";
  conversationId: string;
  /** Who to reach on the direct route, when known. */
  userId?: string;
}

/** Which conversation id a chatKey addresses. There is no thread half on this wire. */
export function parseChatKey(chatKey: string): { conversationId: string } {
  const conversationId = chatKey.replace(/^dingtalk:/, "").split(":")[0] ?? "";
  return { conversationId };
}

/**
 * Which robot API a push to this conversation rides. A group gets
 * `groupMessages/send`; a direct session has no group-send analogue — it goes by
 * user id through `oToMessages/batchSend`. Unknown counts as a group, because chat
 * keys are minted in groups far more often than anywhere else, and a wrong guess
 * fails loudly once rather than silently always.
 */
export function outboundRoute(conversationType?: string): "group" | "direct" {
  return conversationType === "1" ? "direct" : "group";
}

/**
 * A DingTalk rich-text body as plain text, paragraphs joined by newlines.
 *
 * Picture runs are collected rather than skipped — a screenshot pasted among words
 * is part of the instruction — and marked in place, so the agent knows where in the
 * message each one sat. It is the same contract the Feishu adapter's
 * `renderPostBody` serves; only the run shape differs (`type`/`downloadCode` rather
 * than `tag`/`image_key`).
 */
export function flattenRichText(paragraphs: unknown): {
  text: string;
  pictureCodes: string[];
} {
  const lines: string[] = [];
  const pictureCodes: string[] = [];
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
    const runs: string[] = [];
    for (const run of Array.isArray(paragraph) ? paragraph : []) {
      const part = run as RichRun;
      if (part.type === "picture" && typeof part.downloadCode === "string") {
        pictureCodes.push(part.downloadCode);
        runs.push(`[image ${pictureCodes.length}]`);
      } else if (typeof part.text === "string") {
        runs.push(part.text);
      }
    }
    lines.push(runs.join(""));
  }
  return { text: lines.join("\n"), pictureCodes };
}

/** The downloadable media a whole-message body carries, waiting on their bytes. */
export function mediaOf(
  msgtype: string | undefined,
  content: MessageContent | undefined
): { kind: string; code: string; name?: string }[] {
  if (!["image", "picture", "audio", "video", "file"].includes(msgtype ?? "")) return [];
  const code = content?.downloadCode;
  if (typeof code !== "string" || code === "") return [];
  // The wire names the type `picture`; everywhere else the word is `image`. `kind`
  // keeps the wire's own word — it decides how bytes are fetched — while the name a
  // human sees is built from it.
  return [
    {
      kind: msgtype!,
      code,
      ...(msgtype === "file" && typeof content?.fileName === "string"
        ? { name: content.fileName }
        : {}),
    },
  ];
}

/**
 * Whether an empty-looking arrival still deserves a spoken answer.
 *
 * In a direct session an empty text frame is somebody getting the bot's attention;
 * in a group the same holds when anybody was @-mentioned (usually the bot itself —
 * that mention is how the frame reached us). Dropping either silently looks exactly
 * like an outage to the person who just pressed enter.
 */
export function wantsNudge(message: { conversationType?: string; atUsers?: AtUser[] }): boolean {
  if (message.conversationType === "1") return true;
  return Array.isArray(message.atUsers) && message.atUsers.length > 0;
}

/** The same slicing loop Feishu's chunker runs, extracted because tests care. */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

/** A short card-style title for a markdown message, from its first meaningful line. */
export function markdownTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map(candidate => candidate.trim())
      .find(candidate => candidate !== "") ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/**
 * The way out of a conversation, if it is still alive. An absent expiry means
 * "no death observed yet", not dead: webhooks are issued valid and the expiry
 * field arrived later than the webhook did.
 */
export function freshWebhookOf(
  conversation: { webhook?: string; webhookExpiresAt?: number } | undefined,
  now: number
): string | undefined {
  return typeof conversation?.webhook === "string" &&
    (conversation.webhookExpiresAt === undefined || conversation.webhookExpiresAt > now)
    ? conversation.webhook
    : undefined;
}

/**
 * Whether a refused push was about what the words looked like rather than whether
 * they could be delivered. Only the former earns the plain-text fallback — retrying
 * markdown as text against a dead network answers nobody, and degrading on every
 * failure would dress real delivery problems up as formatting ones.
 */
export function isContentRefusal(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /content|format|invalid|incorrect/i.test(detail);
}

const NUDGE_LINE =
  "(You mentioned me with no other words — I am here. Say what you need done and " +
  "I will get on it.)";

/** Pulls the vendor's own words out of whichever envelope the error arrived in. */
async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    detail = [body.code, body.message].filter(part => part !== undefined).join(" ");
  } catch {
    detail = "";
  }
  return detail === "" ? `HTTP ${response.status}` : `${response.status} ${detail}`.trim();
}

/** How a human should hear who is speaking, from what the wire gives. */
function senderLabel(payload: BotMessage, fallback: string): string {
  const nick = payload.senderNick?.trim();
  return nick !== undefined && nick !== "" ? nick : fallback;
}

/** An honest filename for media that arrived unnamed. */
function extensionOf(kind: string): string {
  if (kind === "image" || kind === "picture") return "png";
  if (kind === "audio") return "mp3";
  if (kind === "video") return "mp4";
  return "bin";
}

/** The upload endpoint sizes its buckets by type; going past earns a loud refusal. */
const MEDIA_UPLOAD_CAPS: Record<string, number> = {
  image: 10 * 1024 * 1024,
  file: 20 * 1024 * 1024,
  video: 20 * 1024 * 1024,
  voice: 2 * 1024 * 1024,
};

/** A part content-type for the upload's multipart body; the endpoint barely reads it. */
function mimeOf(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) return `image/${extension === "jpg" ? "jpeg" : extension}`;
  if (extension === "pdf") return "application/pdf";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mp3") return "audio/mpeg";
  if (["txt", "md", "csv", "json"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

export class DingTalkChannel implements ChannelAdapter {
  readonly name = "dingtalk";
  private stopped = false;
  private socket: WebSocket | undefined;
  /** Held while this process is the app's stream consumer. */
  private releaseLock: (() => void) | undefined;

  /**
   * Each conversation the bot has been seen in: its session webhook and when that
   * dies, plus the conversation type that decides the REST route. A webhook is the
   * cheapest way out — pre-authorised, no token — but it expires, so anything older
   * falls back to the robot APIs underneath. `userId` is the last sender seen in
   * the room, what a direct-route card addresses.
   */
  private readonly conversations = new Map<
    string,
    { webhook?: string; webhookExpiresAt?: number; conversationType?: string; userId?: string }
  >();
  /** The conversation each identity last spoke in, for routing a notice back. */
  private readonly identities = new Map<string, string>();

  /**
   * Message ids already answered, id → arrival ms. DingTalk redelivers frames
   * across reconnects and slow acks, and a redelivered event is a duplicate turn.
   * Keyed on `msgId` — the id of the *message*, which is what must run once — not
   * the transport id, which is regenerated per delivery. Same shape as the Feishu
   * adapter's: memory-only; a restart re-answering one message is the accepted cost.
   */
  private readonly seenMessages = new Map<string, number>();

  private tokenPromise: Promise<string> | undefined;
  private tokenExpiresAt = 0;

  /**
   * The card instance each pending approval lives behind, instance → approval.
   * A press carries only the instance id and the button's static value, so this
   * map is the bridge back to what was being decided. Pruned by count; a stale
   * entry merely answers "no longer waiting", which is already a safe verdict.
   */
  private readonly cardApprovals = new Map<string, { approvalId: string }>();
  private cardCounter = 0;

  /**
   * Texts just admitted, fingerprint → first-arrival ms. The wire mints a fresh
   * msgId when a sender's client retries, so the msgId dedupe above cannot see a
   * message that arrives twice within seconds — the words can. Observed: one paste
   * delivered as two frames 0.9s apart under two msgIds, both admitted, the prompt
   * written into the transcript twice. Memory-only, pruned by age and size.
   */
  private readonly recentTexts = new Map<string, number>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
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
    /**
     * A card-platform template id (`….schema`), when the installation built one.
     * Its presence is what turns button approvals on: without it the class leaves
     * `postApprovalCard` undefined and the manager runs the text-verb path.
     */
    private readonly cardTemplateId?: string,
    /**
     * A second template id, this one rendering task progress (`taskVarsFor` names
     * the variables it must bind). Its presence is what turns task cards on; the
     * manager checks for `postTaskCard` and falls back to the plain ack line.
     */
    private readonly taskCardTemplateId?: string
  ) {
    if (cardTemplateId !== undefined && cardTemplateId !== "") {
      this.postApprovalCard = (identity, card) => this.deliverApprovalCard(identity, card);
    }
    if (taskCardTemplateId !== undefined && taskCardTemplateId !== "") {
      this.postTaskCard = (chatKey, card, options, identity) =>
        this.deliverTaskCard(chatKey, card, options, identity);
      this.updateTaskCard = (handle, card) => this.rewriteTaskCard(handle, card);
    }
  }

  /**
   * Posts the consent request as an interactive card, wired to whatever
   * conversation this identity last spoke from. Defined only when a card template
   * is configured — the manager checks for the method's existence to choose
   * between buttons and text verbs, so an unconfigured installation honestly reads
   * as "no buttons here".
   */
  postApprovalCard?: (
    identity: string,
    card: ApprovalCardState
  ) => Promise<void>;

  /**
   * Posts the task card and returns the instance id `rewriteTaskCard` accepts.
   * Defined only when a task-card template is configured, for the same reason the
   * approval card is: absent means the manager's plain ack line, not a silent hole.
   */
  postTaskCard?: (
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions,
    identity?: string
  ) => Promise<string | undefined>;

  /** Rewrites a posted task card in place as the task's state moves. */
  updateTaskCard?: (handle: string, card: TaskCardState) => Promise<void>;

  async start(onMessage: (message: InboundMessage) => Promise<string | undefined>): Promise<void> {
    // Before anything connects. DingTalk load-balances a client's callback frames
    // across every open stream connection, so a second instance would not fail — it
    // would silently take half the traffic. Refused loudly instead.
    this.releaseLock = acquireConsumerLock(this.clientId, process.pid, {
      id: "dingtalk",
      label: "DingTalk",
    });
    await this.connect(onMessage);
  }

  /** Which topics this installation subscribes — messages, plus card presses if cards are on. */
  private subscriptions(): { type: string; topic: string }[] {
    return subscriptionsFor(this.cardTemplateId);
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.releaseLock?.();
  }

  /**
   * Reaches DingTalk over HTTPS, deliberately not over the stream socket.
   *
   * The socket offers neither state nor a close hook worth trusting, so this asks
   * the vendor for an access token, which needs only the credentials. A success
   * here alongside a long silence separates "quiet afternoon" from "dead socket":
   * the account is fine and nothing is listening. The same proof the Feishu probe
   * makes with its tenant token.
   */
  async probe(): Promise<string | undefined> {
    try {
      await this.accessToken();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Records an id and says whether it was already seen. Prunes by age and size. */
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

  /** Records a discard against the arrival, so no drop is silent. */
  private discard(messageId: string | undefined, reason: string): void {
    this.log(`channel dingtalk: dropped ${messageId ?? "?"} — ${reason}`);
    if (messageId !== undefined) this.ingress?.decided(messageId, "dropped", reason);
  }

  /**
   * Whether these exact words landed in this room moments ago, recording first
   * sights. Whitespace is collapsed because the two copies of one send differ in
   * envelope (text vs rich text) more reliably than in spacing. A person who
   * genuinely repeats a line inside the window loses the repeat — the cheap price
   * of not running one prompt twice; the window is deliberately short.
   */
  private isRepeatedArrival(chatKey: string, text: string): boolean {
    const REPEAT_WINDOW_MS = 10_000;
    const now = Date.now();
    const fingerprint = `${chatKey}\u0000${text.replace(/\s+/g, " ").trim()}`;
    const seenAt = this.recentTexts.get(fingerprint);
    if (seenAt !== undefined && now - seenAt < REPEAT_WINDOW_MS) return true;
    if (seenAt === undefined) {
      this.recentTexts.set(fingerprint, now);
      if (this.recentTexts.size > 512) {
        for (const [key, at] of this.recentTexts) {
          if (now - at > 60_000 || this.recentTexts.size > 512) this.recentTexts.delete(key);
          else break;
        }
      }
    }
    return false;
  }

  /** An access token, cached to just shy of its stated expiry, fetched in one flight. */
  private async accessToken(): Promise<string> {
    // The slot is claimed before fetching, so a burst of concurrent callers waits on
    // one request instead of stampeding the endpoint; a failed fetch empties the
    // slot, so the next caller retries rather than replays the rejection.
    if (this.tokenPromise !== undefined && this.tokenExpiresAt > Date.now()) {
      return this.tokenPromise;
    }
    this.tokenExpiresAt = Date.now();
    const request = (async () => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`dingtalk access token: ${await describeFailure(response)}`);
      }
      const body = (await response.json()) as { accessToken?: string; expireIn?: number };
      if (typeof body.accessToken !== "string" || body.accessToken === "") {
        throw new Error("dingtalk access token: response carried no token");
      }
      this.tokenExpiresAt = Date.now() + Math.max((body.expireIn ?? 7200) * 1000 - 60_000, 0);
      return body.accessToken;
    })();
    this.tokenPromise = request;
    void request.catch(() => {}).finally(() => {
      if (this.tokenExpiresAt <= Date.now()) this.tokenPromise = undefined;
    });
    return request;
  }

  /**
   * The bytes behind a downloadCode, base64, or an empty answer with the reason
   * logged. The exchange has been observed answering in two shapes — the file
   * itself, and a JSON wrapper carrying a short-lived URL — so both are understood
   * rather than one being trusted. Capped at 25MB: past that, the box is the wrong
   * transport.
   */
  private async downloadResource(code: string): Promise<{ base64?: string }> {
    let response: Response;
    try {
      const token = await this.accessToken();
      const query = new URLSearchParams({ downloadCode: code, robotCode: this.clientId });
      response = await fetch(`${DOWNLOAD_URL}?${query}`, {
        headers: { [AUTH_HEADER]: token },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel dingtalk: media fetch failed (${detail})`);
      return {};
    }
    if (!response.ok) {
      this.log(`channel dingtalk: media refused (${await describeFailure(response)})`);
      return {};
    }
    const readBytes = async (fetched: Response): Promise<string | undefined> => {
      const buffer = Buffer.from(await fetched.arrayBuffer());
      if (buffer.byteLength > 25 * 1024 * 1024) {
        this.log("channel dingtalk: media past the 25MB cap, dropped");
        return undefined;
      }
      return buffer.toString("base64");
    };
    try {
      // Some configurations answer the exchange with a pointer, not the bytes.
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const pointed = (await response.json()) as { downloadUrl?: string };
        if (typeof pointed.downloadUrl !== "string") {
          this.log("channel dingtalk: media answer named no download url");
          return {};
        }
        const second = await fetch(pointed.downloadUrl, { signal: AbortSignal.timeout(60_000) });
        if (!second.ok) {
          this.log(`channel dingtalk: media url refused (HTTP ${second.status})`);
          return {};
        }
        const base64 = await readBytes(second);
        return base64 === undefined ? {} : { base64 };
      }
      const base64 = await readBytes(response);
      return base64 === undefined ? {} : { base64 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel dingtalk: media read failed (${detail})`);
      return {};
    }
  }

  private async connect(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    const opened = await fetch(GATEWAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: this.subscriptions(),
        ua: "lumenbox",
      }),
    });
    if (!opened.ok) {
      throw new Error(`dingtalk gateway: ${opened.status} ${(await opened.text()).slice(0, 300)}`);
    }
    const { endpoint, ticket } = (await opened.json()) as { endpoint?: string; ticket?: string };
    if (!endpoint || !ticket) throw new Error("dingtalk gateway: no endpoint in response");

    const socket = new WebSocket(`${endpoint}?ticket=${ticket}`);
    this.socket = socket;

    socket.addEventListener("message", event => {
      // The ack echoes the transport id back through the socket. Splitting "reply on
      // the wire" from "interpret the frame" keeps receive() drivable without one.
      const wire = {
        respond: (headers: { messageId: string }, data: string) =>
          socket.send(
            JSON.stringify({
              code: 200,
              headers: { ...headers, contentType: "application/json" },
              message: "OK",
              data,
            })
          ),
      };
      void this.receive(String(event.data), wire, onMessage);
    });

    socket.addEventListener("close", () => {
      if (this.stopped) return;
      this.log("channel dingtalk: connection closed; reconnecting in 5s");
      setTimeout(() => {
        void this.connect(onMessage).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.log(`channel dingtalk: reconnect failed (${detail})`);
        });
      }, 5000);
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("dingtalk: websocket error")), {
        once: true,
      });
    });
  }

  /**
   * One delivered frame, from raw text to handled message.
   *
   * Split from the websocket wiring so the ordering rule sits in one place, and so
   * tests can drive it without a gateway: ack first, then the ledger, then the
   * dedupe, then whatever work follows.
   */
  async receive(
    raw: string,
    wire: { respond: (headers: { messageId: string }, data: string) => void },
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    let frame: StreamFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      // A whole frame discarded. Silent, this is the same failure Feishu had: a message
      // that arrived and vanished looks exactly like one that never arrived, and the
      // only way to tell was to add a log line and ask somebody to send it again.
      this.log(`channel dingtalk: frame did not parse, dropped`);
      return;
    }
    const transportId = frame.headers?.messageId ?? "";
    const ack = (data: string) => wire.respond({ messageId: transportId }, data);

    // Every frame is acked, ping and message alike: an unacked message is redelivered.
    if (frame.type === "SYSTEM") {
      ack(frame.data ?? "{}");
      return;
    }
    if (frame.headers?.topic === CARD_CALLBACK_TOPIC) {
      // The response body may carry cardData updates for the pressed card; an empty
      // one leaves the card as it stands, and the manager's answer travels as a
      // chat message instead.
      ack(JSON.stringify({}));
      await this.handleCardCallback(frame.data ?? "{}", onMessage);
      return;
    }
    if (frame.headers?.topic !== TOPIC) {
      ack("{}");
      return;
    }
    ack(JSON.stringify({ response: {} }));

    let payload: BotMessage;
    try {
      payload = JSON.parse(frame.data ?? "{}");
    } catch {
      this.log(`channel dingtalk: dropped ${transportId || "?"} — body did not parse`);
      return;
    }

    const chatKey = `dingtalk:${
      payload.conversationId ?? payload.senderStaffId ?? payload.senderId ?? "unknown"
    }`;
    const identity = `dingtalk:${payload.senderStaffId ?? payload.conversationId ?? "unknown"}`;
    const sender = payload.senderStaffId ?? payload.conversationId ?? "unknown";

    // Logged before anything can drop it, under the business id when there is one:
    // the transport id changes per redelivery, and the ledger follows the message.
    const inboundId =
      typeof payload.msgId === "string" && payload.msgId !== "" ? payload.msgId : transportId;
    if (inboundId !== "") {
      this.ingress?.arrived({
        id: inboundId,
        channel: "dingtalk",
        identity,
        chatKey,
        kind: payload.msgtype ?? "unknown",
        chars:
          payload.msgtype === "text"
            ? (payload.text?.content ?? "").length
            : JSON.stringify(payload.content ?? {}).length,
        ...(payload.conversationType !== undefined
          ? { chatType: payload.conversationType }
          : {}),
        at: new Date().toISOString(),
      });
    }

    // Recorded ahead of the dedupe, because a redelivered frame refreshes a webhook
    // that may be the freshest one known.
    if (typeof payload.conversationId === "string" && payload.conversationId !== "") {
      const known = this.conversations.get(payload.conversationId) ?? {};
      this.conversations.set(payload.conversationId, {
        ...known,
        ...(typeof payload.sessionWebhook === "string"
          ? {
              webhook: payload.sessionWebhook,
              webhookExpiresAt:
                typeof payload.sessionWebhookExpiredTime === "number"
                  ? payload.sessionWebhookExpiredTime
                  : undefined,
            }
          : {}),
        ...(payload.conversationType !== undefined
          ? { conversationType: payload.conversationType }
          : {}),
        ...(typeof payload.senderStaffId === "string" && payload.senderStaffId !== ""
          ? { userId: payload.senderStaffId }
          : {}),
      });
      this.identities.set(identity, payload.conversationId);
    }

    const messageId = typeof payload.msgId === "string" && payload.msgId !== "" ? payload.msgId : undefined;
    if (messageId !== undefined && this.alreadySeen(messageId)) {
      this.discard(messageId, "delivered more than once");
      return;
    }

    // Whole-message media: fetch the bytes here (bounded), then hand over an
    // ordinary inbound message that carries them. All-failed means told, not silent.
    const attachments: { name: string; base64: string }[] = [];
    const wholeMedia = mediaOf(payload.msgtype, payload.content);
    for (const item of wholeMedia) {
      const fetched = await this.downloadResource(item.code);
      if (fetched.base64 === undefined) continue;
      const name =
        item.name ??
        `${item.kind}-${messageId?.slice(-8) ?? "attachment"}.${extensionOf(item.kind)}`;
      attachments.push({ name, base64: fetched.base64 });
    }
    if (wholeMedia.length > 0) {
      if (attachments.length === 0) {
        this.discard(messageId ?? transportId, "media could not be fetched");
        return;
      }
      await this.dispatch(
        identity,
        chatKey,
        messageId,
        senderLabel(payload, sender),
        "",
        attachments,
        onMessage
      );
      return;
    }

    let body = payload.text?.content?.trim() ?? "";
    let embeddedPictures: string[] = [];
    if (payload.msgtype === "richText") {
      // Anything pasted with formatting, a line break or a picture arrives as rich
      // text, which is most of what a person actually sends.
      const rendered = flattenRichText(payload.content?.richText);
      body = rendered.text.trim();
      embeddedPictures = rendered.pictureCodes;
    }

    // Ahead of the nudge and the turn: a retried send carries a fresh msgId, so
    // this is the only net that catches it, and a caught duplicate should not
    // spend picture downloads on its way out.
    if (body !== "" && this.isRepeatedArrival(chatKey, body)) {
      this.discard(messageId ?? transportId, "the same words arrived twice within seconds");
      return;
    }

    if (body === "") {
      // A bare mention is a person addressing you, not an empty message. Dropping it
      // silently is the worst possible answer: they get nothing back and reasonably
      // conclude the bot is broken (see wantsNudge).
      if (!wantsNudge(payload)) {
        this.discard(messageId ?? transportId, "no usable text");
        return;
      }
      body = NUDGE_LINE;
    }

    const files: { name: string; base64: string }[] = [];
    for (const [index, code] of embeddedPictures.entries()) {
      const fetched = await this.downloadResource(code).catch(() => ({}) as { base64?: string });
      if (fetched.base64 === undefined) {
        this.log(
          `channel dingtalk: image ${index + 1} in ${messageId ?? "?"} could not be fetched`
        );
        continue;
      }
      files.push({ name: `image-${index + 1}.png`, base64: fetched.base64 });
    }
    await this.dispatch(
      identity,
      chatKey,
      messageId,
      senderLabel(payload, sender),
      body,
      files,
      onMessage
    );
  }

  /**
   * Hands one arrival to the bus, and pushes the turn's answer back into the very
   * conversation it came from.
   */
  private async dispatch(
    identity: string,
    chatKey: string,
    messageId: string | undefined,
    label: string,
    text: string,
    files: { name: string; base64: string }[],
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    try {
      const reply = await onMessage({
        identity,
        chatKey,
        // No threads on this wire: the conversation *is* the subject, so no
        // threadKey is offered and the manager keys context on the chat alone.
        ...(messageId !== undefined ? { messageId } : {}),
        senderLabel: label,
        text,
        ...(files.length > 0 ? { files } : {}),
      });
      if (reply !== undefined && reply !== "") await this.sendToChat(chatKey, reply);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel dingtalk: reply failed (${detail})`);
    }
  }

  async send(identity: string, text: string): Promise<void> {
    // Plain conversational lines — refusals, approval prompts, questions. Formatted
    // results travel through sendToChat's markdown verdict instead, mirroring how
    // `send` and `sendToChat` split everywhere else.
    const conversationId = this.identities.get(identity);
    await this.transmit(
      {
        // No conversation on record means nothing to send a group message into;
        // the only address left is the user id inside the identity, so force the
        // direct route even though a group is the usual default.
        route:
          conversationId === undefined
            ? "direct"
            : outboundRoute(this.conversations.get(conversationId)?.conversationType),
        conversationId: conversationId ?? "",
        // The user id inside the identity: what oToMessages addresses when the
        // webhook has expired and the route turns out to be a direct session.
        ...(identity.startsWith("dingtalk:") ? { userId: identity.slice("dingtalk:".length) } : {}),
      },
      "text",
      text
    );
  }

  /**
   * Pushes to the conversation itself, not to wherever the sender last spoke.
   *
   * `PushOptions.replyTo` is accepted because the manager hands it to every adapter,
   * but threads do not exist between a person and a DingTalk bot: there is nowhere
   * to anchor, and inventing an anchor would put a lie in the interface. Markdown
   * travels as the wire's markdown type; a chunk whose rendering the wire refuses
   * degrades to plain text for it and every chunk after, so the words arrive either
   * way — the bargain the Feishu adapter strikes too.
   */
  async sendToChat(chatKey: string, text: string, options?: { replyTo?: string }): Promise<void> {
    void options; // see doc comment: anchoring is not expressible on this wire
    const { conversationId } = parseChatKey(chatKey);
    if (conversationId === "") return;
    const target: ChatTarget = {
      route: outboundRoute(this.conversations.get(conversationId)?.conversationType),
      conversationId,
    };
    // Decided once for the whole message: per-chunk verdicts would render a long
    // message's plain halves with literal ** markers.
    const markdown = looksLikeMarkdown(text);
    let degraded = false;
    for (const chunk of chunkText(text, CHUNK_CHARS)) {
      if (markdown && !degraded) {
        try {
          await this.transmit(target, "markdown", chunk, markdownTitle(chunk));
          continue;
        } catch (error) {
          if (!isContentRefusal(error)) throw error;
          degraded = true;
        }
      }
      await this.transmit(target, "text", chunk);
    }
  }

  /**
   * One message out, on whichever road still works.
   *
   * Webhooks win while fresh — no token, no extra round trip, already bound to this
   * conversation. The robot REST APIs cover everything older: they need an access
   * token, and the direct route may refuse outright when proactive one-to-one
   * messaging is switched off for the app. That refusal is relayed rather than
   * swallowed, because a push that quietly went nowhere is worse than a loud failure.
   */
  protected async transmit(
    target: ChatTarget,
    kind: "text" | "markdown",
    body: string,
    title?: string
  ): Promise<void> {
    const freshWebhook = freshWebhookOf(
      target.conversationId !== ""
        ? this.conversations.get(target.conversationId)
        : undefined,
      Date.now()
    );

    if (freshWebhook === undefined && target.conversationId === "" && target.userId === undefined) {
      throw new Error(
        "nowhere to deliver: this conversation has no webhook and no user id on record"
      );
    }
    if (target.route === "direct" && !target.userId) {
      throw new Error(
        "no way to reach this direct session: no fresh webhook, and no user id on record"
      );
    }

    if (freshWebhook !== undefined) {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(freshWebhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              kind === "text"
                ? { msgtype: "text", text: { content: body } }
                : { msgtype: "markdown", markdown: { title: title ?? "", text: body } }
            ),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(await describeFailure(response));
          // A satisfied status can still carry an errcode body; that is a refusal.
          const verdict = (await response.json().catch(() => ({}))) as { errcode?: number };
          if (verdict.errcode !== undefined && verdict.errcode !== 0) {
            throw new Error(`webhook errcode ${verdict.errcode}`);
          }
          return;
        } catch (error) {
          last = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      throw last instanceof Error ? last : new Error(String(last));
    }

    if (kind === "text") {
      await this.restSend(target, "sampleText", { content: body });
      return;
    }
    await this.restSend(target, "sampleMarkdown", {
      title: title ?? markdownTitle(body),
      text: body,
    });
  }

  /**
   * One message out over the robot REST APIs, whichever msgKey the payload needs —
   * the text/markdown kinds `transmit` falls back to, and the media kinds
   * `sendFile`/`sendImage` exist for. Media has no webhook road: a session webhook
   * carries neither files nor an uploaded image key, so every media message rides
   * here even when a fresh webhook exists.
   */
  private async restSend(
    target: ChatTarget,
    msgKey: string,
    msgParam: Record<string, unknown>
  ): Promise<void> {
    if (target.conversationId === "" && target.userId === undefined) {
      throw new Error(
        "nowhere to deliver: this conversation has no webhook and no user id on record"
      );
    }
    if (target.route === "direct" && !target.userId) {
      throw new Error(
        "no way to reach this direct session: no fresh webhook, and no user id on record"
      );
    }
    // msgParam rides this API as a *string*: the inner object serialized again.
    const response = await fetch(
      target.route === "group" ? GROUP_SEND_URL : OTO_SEND_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_HEADER]: await this.accessToken(),
        },
        body: JSON.stringify(
          target.route === "group"
            ? {
                robotCode: this.clientId,
                openConversationId: target.conversationId,
                msgKey,
                msgParam: JSON.stringify(msgParam),
              }
            : {
                robotCode: this.clientId,
                userIds: [target.userId],
                msgKey,
                msgParam: JSON.stringify(msgParam),
              }
        ),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) throw new Error(await describeFailure(response));
  }

  /** Set by the manager before start; a press with no handler is acknowledged and dropped. */
  private approvalHandler:
    | ((press: {
        approvalId: string;
        reply: ApprovalReply;
        identity: string;
      }) => Promise<string | undefined>)
    | undefined;

  onApprovalAction(
    handler: NonNullable<DingTalkChannel["approvalHandler"]>
  ): void {
    this.approvalHandler = handler;
  }

  /**
   * One button press on a consent card.
   *
   * The frame says who pressed and which static value the button carries; this map
   * through the instance id back to the pending approval is what makes it a
   * decision. Replies land in the room the card was delivered to when it was a
   * group, and in the sender's conversation otherwise — mirroring how the Feishu
   * adapter routes a pressed answer.
   */
  private async handleCardCallback(
    raw: string,
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    void onMessage;
    let frame: CardCallbackFrame;
    try {
      frame = JSON.parse(raw) as CardCallbackFrame;
    } catch {
      this.log("channel dingtalk: card callback did not parse");
      return;
    }
    const press = approvalPressFrom(frame);
    if (press === undefined || this.cardTemplateId === undefined) return;
    const pending = this.cardApprovals.get(press.instanceId);
    const identity = `dingtalk:${press.userId}`;
    if (pending === undefined) {
      this.log(`channel dingtalk: press on unknown card ${press.instanceId} by ${identity}`);
      await this.send(identity,
        "That consent is no longer waiting — it may have been answered from the app, " +
          "or the turn moved on.").catch(() => {});
      return;
    }
    this.cardApprovals.delete(press.instanceId);
    if (this.approvalHandler === undefined) return;
    try {
      const line = await this.approvalHandler({
        approvalId: pending.approvalId,
        reply: press.reply,
        identity,
      });
      if (line === undefined) return;
      if (press.spaceType === "IM_GROUP" && typeof press.spaceId === "string" && press.spaceId !== "") {
        await this.sendToChat(`dingtalk:${press.spaceId}`, line);
      } else {
        await this.send(identity, line);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`channel dingtalk: card press handling failed (${detail})`);
    }
  }

  /**
   * Creates one interactive-card instance from the configured template and
   * delivers it into the target space. Two REST calls with the same access token
   * as everything else; `callbackType: STREAM` is what routes button presses onto
   * our long connection instead of demanding a public endpoint.
   */
  private async createAndDeliverCard(
    target: {
      route: "group" | "direct";
      conversationId: string;
      userId?: string;
    },
    templateId: string,
    vars: Record<string, string>
  ): Promise<string | undefined> {
    const outTrackId = `lumenbox-${Date.now()}-${(this.cardCounter++).toString(36)}`;
    const token = await this.accessToken();
    const created = await fetch(CARD_CREATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [AUTH_HEADER]: token },
      body: JSON.stringify({
        cardTemplateId: templateId,
        outTrackId,
        cardData: { cardParamMap: vars },
        callbackType: "STREAM",
        imGroupOpenSpaceModel: { supportForward: false },
        imRobotOpenSpaceModel: { supportForward: false },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) throw new Error(`card create failed: ${await describeFailure(created)}`);
    const spaceKey = target.route === "group" ? target.conversationId : (target.userId ?? "");
    if (spaceKey === "") throw new Error("card deliver had nowhere to land: no space key");
    const delivered = await fetch(CARD_DELIVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [AUTH_HEADER]: token },
      body: JSON.stringify({
        outTrackId,
        openSpaceId: imSpaceIdFor(target.route, spaceKey),
        ...(target.route === "group"
          ? { imGroupOpenDeliverModel: { robotCode: this.clientId, supportForward: false } }
          : { imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", supportForward: false } }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!delivered.ok) throw new Error(`card deliver failed: ${await describeFailure(delivered)}`);
    return outTrackId;
  }
  /**
   * The consent card, into wherever this identity speaks — bound at construction
   * time only when a template exists (see constructor).
   */
  private async deliverApprovalCard(identity: string, card: ApprovalCardState): Promise<void> {
    const conversationId = this.identities.get(identity);
    const conversation =
      conversationId !== undefined ? (this.conversations.get(conversationId) ?? {}) : {};
    const route = outboundRoute(conversation.conversationType);
    // A direct session carries no room: the card addresses the person, which the
    // robot space expresses as their user id rather than any conversation id.
    const target = {
      route,
      conversationId: conversationId ?? "",
      ...(identity.startsWith("dingtalk:") ? { userId: identity.slice("dingtalk:".length) } : {}),
    };
    const approvalId = card.approvalId;
    const instanceId = await this.createAndDeliverCard(
      target,
      this.cardTemplateId ?? "",
      approvalVarsFor(card)
    );
    if (instanceId === undefined) return;
    this.cardApprovals.set(instanceId, { approvalId });
    if (this.cardApprovals.size > 512) {
      for (const key of this.cardApprovals.keys()) {
        this.cardApprovals.delete(key);
        if (this.cardApprovals.size <= 384) break;
      }
    }
  }

  /**
   * The task card, into the chat that asked. Group cards land in the group's space;
   * a direct session's robot space names a person, not a room, so the card
   * addresses who asked — their identity when the manager hands it over, else the
   * last sender on record — and "no card" when neither exists, which the manager
   * answers with the plain ack line instead of silence.
   */
  private async deliverTaskCard(
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions,
    identity?: string
  ): Promise<string | undefined> {
    void options; // see sendToChat: anchoring is not expressible on this wire
    if (this.taskCardTemplateId === undefined || this.taskCardTemplateId === "") return undefined;
    const { conversationId } = parseChatKey(chatKey);
    if (conversationId === "") return undefined;
    const conversation = this.conversations.get(conversationId) ?? {};
    const route = outboundRoute(conversation.conversationType);
    const asker =
      route === "direct"
        ? (identity ?? (conversation.userId !== undefined ? `dingtalk:${conversation.userId}` : undefined))
        : undefined;
    const target = {
      route,
      conversationId,
      ...(asker?.startsWith("dingtalk:") ? { userId: asker.slice("dingtalk:".length) } : {}),
    };
    return this.createAndDeliverCard(target, this.taskCardTemplateId, taskVarsFor(card));
  }

  /**
   * Rewrites a posted task card's variables in place — queued → working → done, and
   * the current action line while it runs. The manager rate-limits callers already;
   * this is one PUT per allowed update.
   */
  private async rewriteTaskCard(handle: string, card: TaskCardState): Promise<void> {
    const response = await fetch(CARD_UPDATE_URL, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [AUTH_HEADER]: await this.accessToken(),
      },
      body: JSON.stringify({
        outTrackId: handle,
        cardData: { cardParamMap: taskVarsFor(card) },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`card update failed: ${await describeFailure(response)}`);
  }

  /**
   * The box's bytes, up and back as a mediaId. The endpoint is the legacy one —
   * old host, `errcode` envelope, multipart field named `media` — and it is the
   * documented source of the ids that `sampleFile`/`sampleImageMsg` reference. The
   * new access token is accepted there, so no second credential path exists.
   */
  private async uploadMedia(type: "image" | "file", name: string, bytes: Buffer): Promise<string> {
    const cap = MEDIA_UPLOAD_CAPS[type] ?? 20 * 1024 * 1024;
    if (bytes.byteLength > cap) {
      throw new Error(
        `media too large for dingtalk upload: ${bytes.byteLength} bytes against a ${cap}-byte cap`
      );
    }
    const token = await this.accessToken();
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(bytes)], { type: mimeOf(name) }), name);
    const query = new URLSearchParams({ access_token: token, type });
    const response = await fetch(`${MEDIA_UPLOAD_URL}?${query}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`media upload: ${await describeFailure(response)}`);
    const body = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
      mediaId?: string;
    };
    if (body.errcode !== undefined && body.errcode !== 0) {
      throw new Error(`media upload: ${body.errmsg ?? "refused"} (errcode ${body.errcode})`);
    }
    const mediaId = body.media_id ?? body.mediaId;
    if (mediaId === undefined || mediaId === "") {
      throw new Error("media upload returned no media id");
    }
    return mediaId;
  }

  /** Which chat a media push addresses, and how: the room, or its last sender. */
  private mediaTargetFor(chatKey: string): ChatTarget {
    const { conversationId } = parseChatKey(chatKey);
    const conversation = this.conversations.get(conversationId) ?? {};
    return {
      route: outboundRoute(conversation.conversationType),
      conversationId,
      ...(conversation.userId !== undefined ? { userId: conversation.userId } : {}),
    };
  }

  /** Which robot msgKey a media send answers to, and the param each one reads. */
  async sendFile(
    chatKey: string,
    name: string,
    base64: string,
    options?: PushOptions
  ): Promise<void> {
    void options; // see sendToChat: anchoring is not expressible on this wire
    const mediaId = await this.uploadMedia("file", name, Buffer.from(base64, "base64"));
    const extension = (name.split(".").pop() ?? "").toLowerCase();
    await this.restSend(this.mediaTargetFor(chatKey), "sampleFile", {
      mediaId,
      fileName: name,
      fileType: extension !== "" ? extension : "file",
    });
  }

  /** Upload the bytes, then reference them — the same bargain Feishu's adapter strikes. */
  async sendImage(chatKey: string, base64: string, options?: PushOptions): Promise<void> {
    void options; // see sendToChat: anchoring is not expressible on this wire
    const mediaId = await this.uploadMedia("image", "image.png", Buffer.from(base64, "base64"));
    // Verified against production usage elsewhere: the image msgKey reads the
    // uploaded id out of `photoURL`, not `mediaId`.
    await this.restSend(this.mediaTargetFor(chatKey), "sampleImageMsg", { photoURL: mediaId });
  }
}
