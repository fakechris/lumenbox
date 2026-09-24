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

import { roomDecision } from "./identity.ts";
import type { Ingress } from "./ingress.ts";
import type { Messages } from "./messages.ts";
import { randomUUID } from "node:crypto";
import { channelHealth, type ChannelHealth } from "./liveness.ts";
import { boxPathsNamed, undelivered } from "../host/named-files.ts";
import { boardText, type BoardView } from "./board-view.ts";
import { parseContinuation } from "./continuation.ts";
import { isContextCommand } from "../host/context-recovery.ts";
import type { CardRecord } from "./card-ledger.ts";

import {
  APPROVAL_STAKES,
  CONSENT_GONE,
  EMPTY_REPLY_NOTE,
  NO_BOX_FOR_FILES,
  NO_UPGRADE_WAITING,
  SAY_WHAT_YOU_NEED,
  SCOPE_IS_ADMIN_CALL,
  UPGRADE_IS_ADMIN_CALL,
  TEAM,
  NOTHING_RUNNING,
  STOPPING,
  ackQueued,
  ackWorking,
  consentFallbackText,
  accepted,
  filesSaved,
  guestsClosed,
  notYours,
  questionTerms,
  questionText,
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
  /** An explicit answer button; validated against its owner and conversation. */
  questionId?: string;
  /**
   * Which chat the message came from, when that is not the same thing as who sent
   * it — a Feishu group's id, a DingTalk conversation. This is what the agent's
   * conversation thread is keyed on: context belongs to the room it happened in,
   * while permission belongs to the person. Absent means the identity is the chat
   * (a Telegram chat id already is one).
   */
  chatKey?: string;
  /**
   * The room's own name, when the adapter knows it — what a door's room rules match on
   * (INV-429). Absent is normal for a direct message and for platforms that do not say.
   */
  chatName?: string;
  /**
   * The wire's own id for this message, when it has one. It is what a reply anchors
   * to and what a status reaction attaches to. One rule downstream: everything a task
   * says is anchored to the message that asked for it — in a main chat that opens a
   * topic, inside a topic it stays there. The *conversation* stays keyed on the chat
   * either way: context belongs to the room, and a reply inside a task's topic must
   * reach the turn that is running, not open a parallel one.
   */
  messageId?: string;
  /**
   * Ours, minted where the message was admitted and written to `messages.jsonl` at the
   * same moment (INV-613). Handed down with the message so the inbox and the transcript
   * carry the same id, and absent until the door has said yes.
   */
  id?: string;
  /** For a person reading the activity feed: a name, not an id, where the wire has one. */
  senderLabel: string;
  text: string;
  /** Files carried by the message, bytes already fetched off the wire by the adapter. */
  files?: { name: string; base64: string }[];
  /**
   * Whether the message was for the bot: a direct message, a mention, or a reply to
   * something it said. `false` is a group message that names nobody. Absent means the
   * adapter cannot tell, which is read as addressed — the old behaviour, fail-open on
   * purpose: a bot that stays silent when spoken to is the worse failure.
   */
  addressed?: boolean;
  /** Positive evidence from the wire, never inferred from being addressed or authorised. */
  privateChat?: boolean;
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
  /**
   * The reply so far, tail-capped, while the turn is still writing it. The card is the
   * one thing on the wire that can be rewritten in place, so it is where a long answer
   * streams; the finished reply still arrives as a message of its own. Cleared when the
   * card settles, so the card does not repeat the message under it.
   */
  text?: string;
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
  /**
   * Asks the vendor what this door missed and replays it. Present where a wire can be
   * silently half-open — a socket that reports itself ready while the vendor delivers
   * to a registration that no longer exists. Called on reconnect by the adapter and on
   * a timer by the host, because the failure that needs it most is the one where no
   * reconnect ever happens: nothing arrives, nothing errors, and the ledger records a
   * quiet afternoon.
   */
  catchUp?(): Promise<void>;
  /**
   * The inbound socket as the adapter last saw it, in words — "socket ready for 40m",
   * "socket lost 7m ago; reconnecting". Shown instead of a "connected" that was set once
   * at start and never revised (2026-09-13: eighteen hours of "connected" over a dead
   * socket). Absent on an adapter without a long-lived socket.
   */
  socketStatus?(): string | undefined;
  /** Closes the inbound socket and builds a new one, saying why. The liveness check's lever. */
  reconnect?(reason: string): void;
  /**
   * Pushes a line to where this identity's messages come from, if the wire allows it.
   *
   * Answers with the conversation key a reply to *this* push will arrive under, where the
   * wire can say — which is what lets the caller record the notice as something the agent
   * has already said in that conversation. Undefined where it cannot: the push still
   * happened, and the caller keeps nothing rather than keeping it against a guess.
   */
  send(identity: string, text: string): Promise<string | undefined>;
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
  postApprovalCard?(identity: string, card: ApprovalCardState, chatKey?: string): Promise<void>;
  /**
   * A question with its answers as buttons. A pressed button speaks as a typed reply.
   * `chatKey`, when given, is the conversation that asked — thread part included — so
   * the card lands inside the topic the work lives in, not loose at the bottom of the
   * room where nobody can tell which task is asking.
   */
  postQuestionCard?(identity: string, card: QuestionCardState, chatKey?: string): Promise<void>;
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
  questionId?: string;
  agentName: string;
  question: string;
  /** Buttons carry questionId; typed answers must name it with /answer. */
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
  return ["停", "停下", "停下来", "先停", "取消", "算了", "别做了", "stop", "cancel", "/stop"].includes(t);
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
  newContext?: (input: { agentName: string | undefined; identity: string; conversationKey: string; operationId: string; privateChat: boolean; blockers: string[]; mode: "normal" | "clean" }) => string;
  contextMode?: (input: { agentName: string | undefined; conversationKey: string }) => "normal" | "clean" | undefined;
  /**
   * Told of every admitted message from a person, for routines that listen for a phrase. Fired
   * beside the ordinary handling, never instead of it; the callee decides what, if anything, runs.
   */
  listeners?: (message: {
    text: string;
    chatKey: string;
    threadKey?: string;
    messageId?: string;
    senderLabel: string;
  }) => void;
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
  /** The door's group-message rule (identity.ts `groupMessages`). Absent means `all`. */
  groupMessagesFor?: (adapterName: string) => "all" | "addressed" | undefined;
  /** The door's room rules and guest switch (INV-429), by adapter name. */
  roomRulesFor?: (adapterName: string) => { allow: string[]; deny: string[] } | undefined;
  guestFor?: (adapterName: string) => "on" | "off" | undefined;
  /**
   * Keeps a message the room said around the agent without addressing it, for the
   * agent that would have answered it, in the conversation it would have run in.
   */
  heard?: (input: {
    agentName: string | undefined;
    conversation: string;
    senderLabel: string;
    text: string;
    messageId?: string;
    /** Said by this installation as the agent — a push, not a person in the room. */
    mine?: boolean;
  }) => void;
  /**
   * The roster, for 「团队」— what this door shows is what it routes (docs/22 §2:
   * the box's agents, the door's default marked). One list, both uses.
   */
  roster?: (adapterName: string) => string;
  /**
   * The live desktop as a link, for 「桌面」. Takes the addressed agent (or the
   * door's default) and the door it was asked through — a feishu door's link
   * routes through that door's own sign-in, so the person lands authenticated.
   * Answers with a URL or with what to configure first; a reply, never silence.
   */
  desktopUrl?: (agentName: string | undefined, adapterName: string) => string;
  /**
   * The join instructions for 「入会 <会议号>」, per door. Undefined when this
   * wire has no join story — the raw text then goes to the agent as ordinary
   * work, which is honest: it will say it does not know how.
   */
  meetingJoinPrompt?: (meetingNo: string, adapterName: string) => string | undefined;
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
  /**
   * Stops a running turn for whoever asked. Takes the identity, because stopping another
   * box's worker is entering that box (INV-538): the role gate above answers "may this
   * person drive anything", and only the host can answer "may they drive *this*".
   */
  stop?: (agentName: string | undefined, identity: string) => "stopped" | "not-running" | "refused";
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
    taskId?: string,
    /**
     * The model's opening line, said beside its first tool calls, to hand to the chat at
     * once (docs/31 layer 1a). Called at most once per turn, before the reply.
     */
    onInterim?: (text: string) => void,
    /** The reply as it is being written — everything so far, each time it grows. */
    onText?: (soFar: string) => void,
    /** The message's own id, when this ask is one message becoming a turn (INV-613). */
    origin?: { messageId: string; questionId?: string }
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
   * The upgrade this box has asked a person about, and the answer coming back.
   *
   * Absent on a door with no box behind it. `waiting` is what makes the verb a decision
   * on a specific question rather than a bare word that destroys things: with nothing
   * pending, "upgrade" is somebody talking about upgrading.
   */
  upgrade?: {
    /** The image waiting on a decision, or undefined when nothing is. */
    waiting: () => string | undefined;
    /** Records this person's approval of the waiting image. Returns the line the chat sees. */
    approve: (identity: string) => string;
  };
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
  /**
   * Every admitted message, as sent, kept for good (messages.ts). Written here, at the
   * door, because this is the one place that has the channel's id, the text before any
   * clamp, the sender and the files all at once.
   */
  messages?: Messages;
}

/** After this long, a running task without a card says it is under way. */
const ACK_AFTER_MS = 8_000;

/** Card rewrites are rate-limited to this; the final state is always written. */
const CARD_UPDATE_MS = 3_000;
/** A question older than this is treated as walked away from, not as awaiting this reply. */
const QUESTION_STALE_MS = 30 * 60_000;
/**
 * How often the streaming reply may rewrite the card, and how much of it the card holds.
 * 700 ms, or sooner at a line break, is where a card reads as typing rather than as
 * flicker or as stalled (Memoh's Feishu adapter settled on the same numbers); the tail
 * cap keeps a long answer inside what a card may carry.
 */
const STREAM_UPDATE_MS = 700;
const STREAM_TAIL_CHARS = 4_000;

/**
 * Whether a whole message is a request to see the desktop.
 *
 * Whole-message like the approval verbs, and for the same reason: "看看屏幕上的报错"
 * is a person talking about the screen, not asking for a picture of it.
 */
export function parseScreenRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return ["screen", "screenshot", "屏幕", "看屏幕", "看看屏幕", "截图", "/screen"].includes(t);
}

/**
 * 「团队」is a look at who works here — answered on the wire like the board, and for
 * the same reason: asking who is available while something runs must not steer it.
 * Whole-message, because "让团队看看这个" is work for the team, not a roster request.
 */
export function parseRosterRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return ["team", "roster", "团队", "成员", "谁在", "/team", "/roster"].includes(t);
}

/**
 * 「入会 123456789」 asks the agent to join a meeting by number — the trigger
 * that does not depend on the vendor's invite machinery (R37: with the VC
 * event subscribed, an *invitation* to the bot can be treated as an official
 * agent-invite and refused server-side, taking the meeting down with it; a
 * chat message cannot be). Returns the meeting number, or undefined.
 */
export function parseMeetingJoinRequest(text: string): string | undefined {
  const match = /^(?:\/join|入会|加入会议)\s*(\d{9})$/.exec(text.trim());
  return match?.[1];
}

/**
 * 「桌面」asks for the live screen, as a link — where 「屏幕」 asks for a still.
 * Whole-message like both of its siblings: "帮我看下桌面上的报错" is work.
 */
export function parseDesktopRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return ["desktop", "vnc", "桌面", "开桌面", "看桌面", "/desktop", "/vnc"].includes(t);
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
 * A whole message approving the upgrade the box has asked about.
 *
 * Whole-message like every verb here, and for a sharper reason than most: this one
 * authorises destroying a box, so "upgrade the deploy script" must never be read as
 * consent. The English word is the one the notice itself prints (`UPGRADE_WORD`), and a
 * test holds the two together.
 */
export function parseUpgradeApproval(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return ["upgrade", "/upgrade", "升级", "确认升级", "同意升级"].includes(t);
}

/**
 * A whole message asking to see the board: what is on the plate right now, said in
 * the chat where the tasks were asked for. Whole-message like every verb here — a
 * sentence *about* the board ("看板上加一条") is work, not a command.
 */
export function parseBoardRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return ["看板", "任务", "任务列表", "board", "tasks", "/board", "/tasks"].includes(t);
}

/**
 * A whole message asking what runs by itself. Whole-message like every verb here — a
 * sentence *about* automation ("定时任务改成七点") is work for an agent, not a command.
 */
export function parseSchedulesRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return ["定时", "自动化", "定时任务", "schedules", "automations", "/schedules", "/auto"].includes(t);
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
  /**
   * Where each agent's last channel instruction came from, for routing notices back.
   * `chatKey` carries the thread when the instruction arrived in one, so a question or
   * an approval goes back into the topic that asked — a bare "Bob 有个问题要先问你" at
   * the bottom of the room left the person guessing which of three tasks was asking.
   */
  private readonly lastAsker = new Map<
    string,
    { adapter: ChannelAdapter; identity: string; chatKey?: string }
  >();
  private readonly questionAskers = new Map<string, { adapter: ChannelAdapter; identity: string; chatKey?: string }>();
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

  /**
   * Every door that can, asks the vendor what it missed. Failures are logged and
   * swallowed: a sweep is a repair attempt, and a repair that throws must not stop the
   * next one from running.
   */
  async sweep(): Promise<void> {
    await Promise.all(
      this.adapters
        .filter(adapter => adapter.catchUp !== undefined)
        .map(adapter =>
          adapter.catchUp!().catch((error: unknown) => {
            this.deps.log(
              `channel ${adapter.name}: catch-up sweep failed — ` +
                `${error instanceof Error ? error.message : String(error)}`
            );
          })
        )
    );
  }

  /** Resolves when every accepted task has pushed its result (or its failure). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  list(): ChannelStatus[] {
    return [...this.statuses.values()].map(status => {
      const adapter = this.adapters.find(candidate => candidate.name === status.name);
      const socket = status.running ? adapter?.socketStatus?.() : undefined;
      return socket === undefined ? status : { ...status, detail: socket };
    });
  }

  /** Rebuilds one door's socket, when the door can. False when it cannot or is unknown. */
  reconnect(name: string, reason: string): boolean {
    const adapter = this.adapters.find(candidate => candidate.name === name);
    if (adapter?.reconnect === undefined) return false;
    adapter.reconnect(reason);
    return true;
  }

  /** Remembers who to notify for an agent — and, when known, the thread they spoke in. */
  remember(agentId: string, adapterName: string, identity: string, chatKey?: string, context?: { conversation: string; principalId: string }): void {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter !== undefined) {
      this.lastAsker.set(agentId, {
        adapter,
        identity,
        ...(chatKey !== undefined ? { chatKey } : {}),
      });
      if (context !== undefined) this.questionAskers.set(JSON.stringify([agentId, context.conversation, context.principalId]), this.lastAsker.get(agentId)!);
    }
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
    questionId?: string;
    conversation?: string;
    principalId?: string;
    agentId: string;
    agentName: string;
    question: string;
    options?: string[];
    /** What the agent does with no answer, and by when — said on the card (INV-533). */
    fallback?: string;
    expiresAt?: number;
  }): string | undefined {
    const asker = input.conversation !== undefined
      ? this.questionAskers.get(JSON.stringify([input.agentId, input.conversation, input.principalId]))
      : this.lastAsker.get(input.agentId);
    if (asker === undefined) return undefined;
    const questionId = input.questionId ?? randomUUID();
    const conversationKey = asker.chatKey ?? asker.identity;
    for (const [id, pending] of this.awaitingAnswer) {
      if (pending.expiresAt <= Date.now() || (pending.agentId === input.agentId && pending.conversationKey === conversationKey)) this.awaitingAnswer.delete(id);
    }
    this.awaitingAnswer.set(questionId, {
      agentId: input.agentId, agentName: input.agentName, identity: asker.identity,
      adapterName: asker.adapter.name, conversationKey, question: input.question,
      expiresAt: input.expiresAt ?? Date.now() + QUESTION_STALE_MS,
    });
    // What happens if they say nothing, on the card rather than in a design document
    // (INV-533): a default nobody was told about is not a default they agreed to, and
    // "answer by when" is the part that makes a question answerable at all.
    const terms = questionTerms(input.fallback, input.expiresAt);
    // Buttons where the wire has them: the person answers a choice with one tap, and the
    // press goes through the same door as a typed reply. Words keep working either way.
    if (
      asker.adapter.postQuestionCard !== undefined &&
      input.options !== undefined &&
      input.options.length > 0
    ) {
      void asker.adapter
        .postQuestionCard(
          asker.identity,
          {
            questionId,
            agentName: input.agentName,
            question: `${input.question}${terms}`,
            options: input.options,
          },
          asker.chatKey
        )
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
    const text = questionText(input.agentName, `${input.question}${terms}`, choices) + `\n\n回复：/answer ${questionId} 你的答案`;
    // Into the thread that asked, where the adapter can address one: a question with
    // no surrounding context is a question about everything at once.
    const push =
      asker.chatKey !== undefined && asker.adapter.sendToChat !== undefined
        ? asker.adapter.sendToChat(asker.chatKey, text)
        : asker.adapter.send(asker.identity, text);
    void push.catch(() => {
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
        .postApprovalCard(
          asker.identity,
          {
            approvalId,
            agentName,
            description,
            stakes: APPROVAL_STAKES,
          },
          asker.chatKey
        )
        .catch(() => {
          // The web UI still shows it; a failed push is not a lost approval.
        });
      return;
    }
    const message = consentFallbackText(agentName, description);
    // Same thread-first routing as a question, for the same reason.
    const push =
      asker.chatKey !== undefined && asker.adapter.sendToChat !== undefined
        ? asker.adapter.sendToChat(asker.chatKey, message)
        : asker.adapter.send(asker.identity, message);
    void push.catch(() => {
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
  async push(adapterName: string, identity: string, text: string): Promise<void> {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter === undefined) return;
    let conversation: string | undefined;
    try {
      conversation = await adapter.send(identity, text);
    } catch (error: unknown) {
      // Said out loud. A reply that never reached the person is the failure they actually
      // experience, and swallowing it here made it identical to never having been written.
      this.deps.log(
        `channel ${adapterName}: could not deliver to ${identity} — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    // This door is the one place the installation speaks *as* an agent without the agent
    // running: an upgrade question, an approval nudge. Nothing recorded it, so the words
    // existed on the person's screen and nowhere else, and the reply — "can you backup
    // these files" — arrived into a conversation whose whole history was that one line
    // (2026-09-15). Kept as context rather than as a turn, and marked as ours, because a
    // transcript entry would put an assistant message at the head of a fresh conversation
    // and the wire refuses a request that does not open with the person.
    if (conversation === undefined) return;
    const agentName = this.deps.defaultAgentFor?.(adapterName);
    this.deps.heard?.({
      agentName,
      conversation,
      senderLabel: agentName ?? adapterName,
      text,
      mine: true,
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
  /**
   * A question with buttons into a chat, by address — for a task that landed on blocked
   * with answers to choose from. Falls back to the text form where the wire has no cards.
   * A pressed button speaks as a message in that chat, which is how the answer reaches
   * whoever picks the task back up.
   */
  pushQuestionToChat(chatKey: string, card: QuestionCardState): Promise<void> {
    if ((this.deps.incarnationOf?.(chatKey) ?? 1) !== 1) {
      this.deps.log(`channel: dead letter for ${chatKey} — its channel was replaced. Dropped.`);
      return Promise.resolve();
    }
    const adapter = this.adapters.find(a => chatKey.startsWith(`${a.name}:`));
    if (adapter?.postQuestionCard !== undefined) {
      return adapter.postQuestionCard("", card, chatKey);
    }
    const text = questionText(
      card.agentName,
      card.question,
      `\n\n${card.options.map(option => `· ${option}`).join("\n")}`
    );
    return this.pushToChat(chatKey, text);
  }

  pushToChat(chatKey: string, text: string): Promise<void> {
    return this.tryPushToChat(chatKey, text).then(() => undefined);
  }

  /**
   * The same push, with the answer to "did anybody get it" (INV-530).
   *
   * `pushToChat` resolves whatever happens — a replaced channel, an unconfigured
   * adapter, a vendor error are all logged and swallowed, because a digest that cannot
   * be delivered must not take the process down with it. But a caller that *counts*
   * deliveries needs the difference: two ageing nudges that went nowhere used to archive
   * the work as unanswered. Undelivered is not silence.
   */
  tryPushToChat(chatKey: string, text: string): Promise<{ delivered: boolean; why?: string }> {
    if ((this.deps.incarnationOf?.(chatKey) ?? 1) !== 1) {
      const why = `dead letter for ${chatKey} — its channel was replaced, and an unstamped address cannot prove it means the current tenant. Dropped.`;
      this.deps.log(`channel: ${why}`);
      return Promise.resolve({ delivered: false, why });
    }
    const adapter = this.adapters.find(a => chatKey.startsWith(`${a.name}:`));
    if (adapter?.sendToChat === undefined) {
      // Not an error to ignore: a digest, a rescue notice or a late answer was addressed
      // to a chat whose channel is no longer configured, and it is going nowhere.
      const why = `nothing can send to ${chatKey}; message dropped`;
      this.deps.log(`channel: ${why}`);
      return Promise.resolve({ delivered: false, why });
    }
    return adapter
      .sendToChat(chatKey, text)
      .then(() =>
        // The same file duty the reply door has. A scheduled report that says "the
        // long version is at «path»" into a chat that cannot open box paths was the
        // measured failure (2026-09-01): this door pushed words and never files.
        this.deliverFiles(adapter, chatKey, chatKey, text, undefined, line =>
          adapter.sendToChat === undefined ? Promise.resolve() : adapter.sendToChat(chatKey, line)
        )
      )
      .then(() => ({ delivered: true }))
      .catch((error: unknown) => {
        const why = `could not send to ${chatKey} — ${error instanceof Error ? error.message : String(error)}`;
        this.deps.log(`channel ${adapter.name}: ${why}`);
        return { delivered: false, why };
      });
  }

  /**
   * The files a delivered text owes its chat: whatever sits in the chat's outbox,
   * then anything the text names under the work directory but never handed over.
   * One implementation for both delivery doors — the inbound-reply path and the
   * scheduled/console push — because when only the first door carried files, a
   * scheduled weekly report named its long version by box path into a chat that
   * could not open it, and the person had to ask again.
   */
  private async deliverFiles(
    adapter: ChannelAdapter,
    chatKey: string,
    outboxKey: string,
    text: string,
    anchor: PushOptions | undefined,
    sayInChat: (line: string) => Promise<void>
  ): Promise<void> {
    if (this.deps.collectOutbox === undefined) return;
    const failed: string[] = [];
    try {
      const files = await this.deps.collectOutbox(outboxKey);
      const delivered: string[] = [];
      for (const file of files) {
        try {
          const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
          if (isImage && adapter.sendImage !== undefined) {
            await adapter.sendImage(chatKey, file.base64, anchor);
          } else if (adapter.sendFile !== undefined) {
            await adapter.sendFile(chatKey, file.name, file.base64, anchor);
          } else {
            await sayInChat(`(${file.name} is ready on the box; this channel cannot carry files.)`);
            failed.push(file.name);
            continue;
          }
          delivered.push(file.name);
        } catch (error) {
          failed.push(file.name);
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log(`channel ${adapter.name}: file push failed for ${file.name} (${detail})`);
        }
      }
      if (delivered.length > 0) {
        await this.deps.outboxDelivered?.(outboxKey, delivered);
      }

      // A file the text *names* but never handed over. An agent wrote its research
      // to a path under the work directory and said "the full version is at «path»",
      // which is a real file in the box and an unopenable string to the person
      // reading it in a chat — they had to ask for it again. The outbox convention is
      // in the prompt and was not followed, and whether it was is a path comparison
      // rather than a judgement, so the harness checks rather than asks harder.
      // Never retry an ambiguous failed send via the named-path fallback in this turn.
      const named = undelivered(boxPathsNamed(text), files.map(file => file.name));
      for (const path of named.slice(0, 3)) {
        const file = await this.deps.readBoxFile?.(path).catch(() => undefined);
        if (file === undefined) {
          failed.push(path);
          // Said out loud: the silent skip here is why a missing named file used to
          // be indistinguishable from the mechanism not running at all.
          this.deps.log(`channel ${adapter.name}: named file ${path} could not be read; not sent`);
          continue;
        }
        try {
          const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
          if (isImage && adapter.sendImage !== undefined) {
            await adapter.sendImage(chatKey, file.base64, anchor);
          } else if (adapter.sendFile !== undefined) {
            await adapter.sendFile(chatKey, file.name, file.base64, anchor);
          } else {
            failed.push(file.name);
            continue;
          }
          this.deps.log(`channel ${adapter.name}: sent ${file.name}, which the reply only named`);
        } catch (error) {
          failed.push(file.name);
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log(`channel ${adapter.name}: could not send named file ${path} (${detail})`);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.log(`channel ${adapter.name}: outbox failed (${detail})`);
      throw new Error("附件投递未确认；文件保留在 box，请检查后再补发。", { cause: error });
    }
    if (failed.length > 0) throw new Error(`${failed.length} 个附件未确认投递，不能标记交付完成；请检查后再补发。`);
  }

  private async handle(
    adapter: ChannelAdapter,
    message: InboundMessage
  ): Promise<string | undefined> {
    // Button labels are data, not commands such as "停" or "桌面".
    if (message.questionId !== undefined) message = { ...message, text: `/answer ${message.questionId} ${message.text}` };
    // An invite code is checked before the allow list: the sender not being on it yet
    // is the whole reason codes exist. A non-code message from a stranger still knocks.
    const code = parseBind(message.text);
    if (code !== undefined && this.deps.bind !== undefined) {
      // A fate, or the catch-up sweep re-offers the code every ten minutes for two hours.
      if (message.messageId !== undefined) this.deps.ingress?.decided(message.messageId, "admitted");
      return this.deps.bind(code, message.identity, message.senderLabel);
    }

    // Which rooms this door answers in (INV-429). Before identity, before the knock:
    // a room the operator kept out is not a place to explain oneself in.
    const room = roomDecision(this.deps.roomRulesFor?.(adapter.name), message.chatName);
    if (room !== "answer" && message.chatKey !== undefined) {
      if (message.messageId !== undefined) this.deps.ingress?.decided(message.messageId, "refused", message.identity);
      this.deps.log(
        room === "refuse"
          ? `channel ${adapter.name}: not answering in ${message.chatName ?? message.chatKey} — the door's room rules exclude it`
          : `channel ${adapter.name}: ${message.chatKey} has an allowlist and no readable name; staying out of it`
      );
      return undefined;
    }

    if (!this.deps.mayDrive(message.identity)) {
      if (message.messageId !== undefined) {
        this.deps.ingress?.decided(message.messageId, "refused", message.identity);
      }
      this.deps.log(
        `channel ${adapter.name}: refused ${message.identity} (${message.senderLabel})`
      );
      // A door with guests turned off does not collect knocks: in a room of strangers every
      // knock is noise for whoever would have to triage it (INV-429).
      if (this.deps.guestFor?.(adapter.name) === "off") {
        this.deps.log(`channel ${adapter.name}: ${message.identity} is unknown and this door takes no guests`);
        return guestsClosed();
      }
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
    // The record, and the id everything downstream will carry. Minted here rather than
    // in the bus so that the line in messages.jsonl and the id in the inbox are one id;
    // written now, whole, because the inbox clamps its copy and the transcript joins
    // several messages into one prompt.
    message.id = randomUUID();
    this.deps.messages?.admitted({
      id: message.id,
      channel: adapter.name,
      ...(message.messageId !== undefined ? { channelMessageId: message.messageId } : {}),
      chatKey: message.chatKey ?? message.identity,
      ...(message.threadKey !== undefined ? { threadKey: message.threadKey } : {}),
      identity: message.identity,
      senderLabel: message.senderLabel,
      conversationKey: message.threadKey ?? message.chatKey ?? message.identity,
      receivedAt: new Date().toISOString(),
      text: message.text,
      ...(message.files !== undefined && message.files.length > 0
        ? { files: message.files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.base64, "base64") })) }
        : {}),
    });
    if (!isContextCommand(parseAddress(message.text).text)) this.deps.listeners?.({
      text: message.text,
      chatKey: message.chatKey ?? message.identity,
      ...(message.threadKey !== undefined ? { threadKey: message.threadKey } : {}),
      ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
      senderLabel: message.senderLabel,
    });

    // A group message that names nobody, on a door that only answers when addressed:
    // heard, not run. After the listeners (a routine may still be watching the room)
    // and before every verb below, because a verb said to the room is not said to us.
    if (
      message.addressed === false &&
      this.deps.groupMessagesFor?.(adapter.name) === "addressed"
    ) {
      const chatKey = message.chatKey ?? message.identity;
      this.deps.heard?.({
        agentName: this.deps.defaultAgentFor?.(adapter.name),
        conversation: message.threadKey ?? chatKey,
        senderLabel: message.senderLabel,
        text: message.text,
        ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
      });
      if (message.messageId !== undefined) this.deps.ingress?.decided(message.messageId, "heard");
      return undefined;
    }

    // A one-word answer to a consent this person was asked for is a decision, not a
    // new instruction: answer the approval and do not start a turn. Checked before
    // address parsing, so "allow" is never read as a message to an agent named allow.
    const pending = this.awaitingApproval.get(message.identity);
    const control = parseAddress(message.text);
    if (isContextCommand(control.text)) {
      const command = control.text.trim().toLowerCase();
      if (command !== "/new" && command !== "/new --clean") return "目前仅支持 /new 和 /new --clean；本次没有修改上下文。";
      if (message.files?.length) return "请单独发送 /new；附件未作为新任务消费。";
      const key = message.threadKey ?? message.chatKey ?? message.identity;
      const busy = this.runningWork.get(key) ?? [];
      const question = [...this.awaitingAnswer.values()].some(item => item.conversationKey === key && item.expiresAt > Date.now());
      const blocked = pending !== undefined || busy.length > 0 || question || this.pendingDrops.has(key) || [...this.inflightContexts.values()].includes(key);
      return this.deps.newContext?.({
        agentName: control.agentName ?? this.deps.defaultAgentFor?.(adapter.name),
        identity: message.identity,
        conversationKey: key,
        operationId: message.messageId === undefined ? "" : JSON.stringify([adapter.name, key, message.identity, message.messageId]),
        privateChat: message.privateChat === true,
        blockers: blocked ? ["渠道仍有运行中、排队、待回答/审批或待处理附件"] : [],
        mode: command === "/new --clean" ? "clean" : "normal",
      }) ?? "此入口尚未接入安全的上下文切换；本次没有修改会话。";
    }
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

    // The one verb that authorises destroying something. Three gates, in this order:
    // there has to be a question pending (otherwise the word is somebody talking about
    // upgrading, not answering), the person has to be an admin (a driver commands agents
    // inside the rules; replacing the machine they run on is changing the rules), and
    // only then is the decision recorded. Checked before the running-work routing, like
    // every other verb, so answering while a task runs is not read as steering it.
    if (parseUpgradeApproval(message.text) && this.deps.upgrade !== undefined) {
      if (this.deps.upgrade.waiting() === undefined) return NO_UPGRADE_WAITING;
      if (this.deps.mayAdmin?.(message.identity) !== true) return UPGRADE_IS_ADMIN_CALL;
      return this.deps.upgrade.approve(message.identity);
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

    // 「团队」 is a look at who works here — answered on the wire, before the
    // running-work routing, so asking mid-task never reads as steering.
    if (parseRosterRequest(message.text) && this.deps.roster !== undefined) {
      return this.deps.roster(adapter.name);
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

    const cleanConversationKey = message.threadKey ?? message.chatKey ?? message.identity;
    if (
      message.files !== undefined && message.files.length > 0 &&
      this.deps.contextMode?.({
        agentName: control.agentName ?? this.deps.defaultAgentFor?.(adapter.name),
        conversationKey: cleanConversationKey,
      }) === "clean"
    ) {
      return "当前是干净上下文，首版只接受文字；附件没有写入或交给模型。请先单独发送 /new 退出干净模式。";
    }

    // A dropped file with nothing said is a delivery; with an instruction in the same
    // message it is work starting. The first version treated every message carrying files
    // as a delivery and ignored its text — the person had just said what they wanted, and
    // was told to say what they wanted. Walkthrough step zero, broken at the first second.
    if (message.files !== undefined && message.files.length > 0 && parseContinuation(parseAddress(message.text).text) === undefined) {
      const drop = this.runDrop(adapter, message).catch(error => {
        this.deps.log(`channel ${adapter.name}: file request failed (${error instanceof Error ? error.message : String(error)})`);
      }).finally(() => {
        this.inflight.delete(drop);
        this.inflightContexts.delete(drop);
      });
      this.inflight.add(drop);
      this.inflightContexts.set(drop, message.threadKey ?? message.chatKey ?? message.identity);
      return undefined;
    }

    const { agentName, text } = parseAddress(message.text);
    if (text === "") return SAY_WHAT_YOU_NEED;

    // New requests always have their own task. Intent words and a pending question are
    // not ownership. Explicit references bind context, but still get a tracked turn;
    // no channel request uses fire-and-forget steering (INV-611/630).
    const conversationKey = message.threadKey ?? message.chatKey ?? message.identity;
    const entries = this.runningWork.get(conversationKey) ?? [];
    const running = entries.find(entry => agentName === undefined || entry.agentName === agentName);
    const reference = parseContinuation(text);
    const questionId = message.questionId ?? (reference?.kind === "answer" ? reference.id : undefined);
    let answering: { agentName: string; question: string; text: string; id: string } | undefined;
    let addition: { agentName: string | undefined; text: string } | undefined;
    if (questionId !== undefined) {
      const question = this.awaitingAnswer.get(questionId);
      if (question === undefined || question.expiresAt <= Date.now() ||
          question.identity !== message.identity || question.adapterName !== adapter.name ||
          question.conversationKey !== conversationKey ||
          (agentName !== undefined && agentName !== question.agentName)) {
        return "这个问题已失效，或不属于你、当前会话和指定的 agent。请重新发起请求。";
      }
      this.awaitingAnswer.delete(questionId);
      answering = { agentName: question.agentName, question: question.question, text: reference?.kind === "answer" ? reference.text : text, id: questionId };
    } else if (reference?.kind === "continue") {
      const target = entries.find(entry => entry.taskId === reference.id);
      if (target === undefined || target.identity !== message.identity || target.adapterName !== adapter.name ||
          (agentName !== undefined && target.agentName !== agentName) ||
          entries.find(entry => entry.agentName === target.agentName) !== target) {
        return "没有找到你在当前会话中正在执行的这个任务；排队中和已结束的任务不能追加。请单独发送新请求。";
      }
      // Even an explicit addition gets a tracked turn. Fire-and-forget steering can
      // race the old turn's exit and acknowledge words no later reply ever delivers.
      addition = { agentName: target.agentName, text: `[Additional instruction for task ${reference.id}; handle after the current turn]\n\n${reference.text}` };
    } else if (/^\/(?:answer|continue)(?:\s|$)/u.test(text)) {
      return "请使用 /answer 问题编号 答案，或 /continue 任务编号 追加内容。";
    }
    if (running !== undefined) {
      if (answering === undefined && parseStopRequest(text)) {
        const outcome = this.deps.stop?.(running.agentName, message.identity) ?? "not-running";
        // Three answers, not two: refused is not "nothing is running", and telling
        // somebody their stop worked when it did not is worse than refusing them.
        return outcome === "stopped" ? STOPPING : outcome === "refused" ? notYours(running.agentName) : NOTHING_RUNNING;
      }
    } else if (answering === undefined && parseStopRequest(text)) {
      return NOTHING_RUNNING;
    } else if (answering === undefined && parseAcceptance(text)) {
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

    // Explicit references retain their agent; otherwise the door owns the default.
    const addressed = answering?.agentName ?? addition?.agentName ?? agentName ?? this.deps.defaultAgentFor?.(adapter.name);

    // 「桌面」 is a link to the live screen, answered on the wire — the phone-sized
    // version of the web page's Take over.
    if (parseDesktopRequest(text) && this.deps.desktopUrl !== undefined) {
      return this.deps.desktopUrl(addressed, adapter.name);
    }

    // 「入会 <会议号>」 becomes the door's join instructions — the trigger that
    // sidesteps the vendor's invite machinery (see parseMeetingJoinRequest).
    const joinNo = parseMeetingJoinRequest(text);
    const finalText =
      joinNo !== undefined
        ? (this.deps.meetingJoinPrompt?.(joinNo, adapter.name) ?? text)
        : text;
    const textForTurn = answering === undefined ? addition?.text ?? finalText : `[Answer to question ${answering.id}: ${answering.question}]\n\n${answering.text}`;

    // "屏幕" is a look, not a task: no turn runs, the desktop is captured as it is.
    const work =
      parseScreenRequest(text) && this.deps.screenshot !== undefined
        ? this.runScreenshot(adapter, message, addressed)
        : (async () => {
            const files = message.files?.length ? await this.storeFiles(adapter, message) : undefined;
            if (message.files?.length && files === undefined) return;
            await this.runTask(adapter, message, addressed, textForTurn, files, { questionId: answering?.id });
          })();

    // The work runs behind this return; the decisions above stay synchronous because
    // a refusal or an approval answer *is* the whole response.
    const task = work.catch(error => {
      this.deps.log(`channel ${adapter.name}: request failed (${error instanceof Error ? error.message : String(error)})`);
    }).finally(() => {
      this.inflight.delete(task);
      this.inflightContexts.delete(task);
    });
    this.inflight.add(task);
    this.inflightContexts.set(task, conversationKey);
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
      throw error;
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
  private readonly inflightContexts = new Map<Promise<unknown>, string>();

  /** What each conversation is running right now, for the one-at-a-time routing rule. */
  /**
   * What is running or queued in each conversation, oldest first. A list because a queued
   * task starts its `runTask` while the one ahead of it is still running, and the first
   * one finishing must not wipe the flag the second still holds.
   */
  private readonly runningWork = new Map<string, { agentName: string | undefined; identity: string; adapterName: string; taskId?: string }[]>();

  /** The conversation's most recent board task — what an acceptance word refers to. */
  private readonly lastTask = new Map<string, string>();

  /** Explicit question bindings. Ordinary messages neither consume nor answer them. */
  private readonly awaitingAnswer = new Map<string, { agentId: string; agentName: string; identity: string; adapterName: string; conversationKey: string; question: string; expiresAt: number }>();

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
          const look = this.runLook(adapter, message, pending.files).catch(error => {
            this.deps.log(`channel ${adapter.name}: file preview failed (${error instanceof Error ? error.message : String(error)})`);
          }).finally(() => {
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
        undefined,
        undefined,
        undefined,
        message.id !== undefined ? { messageId: message.id } : undefined
      );
      const targetChatKey = message.threadKey ?? chatKey;
      if (reply.trim() !== "") await this.deliver(adapter, targetChatKey, message.identity, reply, anchor);
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
    const targetChatKey = message.threadKey ?? chatKey;
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    try {
      const image = await this.deps.screenshot!(agentName);
      if (image === undefined) {
        await this.deliver(
          adapter,
          targetChatKey,
          message.identity,
          "No desktop to show — the box may be off, or this agent has not started one.",
          anchor
        );
        return;
      }
      if (adapter.sendImage === undefined) {
        await this.deliver(
          adapter,
          targetChatKey,
          message.identity,
          "This channel cannot show images; open the app to watch the desktop.",
          anchor
        );
        return;
      }
      await adapter.sendImage(targetChatKey, image, anchor);
    } catch (error) {
      await this.deliver(
        adapter,
        targetChatKey,
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
   * senders, an identity-addressed one where it does not. Delivery failure settles the
   * task as failed, even when generation succeeded; the transcript retains the answer.
   */
  private async runTask(
    adapter: ChannelAdapter,
    message: InboundMessage,
    agentName: string | undefined,
    text: string,
    droppedFiles?: readonly string[],
    options?: { questionId?: string }
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    const runningKey = message.threadKey ?? chatKey;
    const targetChatKey = message.threadKey ?? chatKey;
    const runningEntry: { agentName: string | undefined; identity: string; adapterName: string; taskId?: string } = { agentName, identity: message.identity, adapterName: adapter.name, taskId: message.id ?? message.messageId };
    this.runningWork.set(runningKey, [...(this.runningWork.get(runningKey) ?? []), runningEntry]);
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
      this.deliver(adapter, targetChatKey, message.identity, line, anchor);
    const mark = (status: "working" | "done" | "failed") => {
      if (message.messageId === undefined) return;
      void adapter.noteStatus?.(message.messageId, status).catch(() => {});
    };
    mark("working");

    const ahead = this.deps.ahead?.(agentName, runningKey) ?? 0;
    const taskId = this.deps.board?.open({
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
    if (taskId !== undefined) {
      this.lastTask.set(runningKey, taskId);
      runningEntry.taskId = taskId;
    }
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
          cardHandle = await adapter.postTaskCard(targetChatKey, { ...card }, anchor, message.identity);
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

    const acknowledgeSafely = () => acknowledge().catch(() => this.deps.log(`channel ${adapter.name}: acknowledgement could not be delivered`));
    const ackTimer = setTimeout(() => {
      void acknowledgeSafely();
    }, this.deps.ackAfterMs ?? ACK_AFTER_MS);
    if (ahead > 0) void acknowledgeSafely();

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

    // The reply streaming into the card as it is written. Rate-limited on its own clock,
    // separate from tool progress: a reply grows many times a second.
    let lastStreamWrite = 0;
    const onText = (soFar: string) => {
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      const trimmed = soFar.trimEnd();
      if (trimmed === "") return;
      card.text =
        trimmed.length > STREAM_TAIL_CHARS ? `…${trimmed.slice(-STREAM_TAIL_CHARS)}` : trimmed;
      const now = Date.now();
      if (now - lastStreamWrite < STREAM_UPDATE_MS && !soFar.endsWith("\n")) return;
      lastStreamWrite = now;
      void adapter.updateTaskCard(cardHandle, { ...card }).catch((error: unknown) => {
        this.deps.log(
          `channel ${adapter.name}: streaming card update failed — ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      });
    };

    const finishCard = (status: TaskCardState["status"]) => {
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      card.status = status;
      delete card.action;
      delete card.ahead;
      delete card.text;
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
      // The opening line goes out the moment the model says it, so the person reads "我先查
      // 一下" while the search runs instead of silence until it ends. Remembered so the
      // final reply is not the same sentence twice when a model repeats itself.
      let interim: string | undefined;
      let interimDelivery: Promise<void> | undefined;
      const reply = await this.deps.ask(
        agentName,
        handedFiles.length > 0
          ? `${text}\n\n[随这条消息收到的文件: ${handedFiles.join(", ")}]`
          : text,
        message.identity,
        chatKey,
        onProgress,
        message.threadKey ?? chatKey,
        taskId,
        line => {
          if (interim !== undefined || line.trim() === "") return;
          interim = line.trim();
          interimDelivery = deliver(interim);
          void interimDelivery.catch((error: unknown) => {
            this.deps.log(
              `channel ${adapter.name}: interim line failed — ` +
                `${error instanceof Error ? error.message : String(error)}`
            );
          });
        },
        onText,
        message.id !== undefined ? { messageId: message.id, ...(options?.questionId !== undefined ? { questionId: options.questionId } : {}) } : undefined
      );
      clearTimeout(ackTimer);
      if (reply.trim() !== interim) {
        await deliver(reply.trim() === "" ? EMPTY_REPLY_NOTE : reply);
      } else await interimDelivery;
      // Whatever the turn left in the chat's outbox follows the reply — images shown
      // as images, everything else as a file. What was pushed is marked delivered;
      // what failed stays in the outbox for the next task rather than vanishing.
      await this.deliverFiles(adapter, targetChatKey, message.threadKey ?? chatKey, reply, anchor, line =>
        deliver(line)
      );
      // A generated answer is not yet a delivered answer. Settle only after text/files.
      const settled = taskId !== undefined ? this.deps.board?.closed(taskId, "done") : undefined;
      finishCard(settled === "review" ? "review" : "done");
      mark("done");
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
          if (image !== undefined) await adapter.sendImage(targetChatKey, image, anchor);
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
      this.deps.log(`channel ${adapter.name}: task failed — ${detail}`);
      await deliver(detail).catch(() => this.deps.log(`channel ${adapter.name}: failure notice could not be delivered`));
    } finally {
      // Only this task's own entry: a same-conversation task queued behind us keeps its
      // flag, so a message arriving after we exit is still about running work.
      const remaining = (this.runningWork.get(runningKey) ?? []).filter(entry => entry !== runningEntry);
      if (remaining.length === 0) this.runningWork.delete(runningKey);
      else this.runningWork.set(runningKey, remaining);
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
