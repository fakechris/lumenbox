/**
 * Chat channels: the agents, reachable from a phone.
 *
 * The web UI answers "what are they doing"; a channel answers "make them do something,
 * from wherever I am". One message in, the addressed agent runs a full turn, and what
 * it said comes back as the reply — the same transcript, the same policy gate, the
 * same budget as every other way in. A channel is a front door, not a second product.
 *
 * **Accepted is not answered.** A turn runs for minutes; a chat platform's event
 * handler must return in seconds or the platform redelivers the event, and a
 * redelivered event is a duplicate turn. So `handle` acknowledges on the wire
 * immediately and the work runs behind it: a quick turn just posts its answer, a slow
 * one first says it is under way (a card where the adapter can, a line where it
 * cannot), and the result is pushed to the chat when it lands.
 *
 * **Closed by default.** A bot handle is discoverable, and "anyone who finds it can
 * drive a machine with a shell" is not a default anyone chose. The allow list lives in
 * the config file; an unauthorised sender is told their own `channel:id`, which is
 * exactly the string the owner needs to add. An empty list means nobody.
 *
 * Each adapter owns its own wire (long polling, a websocket) and reports its state
 * here; a channel that cannot connect says so in the settings dialog rather than
 * failing silently. Secrets arrive as environment variables — including via the
 * config file's env map — never as constructor literals.
 */

import type { Ingress } from "./ingress.ts";
import { channelHealth, type ChannelHealth } from "./liveness.ts";
import { boxPathsNamed, undelivered } from "../host/named-files.ts";
import { boardText, type BoardView } from "./board-view.ts";
import type { CardRecord } from "./card-ledger.ts";

import {
  APPROVAL_STAKES,
  CONSENT_GONE,
  EMPTY_REPLY_NOTE,
  NO_BOX_FOR_FILES,
  SAY_WHAT_YOU_NEED,
  SCOPE_IS_ADMIN_CALL,
  TEAM,
  NOTHING_RUNNING,
  STOPPING,
  ackQueued,
  ackWorking,
  consentFallbackText,
  accepted,
  filesSaved,
  questionText,
  steered,
} from "./strings.ts";

export interface InboundMessage {
  /** `telegram:123` — stable, and what the allow list matches. Who is *speaking*. */
  identity: string;
  /**
   * Which conversation this belongs to, when the platform has a finer idea than the chat.
   *
   * A chat is an address; a thread is a subject. Keyed on the chat alone, a group running
   * for days is one unbounded history, and an investigation finished on Monday steers an
   * unrelated question on Wednesday. Every mature integration read for this keys on the
   * thread and falls back to the message itself, so a new top-level message starts clean.
   *
   * Absent means "the chat is the conversation", which is right for a direct message and
   * for any platform without threads.
   */
  threadKey?: string;
  /**
   * Which chat the message came from, when that is not the same thing as who sent
   * it — a Feishu group's id, a DingTalk conversation. This is what the agent's
   * conversation thread is keyed on: context belongs to the room it happened in,
   * while permission belongs to the person. Absent means the identity is the chat
   * (a Telegram chat id already is one).
   */
  chatKey?: string;
  /**
   * The wire's own id for this message, when it has one. It is what a reply anchors
   * to and what a status reaction attaches to. One rule downstream: everything a task
   * says is anchored to the message that asked for it — in a main chat that opens a
   * topic, inside a topic it stays there. The *conversation* stays keyed on the chat
   * either way: context belongs to the room, and a reply inside a task's topic must
   * reach the turn that is running, not open a parallel one.
   */
  messageId?: string;
  /** For a person reading the activity feed: a name, not an id, where the wire has one. */
  senderLabel: string;
  text: string;
  /** Files carried by the message, bytes already fetched off the wire by the adapter. */
  files?: { name: string; base64: string }[];
}

/** Where a push should sit: anchored under a message, or loose in the chat. */
export interface PushOptions {
  replyTo?: string;
}

/**
 * A task as a chat renders it: one card per request, updated in place.
 *
 * The states are the ones a person in a group actually distinguishes — waiting,
 * happening, finished, broken — not the turn engine's internals. `action` is the
 * latest one-line answer to "what is it doing right now", which is the whole reason
 * to look at the card while it runs.
 */
export interface TaskCardState {
  /** The instruction, first line, for the card header. */
  title: string;
  /** Who is doing it — the addressed agent, or empty for the default. */
  agentName: string;
  /** Who asked, as the wire names them. */
  requesterLabel: string;
  /**
   * `review` is the one that means the person has to do something.
   *
   * It was missing, and the state rendered as `done` — a task the agent had deliberately
   * left for a human read on the card as finished. A vocabulary that cannot say "your turn"
   * says "nothing left for you to do" instead, which is the opposite.
   */
  status: "queued" | "working" | "review" | "done" | "failed";
  /** The latest one-line action, e.g. `bash: npm test`. Absent when not started or finished. */
  action?: string;
  /** How many requests are ahead of this one, when queued. */
  ahead?: number;
  /** The board id ("t12"), when this request lives on the team board. People say these in chat. */
  taskId?: string;
  /** Where to watch this task in the workshop: the desktop, the evidence, the history. */
  taskUrl?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /** Resolves once the wire is up; rejects when it cannot come up. */
  start(onMessage: (message: InboundMessage) => Promise<string | undefined>): Promise<void>;
  stop(): void;
  /**
   * Reaches the vendor without using the inbound socket, and says why not when it fails.
   *
   * Evidence from outside the component under test. A channel said "connected" once and
   * ninety minutes later had no socket at all, having logged nothing in between — asking
   * the SDK for its state is asking the thing that already failed to notice, so this
   * takes an independent route. Absent on an adapter whose transport cannot fail this
   * way. See liveness.ts.
   */
  probe?(): Promise<string | undefined>;
  /** Pushes a line to where this identity's messages come from, if the wire allows it. */
  send(identity: string, text: string): Promise<void>;
  /**
   * Pushes a line to a chat by its chatKey. Preferred over `send` for task results:
   * `send` routes to wherever the identity last spoke, which may have moved to another
   * chat while a long task ran. Absent means the identity is the chat and `send` is right.
   */
  sendToChat?(chatKey: string, text: string, options?: PushOptions): Promise<void>;
  /**
   * Posts a task card to a chat and returns the handle `updateTaskCard` accepts, or
   * undefined when the card could not be posted. Adapters without cards leave both
   * absent and get plain acknowledgement lines instead. `identity` — who asked — is
   * the address a wire needs when its card system does not speak in chat keys:
   * DingTalk's robot-space cards for a direct session name a person, not a room.
   */
  postTaskCard?(
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions,
    identity?: string
  ): Promise<string | undefined>;
  /** Rewrites a posted card in place. Updates are quiet; a chat is not notified for one. */
  updateTaskCard?(handle: string, card: TaskCardState): Promise<void>;
  /** Posts an image (base64 WebP) to a chat. Absent means the wire cannot show one. */
  sendImage?(chatKey: string, base64: string, options?: PushOptions): Promise<void>;
  /**
   * Marks the message that started a task with its state — working, done, failed —
   * however the wire can say that (Feishu: an emoji reaction). Cheap presence for
   * the quick tasks that never earn a card, and a loud mark when something broke.
   */
  noteStatus?(messageId: string, status: "working" | "done" | "failed"): Promise<void>;
  /** Posts a named file (base64 bytes) to a chat. Absent means the wire cannot carry one. */
  sendFile?(chatKey: string, name: string, base64: string, options?: PushOptions): Promise<void>;
  /**
   * Posts a consent request with buttons to wherever this identity's messages come
   * from. Absent means the wire has no buttons and the text-verb path is used.
   */
  postApprovalCard?(identity: string, card: ApprovalCardState): Promise<void>;
  /** A question with its answers as buttons. A pressed button speaks as a typed reply. */
  postQuestionCard?(identity: string, card: QuestionCardState): Promise<void>;
  /** The board as a card, to a chat. Absent means "看板" answers as plain text. */
  postBoardCard?(chatKey: string, view: BoardView): Promise<void>;
  /**
   * Registers the handler for a pressed approval button. The handler returns the
   * line to show in the chat, or undefined when the press was refused or stale.
   */
  onApprovalAction?(
    handler: (press: {
      approvalId: string;
      reply: ApprovalReply;
      identity: string;
    }) => Promise<string | undefined>
  ): void;
}

/** A pending consent, as a card with buttons renders it. */
export interface QuestionCardState {
  agentName: string;
  question: string;
  /** The answers the agent can act on. Buttons where the wire has them; words always work. */
  options: string[];
}

export interface ApprovalCardState {
  approvalId: string;
  agentName: string;
  /** The original action, verbatim — an approval that paraphrases is an injection surface. */
  description: string;
  /**
   * What is at stake in answering, and in not answering.
   *
   * Ours to say, never the agent's: a request that argued its own case would be the
   * asking party writing the recommendation, which is exactly the surface the verbatim
   * rule above exists to close. So this states only facts the harness knows — the work
   * is stopped until someone answers, and refusing is the reversible direction.
   */
  stakes: string;
}

/** The stakes line every consent request carries. One sentence, always the same shape. */
export { APPROVAL_STAKES } from "./strings.ts";

export interface ChannelStatus {
  name: string;
  configured: boolean;
  running: boolean;
  detail: string;
}

/**
 * A whole message that means "stop what you are doing".
 *
 * The same discipline as approval replies: the message must be *only* the verb. "停下来
 * 改用另一个文件夹" is an instruction that mentions stopping, and reading it as a stop
 * would throw away the half that says what to do instead.
 */
export function parseStopRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~]+$/, "");
  return ["停", "停下", "停下来", "先停", "取消", "算了", "别做了", "stop", "cancel"].includes(t);
}

/**
 * A whole message that means "I accept this work".
 *
 * The walkthrough drew the person saying "好了"; real people say 可以, 收到, 没问题, OK.
 * Whole-message only, like every verb here — "可以再快点吗" is a question that contains
 * an acceptance word, and accepting on it would close work the person was pushing back on.
 */
export function parseAcceptance(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~,,]+$/, "");
  return ["可以", "好了", "好的", "好", "收到", "没问题", "通过", "验收通过", "就这样", "ok", "okay", "lgtm", "辛苦了"].includes(t);
}

/** How a one-word reply on a chat answers a pending approval. */
export type ApprovalReply = "once" | "always" | "session" | "deny";

/**
 * Reads a whole message as an approval answer, or nothing.
 *
 * The message must be *only* the verb — "allow" answers, "allow the download" does not,
 * because the second is a person talking about the request, not deciding it, and a
 * loose match would approve a dangerous action from an offhand sentence.
 */
export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["allow", "approve", "yes", "ok", "y", "允许", "同意", "批准", "好"].includes(t)) return "once";
  if (["allow always", "always", "一直允许", "总是允许"].includes(t)) return "always";
  if (["allow session", "session", "本次会话"].includes(t)) return "session";
  if (["deny", "refuse", "reject", "no", "n", "拒绝", "不"].includes(t)) return "deny";
  return undefined;
}

export interface ChannelManagerDeps {
  /**
   * Whether this identity may command the agents from a channel, read fresh each
   * message so a role change needs no restart. A viewer (or an unknown sender) is
   * refused and told their id; a driver or admin is let through. Permission is a
   * property of the person, which is why this takes an identity and not a chat.
   */
  mayDrive: (identity: string) => boolean;
  /**
   * Current incarnation of a chatKey's channel, by prefix (docs/22 §4). Absent means
   * 1 for everything — true while `ensureChannelRecords` pins every incarnation.
   * `pushToChat` fails closed on any address whose channel has moved past 1.
   */
  incarnationOf?: (chatKey: string) => number;
  /**
   * The door's own default (docs/22 §2): who answers a message that names nobody,
   * per adapter. Absent, or undefined for an adapter, falls through to the
   * installation default the `ask` dependency applies.
   */
  defaultAgentFor?: (adapterName: string) => string | undefined;
  /**
   * Answers a pending approval by id, at a scope. Returns a line to send back, or
   * undefined when the approval is no longer waiting (answered from the web meanwhile,
   * or the turn moved on). The manager only calls this for an approval it pushed to
   * this identity, so authorization is already the mayDrive check that let the pushed
   * turn run.
   */
  answerApproval?: (approvalId: string, reply: ApprovalReply) => string | undefined;
  /**
   * Stops the named agent's running turn at its next round boundary. Returns false when
   * there is nobody to stop. The web stop button's semantics, reachable by saying "停".
   */
  stop?: (agentName: string | undefined) => boolean;
  /**
   * Hands a mid-task message to the running turn as steering, without opening a second
   * task. Fire-and-forget: the bus's own rules make it steering or the next turn,
   * exactly one of the two.
   */
  steer?: (agentName: string | undefined, text: string, identity: string, conversationKey: string) => void;
  /**
   * Runs one turn and returns what the agent said. `agentName` is undefined for the
   * default agent; unknown names should throw with a message worth relaying.
   * `chatKey` names the chat, for the conversation thread the turn runs in.
   * `onProgress`, when given, receives a one-line description of each action the turn
   * takes, for the task card — coarse by design, a card is not a transcript — and
   * the bare tool name behind it, for judgements that want the tool and not its
   * rendering.
   */
  ask: (
    agentName: string | undefined,
    text: string,
    identity: string,
    chatKey: string,
    onProgress?: (action: string, tool?: string) => void,
    /**
     * Which conversation to think in, when it differs from the chat to reply into.
     *
     * The chat is an address, the thread is a subject, and the two are not the same
     * once a room has been running for days.
     */
    threadKey?: string,
    /**
     * The board entry this request opened, when it opened one.
     *
     * Passed rather than looked up afterwards. The alternative — finding the task by its
     * conversation when an answer is recovered after a restart — is an inference where an
     * exact link is already to hand, and it closes the wrong task the moment a
     * conversation has two of them open.
     */
    taskId?: string
  ) => Promise<string>;
  /**
   * How many requests are ahead of a new one for this agent and chat. Zero means it
   * starts now. Absent means unknown, which is treated as zero — the acknowledgement
   * then says less rather than guessing.
   */
  ahead?: (agentName: string | undefined, chatKey: string) => number;
  /**
   * How long a turn may run before the chat is told it is under way. A quick answer
   * should arrive as itself, not behind a "working on it" — the threshold is what
   * separates the two. Queued work skips the wait: queued is known-slow.
   */
  ackAfterMs?: number;
  /**
   * How long a wordless file drop waits for more files (a folder arrives as one
   * message per file) before the agent takes a look at what arrived. Only tests
   * shorten it.
   */
  lookAfterMs?: number;
  /**
   * The agent's desktop right now, as base64 WebP, or undefined when there is no
   * desktop to show. What "屏幕" asks for, and what a finished task that used the
   * desktop attaches — the one thing no other chat product can put in a group.
   */
  screenshot?: (agentName: string | undefined) => Promise<string | undefined>;
  /**
   * Whether this identity may change what the system is — bind scopes, for now.
   * Separate from mayDrive because a driver commands agents inside the rules and an
   * admin changes the rules; conflating them is how a permission model goes soft.
   */
  mayAdmin?: (identity: string) => boolean;
  /**
   * This chat's scope binding: what bounds every task the chat drives. Each returns
   * the line the chat sees. Bind and unbind are admin verbs, checked by the manager.
   */
  chatScope?: {
    show: (chatKey: string) => string;
    bind: (chatKey: string, name: string) => string;
    off: (chatKey: string) => string;
  };
  /**
   * The chat's daily report: what closed, what is in flight, what it cost, what waits
   * on a person. `build` answers "早报" now; `schedule`/`off` manage the standing one.
   * Each returns the line the chat sees.
   */
  digest?: {
    build: (chatKey: string) => string;
    schedule: (chatKey: string, hour: number) => string;
    off: (chatKey: string) => string;
  };
  /**
   * The team board, when channel requests should live on it as tasks.
   *
   * `open` returns the board id shown on the card, so "t12" means the same thing in
   * the chat, the web UI and an agent's prompt. Lifecycle is the card's: opened when
   * accepted, started at the first sign of work, closed with what happened — a
   * failure closes as blocked-with-a-note rather than vanishing, because a board that
   * loses failed work answers "what needs somebody" wrong.
   */
  board?: {
    open: (input: {
      title: string;
      /**
       * The person's whole message, kept on the task. The title gets rewritten into a
       * short name once the work is understood, and the rewrite must never cost the
       * board the words the person actually said.
       */
      description?: string;
      identity: string;
      senderLabel: string;
      agentName?: string;
      chatKey: string;
      /** Which conversation the work happens in, when that is not the chat itself. */
      threadKey?: string;
    }) => string | undefined;
    /** The board's facts for one chat: what "看板" answers. Absent means the verb is inert. */
    show?: (chatKey: string) => BoardView;
    /** What runs by itself: the answer to "定时". Absent means the verb is inert. */
    schedules?: (chatKey: string) => Promise<string>;
    /** Where a person can watch this task work, when this installation is reachable. */
    urlFor?: (taskId: string) => string | undefined;
    started: (taskId: string) => void;
    /**
     * Reports the turn's outcome and returns what the board made of it.
     *
     * A return value rather than `void`, because the card used to be set to Done in
     * parallel with this call rather than from it: the board learned the task was in
     * review and the card, deciding for itself, still said Done.
     */
    closed: (taskId: string, outcome: "done" | "failed", note?: string) => TaskCardState["status"] | undefined;
    /**
     * The requester accepting reviewed work. "done" when it closed; "not_review" when the
     * task was not waiting on them — and then the word was ordinary chat, not a verdict.
     */
    accept?: (taskId: string, identity: string) => "done" | "not_review" | "unknown";
  };
  /**
   * Where each task's chat card lives, durably — see card-ledger.ts. With it, a card
   * outlives the request closure that posted it: an acceptance typed later or a
   * restart-settled task can still flip the card. Absent means cards die with their
   * closure, which is what a test not about this wants.
   */
  cards?: {
    record: (record: CardRecord) => void;
    get: (taskId: string) => CardRecord | undefined;
    close: (taskId: string) => void;
  };
  /**
   * Stores files somebody dropped in the chat, into that chat's inbox on the box.
   * Returns the saved names (as the chat should hear them), or undefined when there
   * is nowhere to store them — which the chat is told plainly.
   */
  receiveFiles?: (
    chatKey: string,
    files: { name: string; base64: string }[]
  ) => Promise<string[] | undefined>;
  /**
   * The files a finished turn left in this chat's outbox — name and bytes, smallest
   * first. Collected once per task, after the reply lands; an empty answer is the
   * ordinary case and costs one directory listing.
   */
  collectOutbox?: (chatKey: string) => Promise<{ name: string; base64: string }[]>;
  /**
   * Reads one file out of the box by absolute path, for a reply that named a deliverable
   * instead of handing it over. Undefined when there is no box to read from.
   */
  readBoxFile?: (path: string) => Promise<{ name: string; base64: string } | undefined>;
  /**
   * Marks collected files delivered — moved to sent/ — after their pushes succeeded.
   * Only what was actually pushed: a file whose push failed stays in the outbox and
   * goes out with the next task rather than vanishing.
   */
  outboxDelivered?: (chatKey: string, names: string[]) => Promise<void>;
  /**
   * Redeems an invite code for this identity and returns the line to send back —
   * "you're in as driver", or why not. Reached *before* the allow check, because the
   * whole point of a code is that the sender is not authorised yet.
   */
  bind?: (code: string, identity: string, senderLabel: string) => string;
  /**
   * Records that somebody unknown knocked, for one-click approval in the app. The
   * refusal then says the owner was told, instead of handing the person an id to
   * copy around — the refusal is the registration page.
   */
  knock?: (request: { identity: string; senderLabel: string; channel: string }) => void;
  log: (line: string) => void;
  /**
   * Where every arrival and its fate is recorded. Absent means no ledger, which is what
   * a test that is not about this wants.
   */
  ingress?: Ingress;
}

/** After this long, a running task without a card says it is under way. */
const ACK_AFTER_MS = 8_000;

/** Card rewrites are rate-limited to this; the final state is always written. */
const CARD_UPDATE_MS = 3_000;

/**
 * Whether a whole message is a request to see the desktop.
 *
 * Whole-message like the approval verbs, and for the same reason: "看看屏幕上的报错"
 * is a person talking about the screen, not asking for a picture of it.
 */
export function parseScreenRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return ["screen", "screenshot", "屏幕", "看屏幕", "看看屏幕", "截图"].includes(t);
}

/** `@Name rest of the message` addresses a specific agent; anything else is the default. */
export function parseAddress(text: string): { agentName?: string; text: string } {
  const match = /^@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u.exec(text.trim());
  if (match === null) return { text: text.trim() };
  return { agentName: match[1], text: match[2]!.trim() };
}

export function refusal(identity: string): string {
  return (
    `Not authorised. This LumenBox only answers people on its allow list.\n` +
    `Your id is: ${identity}\n` +
    `The owner can add it under Settings → Channels, or to channelAllow in ` +
    `~/.agentbox/config.json, and this message is the whole reason the id is shown.`
  );
}

/**
 * The refusal when the owner was just told about the knock: an invitation to wait,
 * not an id to copy around. The id still appears, last, for the manual path.
 */
export function knockRefusal(identity: string): string {
  return (
    `You're not on this LumenBox's list yet. The owner has been notified and can let ` +
    `you in with one click — you'll hear back here once they do. If they gave you an ` +
    `invite code, send it as: bind <code>\n` +
    `(Your id, for the manual path: ${identity})`
  );
}

/** A whole message of the shape `bind <code>` / `绑定 <码>`, or nothing. */
export function parseBind(text: string): string | undefined {
  const match = /^(?:bind|绑定)[\s::]+([a-z0-9-]{4,12})$/i.exec(text.trim());
  return match === null ? undefined : match[1]!.toUpperCase();
}

export type ScopeRequest = { kind: "show" } | { kind: "bind"; name: string } | { kind: "off" };

/** A whole message about this chat's scope: `scope` shows, `scope <name>` binds, `scope off` unbinds. */
export function parseScopeRequest(text: string): ScopeRequest | undefined {
  const t = text.trim();
  if (/^scope$/i.test(t)) return { kind: "show" };
  if (/^scope\s+(?:off|解绑)$/i.test(t)) return { kind: "off" };
  const bind = /^scope\s+([\p{L}\p{N}._-]{1,60})$/iu.exec(t);
  if (bind !== null) return { kind: "bind", name: bind[1]! };
  return undefined;
}

/**
 * A whole message asking to see the board: what is on the plate right now, said in
 * the chat where the tasks were asked for. Whole-message like every verb here — a
 * sentence *about* the board ("看板上加一条") is work, not a command.
 */
export function parseBoardRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return ["看板", "任务", "任务列表", "board", "tasks"].includes(t);
}

/**
 * A whole message asking what runs by itself. Whole-message like every verb here — a
 * sentence *about* automation ("定时任务改成七点") is work for an agent, not a command.
 */
export function parseSchedulesRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return ["定时", "自动化", "定时任务", "schedules", "automations"].includes(t);
}

export type DigestRequest = { kind: "now" } | { kind: "schedule"; hour: number } | { kind: "off" };

/**
 * A whole message asking about the digest: "早报" reads it now, "早报 8点" schedules
 * it, "早报 关" stops it. Whole-message like every other verb here, and for the same
 * reason: a sentence *about* the digest is a task, not a command.
 */
export function parseDigestRequest(text: string): DigestRequest | undefined {
  const t = text.trim().toLowerCase();
  if (["早报", "日报", "digest"].includes(t)) return { kind: "now" };
  if (/^(?:早报|日报|digest)\s*(?:off|关|停止?)$/.test(t)) return { kind: "off" };
  const scheduled = /^(?:早报|日报|digest)\s*(?:at\s*)?(\d{1,2})\s*[点时]?$/.exec(t);
  if (scheduled !== null) {
    const hour = Number(scheduled[1]);
    if (hour >= 0 && hour <= 23) return { kind: "schedule", hour };
  }
  return undefined;
}

export class ChannelManager {
  private readonly adapters: ChannelAdapter[] = [];
  private readonly statuses = new Map<string, ChannelStatus>();
  /** Where each agent's last channel instruction came from, for routing notices back. */
  private readonly lastAsker = new Map<string, { adapter: ChannelAdapter; identity: string }>();
  /**
   * The approval each channel person can answer right now, keyed by their identity.
   *
   * Set when an approval for a turn they drove is pushed to their chat; a one-word
   * reply from that identity answers it. Cleared once answered, so a stray "ok" later
   * does not approve something new.
   */
  private readonly awaitingApproval = new Map<string, { approvalId: string; description: string }>();
  /**
   * Tasks still running behind an already-acknowledged wire. Held so `idle` can wait
   * for them — a shutdown that drops a task mid-push loses a result somebody was told
   * would arrive — and so a test can await the work `handle` deliberately does not.
   */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: ChannelManagerDeps) {}

  register(adapter: ChannelAdapter, configured: boolean, detail: string): void {
    this.statuses.set(adapter.name, { name: adapter.name, configured, running: false, detail });
    if (configured) this.adapters.push(adapter);
  }

  start(): void {
    for (const adapter of this.adapters) this.startAdapter(adapter);
  }

  /**
   * A door added while the process runs — from the settings dialog — opens now,
   * exactly as it would have at boot. Refused when the name is already live,
   * because two adapters on one name would be two writers on one namespace.
   */
  registerAndStart(adapter: ChannelAdapter, detail: string): boolean {
    if (this.adapters.some(existing => existing.name === adapter.name)) return false;
    this.register(adapter, true, detail);
    this.startAdapter(adapter);
    return true;
  }

  private startAdapter(adapter: ChannelAdapter): void {
    // A button in a room is pressable by whoever the room trusts to drive — the
    // same set the text verbs trust — checked at press time, not at render time,
    // because a card outlives the moment it was posted.
    adapter.onApprovalAction?.(async press => {
      if (!this.deps.mayDrive(press.identity)) return undefined;
      const result = this.deps.answerApproval?.(press.approvalId, press.reply);
      // However it was answered, nobody's one-word reply should now hit something else.
      for (const [identity, waiting] of this.awaitingApproval) {
        if (waiting.approvalId === press.approvalId) this.awaitingApproval.delete(identity);
      }
      return (
        result ??
        CONSENT_GONE
      );
    });
    adapter
      .start(message => this.handle(adapter, message))
      .then(() => {
        this.setStatus(adapter.name, { running: true, detail: "connected" });
        this.deps.log(`channel ${adapter.name}: connected`);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.setStatus(adapter.name, { running: false, detail });
        this.deps.log(`channel ${adapter.name}: ${detail}`);
      });
  }

  stop(): void {
    for (const adapter of this.adapters) adapter.stop();
  }

  /**
   * Whether anything is still listening, per adapter that can answer.
   *
   * The ingress ledger says whether a message arrived; nothing said whether anyone was
   * there to receive one, and the two look identical from outside — a channel whose
   * socket had been dead for ninety minutes produced exactly the same records as a quiet
   * afternoon. `lastInboundAt` comes from the ledger rather than from the adapter,
   * because an adapter that has stopped noticing its own traffic is the failure being
   * tested for.
   */
  async health(now = Date.now()): Promise<ChannelHealth[]> {
    const lastByChannel = new Map<string, string>();
    for (const record of this.deps.ingress?.list() ?? []) {
      const seen = lastByChannel.get(record.channel);
      if (seen === undefined || record.at > seen) lastByChannel.set(record.channel, record.at);
    }
    const checks = this.adapters
      .filter(adapter => adapter.probe !== undefined)
      .map(adapter =>
        channelHealth({
          channel: adapter.name,
          lastInboundAt: lastByChannel.get(adapter.name),
          now,
          probe: () => adapter.probe!(),
        })
      );
    return Promise.all(checks);
  }

  /** Resolves when every accepted task has pushed its result (or its failure). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  list(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  /** Remembers who to notify for an agent. Called by `ask` wiring with the agent id. */
  remember(agentId: string, adapterName: string, identity: string): void {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter !== undefined) this.lastAsker.set(agentId, { adapter, identity });
  }

  /**
   * Puts an agent's question to whoever last drove it from a chat.
   *
   * The same routing an approval uses, and for the same reason: the person who asked
   * for the work is the one who can say what they meant. Returns where it went, or
   * nothing when this agent has never been driven from a chat — the caller then tells
   * the agent to decide for itself rather than to wait for an answer nobody will give.
   */
  askQuestion(input: {
    agentId: string;
    agentName: string;
    question: string;
    options?: string[];
  }): string | undefined {
    const asker = this.lastAsker.get(input.agentId);
    if (asker === undefined) return undefined;
    // Their next message is the answer to this, and an answer is a continuation of the
    // work that asked — not new work. Without this, answering opened a fresh task and a
    // fresh card titled with the answer ("附件刚上传完 · 已完成"), which is noise wearing
    // a task's clothes. One-shot: only the immediately next message counts.
    this.awaitingAnswer.add(asker.identity);
    // Buttons where the wire has them: the person answers a choice with one tap, and the
    // press goes through the same door as a typed reply. Words keep working either way.
    if (
      asker.adapter.postQuestionCard !== undefined &&
      input.options !== undefined &&
      input.options.length > 0
    ) {
      void asker.adapter
        .postQuestionCard(asker.identity, {
          agentName: input.agentName,
          question: input.question,
          options: input.options,
        })
        .catch(() => {
          // The web page shows it too; a failed push is not a lost question.
        });
      return asker.identity;
    }
    const choices =
      input.options !== undefined && input.options.length > 0
        ? `

${input.options.map(option => `· ${option}`).join("\n")}`
        : "";
    void asker.adapter
      .send(
        asker.identity,
        questionText(input.agentName, input.question, choices)
      )
      .catch(() => {
        // The web page shows it too; a failed push is not a lost question.
      });
    return asker.identity;
  }

  /**
   * Pushes a pending approval to whoever last drove this agent from a chat, and
   * remembers it so a one-word reply from them answers it. Nothing when the agent was
   * not driven from a channel — the web page covers that.
   */
  notifyApproval(agentId: string, approvalId: string, agentName: string, description: string): void {
    const asker = this.lastAsker.get(agentId);
    if (asker === undefined) return;
    this.awaitingApproval.set(asker.identity, { approvalId, description });
    // Buttons where the wire has them; the word path stays open either way, because a
    // person answering "允许" at a card is right, not wrong.
    if (asker.adapter.postApprovalCard !== undefined) {
      void asker.adapter
        .postApprovalCard(asker.identity, {
          approvalId,
          agentName,
          description,
          stakes: APPROVAL_STAKES,
        })
        .catch(() => {
          // The web UI still shows it; a failed push is not a lost approval.
        });
      return;
    }
    const message = consentFallbackText(agentName, description);
    void asker.adapter.send(asker.identity, message).catch(() => {
      // The web UI still shows it; a failed push is not a lost approval.
    });
  }

  private setStatus(name: string, patch: Partial<ChannelStatus>): void {
    const current = this.statuses.get(name);
    if (current !== undefined) this.statuses.set(name, { ...current, ...patch });
  }

  /**
   * Redraws a task's chat card to a state the board reached outside the request that
   * posted it — an acceptance typed minutes later, work settled after a restart, an
   * audit moving the task on. This is what the durable card ledger exists for: the
   * two ways a card used to lie were "进行中 forever" after a restart and an accepted
   * task whose card never turned green.
   *
   * No-op without a recorded card, when the card already says it, or when the
   * adapter that posted it is not registered here.
   */
  syncTaskCard(taskId: string, status: TaskCardState["status"]): void {
    const entry = this.deps.cards?.get(taskId);
    if (entry === undefined || entry.card.status === status) return;
    const adapter = this.adapters.find(a => a.name === entry.adapter);
    if (adapter?.updateTaskCard === undefined) return;
    const card: TaskCardState = { ...entry.card, status };
    delete card.action;
    delete card.ahead;
    void adapter.updateTaskCard(entry.handle, card).catch((error: unknown) => {
      this.deps.log(
        `channel ${entry.adapter}: card sync failed for ${taskId} — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (status === "done") this.deps.cards?.close(taskId);
    else this.deps.cards?.record({ ...entry, card });
  }

  /** Pushes a line to an identity through a named adapter. The approve-notification path. */
  push(adapterName: string, identity: string, text: string): Promise<void> {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter === undefined) return Promise.resolve();
    // Said out loud. A reply that never reached the person is the failure they actually
    // experience, and swallowing it here made it identical to never having been written.
    return adapter.send(identity, text).catch((error: unknown) => {
      this.deps.log(
        `channel ${adapterName}: could not deliver to ${identity} — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  /**
   * Pushes a line to a chat by its chatKey alone — the scheduled-digest path, where
   * no inbound message chose the adapter. The chatKey's prefix is the adapter's name,
   * which is the naming convention every adapter already follows.
   *
   * The backstop of docs/22 §4's fail-closed rule sits here, at the one door every
   * durable sender leaves through: an **unstamped** chat address (a schedule's
   * `deliver`, a digest key in the config) is a claim from the grandfathered world,
   * valid exactly as long as its channel's incarnation is still 1. The moment a
   * channel is ever replaced, every such claim to it dies as a reported dead letter
   * rather than posting into whoever holds the door now. Stamped records
   * (deliveries, conversations) check their own stamps before they get here; when
   * namespace replacement is actually built, its migration adds the proven-current
   * bypass this signature deliberately does not have yet.
   */
  pushToChat(chatKey: string, text: string): Promise<void> {
    if ((this.deps.incarnationOf?.(chatKey) ?? 1) !== 1) {
      this.deps.log(
        `channel: dead letter for ${chatKey} — its channel was replaced, and an ` +
          `unstamped address cannot prove it means the current tenant. Dropped.`
      );
      return Promise.resolve();
    }
    const adapter = this.adapters.find(a => chatKey.startsWith(`${a.name}:`));
    if (adapter?.sendToChat === undefined) {
      // Not an error to ignore: a digest, a rescue notice or a late answer was addressed
      // to a chat whose channel is no longer configured, and it is going nowhere.
      this.deps.log(`channel: nothing can send to ${chatKey}; message dropped`);
      return Promise.resolve();
    }
    return adapter.sendToChat(chatKey, text).catch((error: unknown) => {
      this.deps.log(
        `channel ${adapter.name}: could not send to ${chatKey} — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  private async handle(
    adapter: ChannelAdapter,
    message: InboundMessage
  ): Promise<string | undefined> {
    // An invite code is checked before the allow list: the sender not being on it yet
    // is the whole reason codes exist. A non-code message from a stranger still knocks.
    const code = parseBind(message.text);
    if (code !== undefined && this.deps.bind !== undefined) {
      return this.deps.bind(code, message.identity, message.senderLabel);
    }

    if (!this.deps.mayDrive(message.identity)) {
      if (message.messageId !== undefined) {
        this.deps.ingress?.decided(message.messageId, "refused", message.identity);
      }
      this.deps.log(
        `channel ${adapter.name}: refused ${message.identity} (${message.senderLabel})`
      );
      if (this.deps.knock !== undefined) {
        this.deps.knock({
          identity: message.identity,
          senderLabel: message.senderLabel,
          channel: adapter.name,
        });
        return knockRefusal(message.identity);
      }
      return refusal(message.identity);
    }

    // Past the door. Recorded here rather than at the end, because everything below can
    // take a long time or throw, and "admitted then something went wrong" is a different
    // report from "never got in".
    if (message.messageId !== undefined) {
      this.deps.ingress?.decided(message.messageId, "admitted");
    }

    // A one-word answer to a consent this person was asked for is a decision, not a
    // new instruction: answer the approval and do not start a turn. Checked before
    // address parsing, so "allow" is never read as a message to an agent named allow.
    const pending = this.awaitingApproval.get(message.identity);
    if (pending !== undefined) {
      const reply = parseApprovalReply(message.text);
      if (reply !== undefined) {
        this.awaitingApproval.delete(message.identity);
        const result = this.deps.answerApproval?.(pending.approvalId, reply);
        return (
          result ??
          "That consent is no longer waiting — it may have been answered from the app, " +
            "or the turn moved on. Send the request again if it still needs doing."
        );
      }
    }

    // The scope verbs change what every task in this chat may do: reading is open,
    // binding is an admin's call.
    const scopeRequest = parseScopeRequest(message.text);
    if (scopeRequest !== undefined && this.deps.chatScope !== undefined) {
      const chatKey = message.chatKey ?? message.identity;
      if (scopeRequest.kind === "show") return this.deps.chatScope.show(chatKey);
      if (this.deps.mayAdmin?.(message.identity) !== true) {
        return SCOPE_IS_ADMIN_CALL;
      }
      return scopeRequest.kind === "bind"
        ? this.deps.chatScope.bind(chatKey, scopeRequest.name)
        : this.deps.chatScope.off(chatKey);
    }

    // "看板" is a look at the board, not work — answered on the wire, and deliberately
    // checked before the running-work routing below: asking what is on the plate while
    // something runs must not be read as steering it. A card where the wire draws one,
    // and the text form both as fallback and everywhere else.
    if (parseBoardRequest(message.text) && this.deps.board?.show !== undefined) {
      const view = this.deps.board.show(message.chatKey ?? message.identity);
      if (adapter.postBoardCard !== undefined) {
        try {
          await adapter.postBoardCard(message.chatKey ?? message.identity, view);
          return undefined;
        } catch (error) {
          this.deps.log(
            `channel ${adapter.name}: board card failed — ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return boardText(view);
    }

    // "定时" is a look at what runs by itself. Like the board, answered on the wire and
    // checked before the running-work routing: asking while something runs is a question,
    // not steering.
    if (parseSchedulesRequest(message.text) && this.deps.board?.schedules !== undefined) {
      return await this.deps.board.schedules(message.chatKey ?? message.identity);
    }

    // The digest verbs are decisions about reporting, not work: answered on the wire.
    const digestRequest = parseDigestRequest(message.text);
    if (digestRequest !== undefined && this.deps.digest !== undefined) {
      const chatKey = message.chatKey ?? message.identity;
      if (digestRequest.kind === "now") return this.deps.digest.build(chatKey);
      if (digestRequest.kind === "schedule")
        return this.deps.digest.schedule(chatKey, digestRequest.hour);
      return this.deps.digest.off(chatKey);
    }

    // A dropped file with nothing said is a delivery; with an instruction in the same
    // message it is work starting. The first version treated every message carrying files
    // as a delivery and ignored its text — the person had just said what they wanted, and
    // was told to say what they wanted. Walkthrough step zero, broken at the first second.
    if (message.files !== undefined && message.files.length > 0) {
      const drop = this.runDrop(adapter, message).finally(() => {
        this.inflight.delete(drop);
      });
      this.inflight.add(drop);
      return undefined;
    }

    const { agentName, text } = parseAddress(message.text);
    if (text === "") return SAY_WHAT_YOU_NEED;

    // The dumb routing rule the product plan chose over the correctness engineering it
    // deferred: one conversation runs one piece of work at a time. While it runs, a plain
    // message is steering, "停" is the stop button, and neither opens a second task or a
    // second card. A message addressed to a *different* agent is new work and passes
    // through — two agents in parallel is the team working, not a routing accident.
    const conversationKey = message.threadKey ?? message.chatKey ?? message.identity;
    const running = this.runningWork.get(conversationKey);
    if (running !== undefined) {
      const sameAgent = agentName === undefined || agentName === running.agentName;
      if (parseStopRequest(text)) {
        const stopped = this.deps.stop?.(running.agentName) ?? false;
        return stopped ? STOPPING : NOTHING_RUNNING;
      }
      if (sameAgent && this.deps.steer !== undefined) {
        this.deps.steer(running.agentName, text, message.identity, conversationKey);
        return steered(running.agentName);
      }
    } else if (parseStopRequest(text)) {
      return NOTHING_RUNNING;
    } else if (parseAcceptance(text)) {
      // "可以" with a task waiting on this person closes it as their word. With nothing
      // waiting, the same word is ordinary chat and falls through to the agent.
      const waiting = this.lastTask.get(conversationKey);
      if (waiting !== undefined && this.deps.board?.accept !== undefined) {
        const verdict = this.deps.board.accept(waiting, message.identity);
        if (verdict === "done") {
          this.lastTask.delete(conversationKey);
          return accepted(waiting);
        }
      }
    }

    // An answer to the question the agent just asked continues that work — no new board
    // row, no new card. Consumed exactly once, so the message after the answer is
    // ordinary again.
    const answering = this.awaitingAnswer.delete(message.identity);

    // The door's own default (docs/22 §2): a message that names nobody goes to this
    // adapter's defaultAgent. Applied here, to *new* work only — the steering and
    // stop decisions above deliberately used the raw address, because a plain
    // message while something runs is a reply to that work, whoever is doing it.
    const addressed = agentName ?? this.deps.defaultAgentFor?.(adapter.name);

    // "屏幕" is a look, not a task: no turn runs, the desktop is captured as it is.
    const work =
      parseScreenRequest(text) && this.deps.screenshot !== undefined
        ? this.runScreenshot(adapter, message, addressed)
        : this.runTask(adapter, message, addressed, text, undefined, { continuation: answering });

    // The work runs behind this return; the decisions above stay synchronous because
    // a refusal or an approval answer *is* the whole response.
    const task = work.finally(() => {
      this.inflight.delete(task);
    });
    this.inflight.add(task);
    return undefined;
  }

  /** A line to the room that asked, or to the sender where the wire has no rooms. */
  private async deliver(
    adapter: ChannelAdapter,
    chatKey: string,
    identity: string,
    line: string,
    options?: PushOptions
  ): Promise<void> {
    try {
      if (adapter.sendToChat !== undefined) await adapter.sendToChat(chatKey, line, options);
      else await adapter.send(identity, line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.log(`channel ${adapter.name}: push failed (${detail})`);
    }
  }

  /**
   * Files dropped without a word, remembered until the next instruction in the same
   * conversation picks them up.
   *
   * On Feishu a file message carries no text at all, so "drag the folder in, then type
   * what you want" is *always* two messages — the ordinary case, not an edge. Without this
   * the turn had to guess that the inbox was worth listing. Consumed once: the message
   * after the one that used them is about something else.
   */
  private readonly pendingDrops = new Map<string, { files: string[]; at: number }>();

  /** What each conversation is running right now, for the one-at-a-time routing rule. */
  private readonly runningWork = new Map<string, { agentName: string | undefined }>();

  /** The conversation's most recent board task — what an acceptance word refers to. */
  private readonly lastTask = new Map<string, string>();

  /** Who owes an answer to an open question. Their next message continues, not begins. */
  private readonly awaitingAnswer = new Set<string>();

  /** How long a wordless drop waits for its instruction. */
  private static readonly DROP_WINDOW_MS = 10 * 60 * 1000;

  /** How long a wordless drop waits for more files before the agent looks at it. */
  private static readonly LOOK_AFTER_MS = 5_000;

  /** The pending look per conversation, reset while a folder is still arriving. */
  private readonly lookTimers = new Map<string, NodeJS.Timeout>();

  /** The files recently dropped in this conversation, handed over exactly once. */
  private takeDrops(conversationKey: string): string[] | undefined {
    const drop = this.pendingDrops.get(conversationKey);
    if (drop === undefined) return undefined;
    this.pendingDrops.delete(conversationKey);
    // An instruction arrived; it is the look now. The timer's own check would also
    // find the drops gone, but a cleared timer is a fact and a raced one is a maybe.
    const timer = this.lookTimers.get(conversationKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.lookTimers.delete(conversationKey);
    }
    if (Date.now() - drop.at > ChannelManager.DROP_WINDOW_MS) return undefined;
    return drop.files;
  }

  /** A message carrying files: store them, then run its instruction if it brought one. */
  private async runDrop(adapter: ChannelAdapter, message: InboundMessage): Promise<void> {
    const saved = await this.storeFiles(adapter, message);
    const { agentName, text } = parseAddress(message.text ?? "");
    const conversationKey = message.threadKey ?? message.chatKey ?? message.identity;
    if (text === "") {
      if (saved !== undefined && saved.length > 0) {
        // Accumulate rather than replace: a folder arrives as one file message per file.
        const already = this.pendingDrops.get(conversationKey);
        this.pendingDrops.set(conversationKey, {
          files: [...(already?.files ?? []), ...saved],
          at: Date.now(),
        });
        await this.deliver(
          adapter,
          message.chatKey ?? message.identity,
          message.identity,
          filesSaved(saved),
          message.messageId !== undefined ? { replyTo: message.messageId } : undefined
        );
        // Look before being told. "收到,说一句要做什么" answered a person who had just
        // handed something over with a form to fill in; the observed complaint was the
        // lack of agency, verbatim. Debounced past the last file of a folder drop, and
        // self-cancelling: an instruction consuming the drops clears the timer, and the
        // timer itself re-checks that the drops are still unclaimed.
        const existing = this.lookTimers.get(conversationKey);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.lookTimers.delete(conversationKey);
          const pending = this.pendingDrops.get(conversationKey);
          if (pending === undefined || pending.files.length === 0) return;
          const look = this.runLook(adapter, message, pending.files).finally(() => {
            this.inflight.delete(look);
          });
          this.inflight.add(look);
        }, this.deps.lookAfterMs ?? ChannelManager.LOOK_AFTER_MS);
        timer.unref?.();
        this.lookTimers.set(conversationKey, timer);
      }
      return;
    }
    // Storing failed and the chat was already told; running the instruction anyway would
    // have the agent working on files that never arrived, which reads as it ignoring them.
    if (saved === undefined) return;
    await this.runTask(adapter, message, agentName, text, saved);
  }

  /** Files into the chat's inbox. Returns where they landed, or undefined when nowhere. */
  private async storeFiles(
    adapter: ChannelAdapter,
    message: InboundMessage
  ): Promise<string[] | undefined> {
    const chatKey = message.chatKey ?? message.identity;
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    if (this.deps.receiveFiles === undefined) return undefined;
    try {
      // The conversation, not the room: the prompt tells the agent its files are under
      // the conversation's directory, and after conversations began following threads the
      // two disagreed — the agent was sent to a path nothing wrote and nothing read, which
      // it noticed and reported. One key for both, and the room stays the delivery address.
      const saved = await this.deps.receiveFiles(
        message.threadKey ?? chatKey,
        message.files ?? []
      );
      if (saved === undefined) {
        await this.deliver(
          adapter,
          chatKey,
          message.identity,
          NO_BOX_FOR_FILES,
          anchor
        );
        return undefined;
      }
      return saved;
    } catch (error) {
      await this.deliver(
        adapter,
        chatKey,
        message.identity,
        error instanceof Error ? error.message : String(error),
        anchor
      );
      return undefined;
    }
  }

  /**
   * A wordless drop, looked at before anyone asks.
   *
   * Deliberately not `runTask`: a look opens no board row, posts no card and does not
   * occupy the conversation's running-work slot — so the instruction that usually
   * follows seconds later still opens a real task (which then queues behind this short
   * turn in the same conversation, rather than being swallowed as steering into it).
   * The look's transcript stays in the conversation, so the task that follows already
   * knows what the files are.
   */
  private async runLook(
    adapter: ChannelAdapter,
    message: InboundMessage,
    files: readonly string[]
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    const named =
      files.slice(0, 20).join(", ") + (files.length > 20 ? ` 等共 ${files.length} 个` : "");
    const prompt =
      `用户刚把这些文件发进聊天,没有附任何说明:${named}\n\n` +
      "先看内容再说话:图片直接用 read_file 看;文本和表格读开头几十行;文件多就挑两三个有代表性的。" +
      "然后回复用户:一句话说你看到了什么,再给一个具体建议或问一个具体问题(你猜测的最可能用途)。" +
      "总共不超过三句话。不要开始任何大工作,不要改动文件。";
    try {
      const reply = await this.deps.ask(
        undefined,
        prompt,
        message.identity,
        chatKey,
        undefined,
        message.threadKey ?? chatKey,
        undefined
      );
      if (reply.trim() !== "") await this.deliver(adapter, chatKey, message.identity, reply, anchor);
    } catch (error) {
      // A failed look must not spam the chat: the receipt already landed, and the
      // person's instruction still works exactly as before.
      this.deps.log(
        `channel ${adapter.name}: look at dropped files failed — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** The desktop, now, into the chat — or the honest reason there is no picture. */
  private async runScreenshot(
    adapter: ChannelAdapter,
    message: InboundMessage,
    agentName: string | undefined
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    try {
      const image = await this.deps.screenshot!(agentName);
      if (image === undefined) {
        await this.deliver(
          adapter,
          chatKey,
          message.identity,
          "No desktop to show — the box may be off, or this agent has not started one.",
          anchor
        );
        return;
      }
      if (adapter.sendImage === undefined) {
        await this.deliver(
          adapter,
          chatKey,
          message.identity,
          "This channel cannot show images; open the app to watch the desktop.",
          anchor
        );
        return;
      }
      await adapter.sendImage(chatKey, image, anchor);
    } catch (error) {
      await this.deliver(
        adapter,
        chatKey,
        message.identity,
        error instanceof Error ? error.message : String(error),
        anchor
      );
    }
  }

  /**
   * One accepted request, from acknowledgement to pushed result.
   *
   * Everything here degrades by capability: a card where the adapter has one, a line
   * where it does not; a chat-addressed push where the wire distinguishes chats from
   * senders, an identity-addressed one where it does not. Failures to *deliver* are
   * logged and swallowed — the turn itself already ran, and its record is the
   * transcript, not the chat.
   */
  private async runTask(
    adapter: ChannelAdapter,
    message: InboundMessage,
    agentName: string | undefined,
    text: string,
    droppedFiles?: readonly string[],
    options?: { continuation?: boolean }
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    const runningKey = message.threadKey ?? chatKey;
    this.runningWork.set(runningKey, { agentName });
    // What this turn should know it was handed: files in this message, plus any dropped
    // wordlessly in this conversation just before. In the prompt and nowhere else — the
    // card and the board carry the person's own words, not a path listing.
    const handedFiles = [
      ...(this.takeDrops(message.threadKey ?? chatKey) ?? []),
      ...(droppedFiles ?? []),
    ];
    // Everything this task says sits under the message that asked for it.
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    const deliver = (line: string) =>
      this.deliver(adapter, chatKey, message.identity, line, anchor);
    const mark = (status: "working" | "done" | "failed") => {
      if (message.messageId === undefined) return;
      void adapter.noteStatus?.(message.messageId, status).catch(() => {});
    };
    mark("working");

    const ahead = this.deps.ahead?.(agentName, chatKey) ?? 0;
    const taskId = options?.continuation === true
      ? undefined
      : this.deps.board?.open({
      title: firstLine(text),
      // The person's whole message rides on the task, so a later title rewrite never
      // costs the board what was actually said.
      description: text,
      identity: message.identity,
      senderLabel: message.senderLabel,
      ...(agentName !== undefined ? { agentName } : {}),
      chatKey,
      // The conversation the turn will actually run in. Without it the board recorded the
      // room while the transcript went to the thread, so every channel task named a
      // conversation that was empty — and an audit, whose whole job is to read a task's
      // evidence, was pointed at the wrong file. Found by adversarial review, not by use:
      // a task with the wrong conversation looks exactly like a task with a quiet one.
      threadKey: message.threadKey ?? chatKey,
    });
    if (taskId !== undefined) this.lastTask.set(runningKey, taskId);
    const card: TaskCardState = {
      title: firstLine(text),
      agentName: agentName ?? "",
      requesterLabel: message.senderLabel,
      status: ahead > 0 ? "queued" : "working",
      ...(ahead > 0 ? { ahead } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskId !== undefined && this.deps.board?.urlFor?.(taskId) !== undefined
        ? { taskUrl: this.deps.board.urlFor(taskId)! }
        : {}),
    };

    // The acknowledgement, when one is owed: a card if the adapter can, a line if not.
    // Queued work is acknowledged immediately — queued is known-slow — while work that
    // starts now gets the threshold, so a quick answer arrives as itself. A card
    // adapter that posts nothing (a direct session nobody is on record for, a chat
    // the wire refuses) falls through to the line: the requester gets one of the two,
    // never silence wearing the costume of a card.
    let cardHandle: string | undefined;
    let acknowledged = false;
    let lastCardWrite = 0;
    const acknowledge = async () => {
      if (acknowledged) return;
      acknowledged = true;
      if (adapter.postTaskCard !== undefined) {
        try {
          cardHandle = await adapter.postTaskCard(chatKey, { ...card }, anchor, message.identity);
          lastCardWrite = Date.now();
          // Durably, so the card outlives this closure: an acceptance typed after a
          // restart still finds the handle to flip.
          if (cardHandle !== undefined && taskId !== undefined) {
            this.deps.cards?.record({
              taskId,
              adapter: adapter.name,
              handle: cardHandle,
              card: { ...card },
            });
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log(`channel ${adapter.name}: card failed (${detail})`);
        }
        if (cardHandle !== undefined) return;
      }
      await deliver(ackLine(card));
    };

    const ackTimer = setTimeout(() => {
      // A continuation answers a question the person just asked; a card titled with
      // their own answer is noise wearing a task's clothes. The typing mark suffices.
      if (options?.continuation !== true) void acknowledge();
    }, this.deps.ackAfterMs ?? ACK_AFTER_MS);
    if (ahead > 0 && options?.continuation !== true) void acknowledge();

    // Progress rewrites the card, rate-limited; without a card it goes nowhere, on
    // purpose — a plain chat told "tool call #14" fourteen times is spam, not progress.
    let boardStarted = false;
    // Whether this turn touched the desktop at all. The final screenshot is a poster
    // of the desk the work left behind; a research or calculation turn that never
    // used the desktop would post the same untouched wallpaper every time, which is
    // noise wearing the costume of evidence.
    let touchedDesktop = false;
    const onProgress = (action: string, tool?: string) => {
      if (tool === "computer") touchedDesktop = true;
      if (!boardStarted && taskId !== undefined) {
        boardStarted = true;
        this.deps.board?.started(taskId);
      }
      card.status = "working";
      delete card.ahead;
      card.action = action;
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      const now = Date.now();
      if (now - lastCardWrite < CARD_UPDATE_MS) return;
      lastCardWrite = now;
      void adapter.updateTaskCard(cardHandle, { ...card }).catch((error: unknown) => {
        // A card that stops updating is the "Working forever" symptom from the other
        // direction, so the reason belongs somewhere findable.
        this.deps.log(
          `channel ${adapter.name}: card update failed — ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      });
    };

    const finishCard = (status: TaskCardState["status"]) => {
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      card.status = status;
      delete card.action;
      delete card.ahead;
      void adapter.updateTaskCard(cardHandle, { ...card }).catch((error: unknown) => {
        // A card that stops updating is the "Working forever" symptom from the other
        // direction, so the reason belongs somewhere findable.
        this.deps.log(
          `channel ${adapter.name}: card update failed — ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      });
      // The ledger mirrors what the card now says, so a later board change that says
      // the same thing is a no-op instead of a second write. Green is final: nothing
      // will rewrite a done card, so its record can go.
      if (taskId !== undefined) {
        if (status === "done") this.deps.cards?.close(taskId);
        else {
          this.deps.cards?.record({
            taskId,
            adapter: adapter.name,
            handle: cardHandle,
            card: { ...card },
          });
        }
      }
    };

    try {
      const reply = await this.deps.ask(
        agentName,
        handedFiles.length > 0
          ? `${text}\n\n[随这条消息收到的文件: ${handedFiles.join(", ")}]`
          : text,
        message.identity,
        chatKey,
        onProgress,
        message.threadKey ?? chatKey,
        taskId
      );
      clearTimeout(ackTimer);
      // Asked first, then shown. The board owns what a finished turn means for the work —
      // it may be review, and saying Done over that is the contradiction t51 produced.
      const settled = taskId !== undefined ? this.deps.board?.closed(taskId, "done") : undefined;
      finishCard(settled === "review" ? "review" : "done");
      // The reaction is about the *message*, which has been answered either way.
      mark("done");
      await deliver(
        reply.trim() === "" ? EMPTY_REPLY_NOTE : reply
      );
      // Whatever the turn left in the chat's outbox follows the reply — images shown
      // as images, everything else as a file. What was pushed is marked delivered;
      // what failed stays in the outbox for the next task rather than vanishing.
      if (this.deps.collectOutbox !== undefined) {
        try {
          const files = await this.deps.collectOutbox(message.threadKey ?? chatKey);
          const delivered: string[] = [];
          for (const file of files) {
            try {
              const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
              if (isImage && adapter.sendImage !== undefined) {
                await adapter.sendImage(chatKey, file.base64, anchor);
              } else if (adapter.sendFile !== undefined) {
                await adapter.sendFile(chatKey, file.name, file.base64, anchor);
              } else {
                await deliver(`(${file.name} is ready on the box; this channel cannot carry files.)`);
                continue;
              }
              delivered.push(file.name);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              this.deps.log(`channel ${adapter.name}: file push failed for ${file.name} (${detail})`);
            }
          }
          if (delivered.length > 0) {
            await this.deps.outboxDelivered?.(message.threadKey ?? chatKey, delivered);
          }

          // A file the reply *names* but never handed over. An agent wrote its research
          // to a path under the work directory and said "the full version is at «path»",
          // which is a real file in the box and an unopenable string to the person
          // reading it in a chat — they had to ask for it again. The outbox convention is
          // in the prompt and was not followed, and whether it was is a path comparison
          // rather than a judgement, so the harness checks rather than asks harder.
          const named = undelivered(boxPathsNamed(reply), delivered);
          for (const path of named.slice(0, 3)) {
            const file = await this.deps.readBoxFile?.(path).catch(() => undefined);
            if (file === undefined) continue;
            try {
              const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
              if (isImage && adapter.sendImage !== undefined) {
                await adapter.sendImage(chatKey, file.base64, anchor);
              } else if (adapter.sendFile !== undefined) {
                await adapter.sendFile(chatKey, file.name, file.base64, anchor);
              } else continue;
              this.deps.log(`channel ${adapter.name}: sent ${file.name}, which the reply only named`);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              this.deps.log(`channel ${adapter.name}: could not send named file ${path} (${detail})`);
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log(`channel ${adapter.name}: outbox failed (${detail})`);
        }
      }
      // The desk as the task left it: evidence at a glance — but only when the turn
      // actually used the desktop (a poster of an untouched desk is noise), only for
      // work long enough to have been acknowledged — a quick answer does not need a
      // poster — and never a failure: the reply already landed, and its record is
      // the transcript.
      if (
        acknowledged &&
        touchedDesktop &&
        adapter.sendImage !== undefined &&
        this.deps.screenshot !== undefined
      ) {
        try {
          const image = await this.deps.screenshot(agentName);
          if (image !== undefined) await adapter.sendImage(chatKey, image, anchor);
        } catch {
          // Nothing: the missing poster is not worth a line in the chat.
        }
      }
    } catch (error) {
      clearTimeout(ackTimer);
      finishCard("failed");
      mark("failed");
      const detail = error instanceof Error ? error.message : String(error);
      if (taskId !== undefined) this.deps.board?.closed(taskId, "failed", detail);
      await deliver(detail);
    } finally {
      // Only if it is still this task's entry: a same-conversation task that somehow
      // started after us must not have its flag wiped by our exit.
      if (this.runningWork.get(runningKey)?.agentName === agentName) {
        this.runningWork.delete(runningKey);
      }
    }
  }
}

/** The instruction as a card header: its first line, clamped. */
/**
 * A card's title, from the message it came from.
 *
 * The first line alone is not enough. People write a short heading and put the substance
 * underneath — "最近 24小时" over a figure, "Update" over a paragraph — and two such
 * messages produce two identically-named rows on a board nobody can then read. So a short
 * opening line borrows from the next one until there is enough to tell it apart.
 */
function firstLine(text: string): string {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  let title = lines[0] ?? "";
  // Short enough that it cannot stand alone. "weekly report" can; "最近 24小时" over a
  // figure cannot, and two of those make two identical rows on a board.
  for (let index = 1; index < lines.length && title.length < 12; index++) {
    title = `${title} · ${lines[index]}`;
  }
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

/** The plain-text acknowledgement, for adapters without cards. */
function ackLine(card: TaskCardState): string {
  const who = card.agentName === "" ? TEAM : card.agentName;
  if (card.status === "queued" && card.ahead !== undefined) return ackQueued(who, card.ahead);
  return ackWorking(who);
}
