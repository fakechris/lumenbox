/**
 * Agent-to-agent messaging.
 *
 * The model here is texting, not RPC: `send` delivers the message, wakes the
 * recipient, and returns an acknowledgement immediately. A reply, if there is
 * one, arrives later as its own inbound message that wakes the original sender on
 * a fresh turn. Nothing blocks waiting for a response, so two agents can never
 * deadlock on each other.
 *
 * Turns are serialized per agent by an exclusive-run queue: an agent is only ever
 * inside one turn, so its transcript and profile have a single writer.
 */

import { randomUUID } from "node:crypto";
import { envNumber } from "../config.ts";
import type { Inbox } from "./inbox.ts";
import {
  AgentNotFoundError,
  clampMessage,
  MAIN_CONVERSATION,
  type AgentRecord,
  type AgentRegistry,
} from "./registry.ts";

export const AGENT_MESSAGE_MAX_LENGTH = 8000;
/** How long an identical agent-to-agent message counts as a repeat. */
export const DUPLICATE_SEND_WINDOW_MS = 10 * 60_000;

/** Prefix that marks a turn as woken by a teammate rather than the user. */
export const AGENT_WAKE_CUE = "[agent]";

/**
 * The sender of a message the system generates about itself.
 *
 * Its own name so these cannot cascade: a failure notice never produces another one, whatever
 * happens to the turn that receives it.
 */
export const SYSTEM_SENDER = "system";

export interface InboundMessage {
  fromId: string;
  fromName: string;
  text: string;
  priority: boolean;
  receivedAt: string;
  /**
   * Carried by the host on the sender's behalf rather than sent with `SendToAgent`: a prose
   * reply on a teammate-woken turn, a task assignment, a new agent's first message. A turn
   * woken by a relayed message does not relay its own prose back, which is what keeps two
   * agents from bouncing "noted" at each other forever (docs/11, 2026-09-08).
   */
  relayed?: boolean;
  /**
   * This message, identified, so both ends can point at the same thing.
   *
   * Ordering is not the hard part here and a logical clock would be machinery for a problem this
   * system does not have: every agent runs in one process against one clock, so timestamps already
   * put events in order. What was missing is the *link* — a turn recorded no trace of which message
   * caused it, and a sent message recorded no trace of which turn sent it, so "who caused this"
   * could not be walked backwards however precisely everything was timed. The moment there are two
   * orchestrators this stops being enough and a real clock is needed; it is not enough now for the
   * reason stated, not by accident.
   */
  id: string;
  /**
   * Its handle in the durable inbox, so the turn that takes it can mark it started.
   *
   * Absent when nothing was recorded — no inbox configured, or a write that failed. The message is
   * still delivered in this process; what it loses is the ability to survive a restart.
   */
  admission?: number;
  /**
   * Which conversation this belongs to. Absent means the main one — the team room —
   * which is where every teammate and system message goes: agents talk to each other
   * in the room, not inside somebody's Telegram thread. Rides inside the message so
   * the durable inbox persists it for free.
   */
  conversation?: string;
  /**
   * Whether a running turn may consume this as mid-turn steering. Absent means yes
   * for a user message. False is for kickoffs that must open their own turn whatever
   * is running — a scheduled skill, a resume prompt — where absorption into someone
   * else's task would bury the report inside an unrelated reply.
   */
  steerable?: boolean;
  /**
   * Which class of work this is, which decides what waits for what.
   *
   * A person asking a question and a nightly digest firing are not the same urgency,
   * and until they were told apart the digest could take the conversation's worker for
   * minutes while the person watched a card sit still. Absent is inferred from the
   * sender: `user` for a person, `agent` for a teammate — so nothing has to be
   * declared to keep working, and the machinery that *is* background (a schedule, an
   * audit, a resume) says so.
   */
  lane?: Lane;
  /**
   * The harness started this turn, not a person — a timer, a webhook, a resume, a first run.
   *
   * It arrives as a message `fromId: "user"` because that is the shape that opens a turn, and
   * for a while that made every scheduled kickoff indistinguishable from somebody typing: the
   * webhook's own brief was drawn in the chat as the person's words, and the turn was treated
   * as one the person was waiting on.
   */
  synthetic?: boolean;
  /**
   * A person said this in a room without addressing this agent (INV-775): a group message
   * that names nobody, on a door that runs every message. The turn is a person's, but nobody
   * is waiting on this agent in particular, so it may end in deliberate silence.
   */
  addressed?: false;
  /**
   * The tools a routine's own skill said it needs (INV-691). A turn opened only by messages that
   * carry one is offered what the agent has *and* the skill named — never more. Rides inside the
   * message so a routine resumed after a restart is held to the same list.
   */
  toolScope?: readonly string[];
}

/** Ordered: `user` beats `agent` beats `background`, and the drain enforces exactly that. */
export type Lane = "user" | "agent" | "background";

const LANE_ORDER: readonly Lane[] = ["user", "agent", "background"];

/**
 * How long a lower lane may be passed over before it goes first anyway.
 *
 * Strict priority alone starves: a busy room's stream of questions would keep an audit
 * or a digest waiting forever, and work that never runs is worse than work that runs
 * late. Two minutes is chosen to be far longer than any ordinary turn — so it only
 * fires when a lane really is being held down — and the promotion is self-limiting,
 * because draining that lane empties it.
 */
const STARVATION_MS = envNumber("AGENTBOX_LANE_STARVATION_MS", 120_000);

/** The lane a message belongs to, from what it declared or what it is. */
export function laneOf(message: InboundMessage): Lane {
  if (message.lane !== undefined) return message.lane;
  if (message.fromId === "user") return "user";
  if (message.fromId === SYSTEM_SENDER) return "background";
  return "agent";
}

/**
 * Which lane the next turn takes: the highest one present, unless a lane has been
 * held down past the starvation window — and then the highest *starved* one.
 *
 * The second clause reads oddly until you follow it through. It fires only when a
 * lower lane is old and the higher lanes are not, which is exactly the shape of
 * starvation: a stream of *fresh* questions arriving while an audit waits. When the
 * questions are old too they are starved themselves, and being higher they still go
 * first — which is right, because then nothing is being held down, the agent is
 * simply behind.
 *
 * Its own function because it is the whole of the policy and deserves to be tested
 * without a bus, a registry, or a clock anyone has to fake.
 */
export function chooseLane(
  messages: readonly InboundMessage[],
  now: number,
  starvationMs: number = STARVATION_MS
): Lane | undefined {
  const present = LANE_ORDER.filter(lane => messages.some(message => laneOf(message) === lane));
  if (present.length === 0) return undefined;
  const starved = present.filter(lane =>
    messages.some(
      message => laneOf(message) === lane && now - Date.parse(message.receivedAt) > starvationMs
    )
  );
  return (starved[0] ?? present[0])!;
}

/** Runs one turn for an agent. Returns when the agent's turn is finished. */
export type TurnRunner = (
  agent: AgentRecord,
  inbound: readonly InboundMessage[],
  signal: AbortSignal,
  conversation: string
) => Promise<void>;

interface ActiveTurn {
  controller: AbortController;
  /** True while the running turn was started by the user, not by a wake. */
  userDriven: boolean;
}

/**
 * The unit of serialization: one agent within one conversation.
 *
 * Turns for the *same* agent-and-conversation run one at a time (a conversation's
 * transcript has a single writer, always). Turns for the same agent in *different*
 * conversations run concurrently — that is the whole of what makes an agent's outside
 * chats not block its team-room work, and vice versa. A worker instance, in the
 * framework's terms, is one running turn keyed like this.
 */
function workerKey(agentId: string, conversation: string): string {
  return `${agentId} ${conversation}`;
}

/** A message a running turn may absorb at a round boundary: the user's, and not a kickoff. */
function isSteering(message: InboundMessage): boolean {
  return message.fromId === "user" && message.steerable !== false;
}

export class AgentBus {
  /** Recent sends per sender→recipient, for the repeat check in `send`. */
  private readonly recentSends = new Map<string, { text: string; at: number }[]>();
  private readonly pending = new Map<string, InboundMessage[]>();
  /** Tail of each (agent, conversation) serialized turn chain, by workerKey. Never rejects. */
  private readonly chains = new Map<string, Promise<void>>();
  /** In-flight turns, by workerKey — one per agent-and-conversation at most. */
  private readonly active = new Map<string, ActiveTurn>();
  /** Worker loops already running, by workerKey, so a burst collapses into one turn. */
  private readonly wakeScheduled = new Set<string>();
  /**
   * Who is waiting to hear that steering arrived, by workerKey.
   *
   * A running turn parked inside a long tool call — a fork join, most of all — cannot see
   * the queue it would read at its next round boundary. This is how it is woken instead
   * of waiting the join out (R8's second boundary condition).
   */
  private readonly steeringListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly runTurn: TurnRunner,
    private readonly onEvent: (event: BusEvent) => void = () => {},
    /**
     * Where accepted-but-unstarted work is recorded.
     *
     * Injected rather than defaulted, so nothing acquires a file by accident: production wires one
     * in the orchestrator and a test gets none unless it asks. Without it, a request answered with
     * 202 and an inter-agent message answered with "Sent to Bob" existed only in the map above —
     * accepted, acknowledged, and gone if the process died a millisecond later.
     */
    private readonly inbox: Inbox<InboundMessage> | undefined = undefined
  ) {}

  /**
   * Re-queues work that was accepted but never begun, and says what it found.
   *
   * Called once at startup. Only unstarted messages are here — a turn marks its messages started
   * before anything runs — so nothing replayed has executed anything, and re-queueing it cannot
   * duplicate a side effect.
   */
  recover(): number {
    const pending = this.inbox?.pending() ?? [];
    let restored = 0;
    for (const item of pending) {
      if (this.registry.tryGet(item.agentId) === undefined) continue;
      const queue = this.pending.get(item.agentId) ?? [];
      queue.push({ ...item.message, admission: item.seq });
      this.pending.set(item.agentId, queue);
      restored += 1;
    }
    for (const agentId of this.pending.keys()) void this.wake(agentId);
    return restored;
  }

  /**
   * Delivers a message to another agent and wakes it.
   *
   * Returns the acknowledgement string the sending agent sees as its tool result.
   */
  send(input: {
    fromId: string;
    toId: string;
    text: string;
    priority?: boolean;
    relayed?: boolean;
  }): string {
    const text = clampMessage(input.text ?? "", AGENT_MESSAGE_MAX_LENGTH);
    if (text.length === 0) return "Message was empty; nothing was sent.";
    if (input.toId === input.fromId) {
      return "An agent can't message itself. Reply to the user instead, or pick a different target id.";
    }

    const target = this.registry.tryGet(input.toId);
    if (!target) return `No agent found with id ${input.toId}.`;

    const sender = this.registry.tryGet(input.fromId);
    const fromName = sender?.profile.name ?? input.fromId;
    const priority = input.priority ?? false;

    // The same words to the same teammate within a few minutes is a repeat, not news: two
    // days of a Grok team showed dozens of turns whose only output was "duplicate FYI,
    // staying quiet" — each a wake, a prompt and a bill. Refused here with the reason, so
    // the sender learns the rule instead of the recipient paying for it.
    const recentKey = `${input.fromId}→${input.toId}`;
    const now = Date.now();
    const recent = (this.recentSends.get(recentKey) ?? []).filter(entry => now - entry.at < DUPLICATE_SEND_WINDOW_MS);
    const repeat = recent.find(entry => entry.text === text);
    if (repeat !== undefined) {
      this.recentSends.set(recentKey, recent);
      return (
        `Not sent: you sent ${target.profile.name} this exact message ${Math.max(1, Math.round((now - repeat.at) / 60_000))} ` +
        `minute(s) ago and it is queued or delivered. Wait for their reply, or say something new.`
      );
    }
    recent.push({ text, at: now });
    this.recentSends.set(recentKey, recent.slice(-20));

    const message: InboundMessage = {
      id: randomUUID(),
      fromId: input.fromId,
      fromName,
      text,
      priority,
      receivedAt: new Date().toISOString(),
      ...(input.relayed === true ? { relayed: true } : {}),
    };

    this.enqueue(input.toId, message);
    this.onEvent({
      type: "message_sent",
      fromId: input.fromId,
      fromName,
      toId: target.id,
      toName: target.profile.name,
      priority,
      text,
    });

    // Fire-and-forget: waking the recipient must not block the sender's turn.
    void this.wake(target.id);

    // What this acknowledgement actually promises, said rather than implied.
    //
    // "Sent" reads like "received and understood", and it never meant that: it means the message is
    // recorded and queued. An acknowledgement that cannot be told apart from agreement is where a
    // team of agents starts holding conversations to build the ack layer it does not have — "you
    // sure?" / "sure" / "ok starting" — which costs a turn each and confirms nothing.
    const promise =
      `Recorded and queued for ${target.profile.name}, as message ${message.id}. That is the whole ` +
      `of what this guarantees: it is written down and it will be delivered. It does not mean ` +
      `${target.profile.name} has read it, agrees with it, or is doing it. You will hear again only ` +
      `if they reply, or if their turn fails — asking them to confirm receipt buys nothing this ` +
      `line has not already told you.`;

    return priority
      ? `${promise} Marked priority, so it interrupts their current non-user work and wakes them now.`
      : promise;
  }

  /**
   * Tells whoever sent a message that the turn it reached did not finish.
   *
   * Only agents, and only about their own messages: the user watches turns fail in the UI, and a
   * notification about a notification is how a failing agent turns into a broadcast storm. Sent as
   * `system` for the same reason — nothing generated here can generate more of itself.
   */
  private notifySenders(
    agent: AgentRecord,
    inbound: readonly InboundMessage[],
    error: unknown
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    const senders = new Set(
      inbound
        .filter(message => message.fromId !== "user" && message.fromId !== SYSTEM_SENDER)
        .map(message => message.fromId)
    );

    for (const senderId of senders) {
      if (this.registry.tryGet(senderId) === undefined) continue;
      const theirs = inbound
        .filter(message => message.fromId === senderId)
        .map(message => message.id);
      this.enqueue(senderId, {
        id: randomUUID(),
        fromId: SYSTEM_SENDER,
        fromName: SYSTEM_SENDER,
        text:
          `Your message${theirs.length === 1 ? "" : "s"} to ${agent.profile.name} ` +
          `(${theirs.join(", ")}) reached a turn that then failed: ${reason}. It was delivered and ` +
          `not acted on. Nothing has been retried. Decide whether this still needs doing — and if ` +
          `it does, whether ${agent.profile.name} is the one to do it.`,
        priority: false,
        receivedAt: new Date().toISOString(),
      });
      void this.wake(senderId);
    }
  }

  /** Queues an inbound message and interrupts the recipient if it is priority. */
  private enqueue(agentId: string, message: InboundMessage): number | undefined {
    // Recorded before it is queued, and before the sender is told anything. The other order would
    // acknowledge work that is not yet written down, which is the whole failure being fixed.
    const admission = this.inbox?.admit(agentId, message);
    const queue = this.pending.get(agentId) ?? [];
    queue.push({ ...message, admission });
    this.pending.set(agentId, queue);

    if (isSteering(message)) {
      const key = workerKey(agentId, message.conversation ?? MAIN_CONVERSATION);
      for (const listener of this.steeringListeners.get(key) ?? []) listener();
    }

    if (!message.priority) return admission;

    // Priority supersedes background work but never interrupts the user's own turn:
    // the user is watching that one, and yanking it out from under them is worse
    // than a few seconds of delay. It interrupts only the worker for *this* message's
    // conversation — a priority note in the team room does not abort a Telegram task.
    const key = workerKey(agentId, message.conversation ?? MAIN_CONVERSATION);
    const running = this.active.get(key);
    if (running && !running.userDriven) {
      this.onEvent({ type: "turn_interrupted", agentId, reason: "priority_message" });
      running.controller.abort();
    }
    return admission;
  }

  /**
   * Cancels an admitted-but-unstarted message in the durable inbox, so a replay after a
   * restart never runs it. For the fork ledger's sweep (docs/32 §1); no other caller.
   */
  dropAdmission(seq: number | undefined): void {
    this.inbox?.drop(seq);
  }

  /**
   * Cancels every admitted-but-unstarted message in conversations the predicate selects, in
   * the durable inbox and in memory. The fork ledger's sweep uses it for `fork/*` as a whole:
   * a child that was admitted but never recorded as such (the crash landed between the two
   * appends) is still found this way. Returns how many were dropped.
   */
  dropAdmissionsWhere(select: (conversation: string) => boolean): number {
    const dropped = this.inbox?.dropWhere(item => select(item.message.conversation ?? MAIN_CONVERSATION)) ?? 0;
    for (const [agentId, queue] of this.pending) {
      const kept = queue.filter(message => !select(message.conversation ?? MAIN_CONVERSATION));
      if (kept.length === 0) this.pending.delete(agentId);
      else if (kept.length !== queue.length) this.pending.set(agentId, kept);
    }
    return dropped;
  }

  /** True when there is no durable inbox at all: a queued note is then as delivered as it gets. */
  get inboxless(): boolean {
    return this.inbox === undefined;
  }

  /** Whether a durable, unstarted message in this conversation contains the text. */
  hasQueuedText(agentId: string, conversation: string, needle: string): boolean {
    return (this.inbox?.pending() ?? []).some(
      item =>
        item.agentId === agentId &&
        (item.message.conversation ?? MAIN_CONVERSATION) === conversation &&
        item.message.text.includes(needle)
    );
  }

  /**
   * Injects a message from the user (or an operator) into an agent's queue. Returns the
   * durable inbox sequence when there is an inbox, so a caller that must record where its
   * message went (the fork ledger) can.
   */
  sendFromUser(
    agentId: string,
    text: string,
    options: {
      conversation?: string;
      steerable?: boolean;
      lane?: Lane;
      synthetic?: boolean;
      /** False when the message named nobody in a room; see `InboundMessage.addressed`. */
      addressed?: boolean;
      /**
       * The id the message already has, when it came through a door: minted where the
       * channel message was admitted and written to `messages.jsonl` there, so the same
       * id runs from the channel's own message id to the transcript's `causedBy`
       * (INV-613). Absent for everything else — the web, a routine, a teammate — and a
       * fresh one is minted here as before.
       */
      messageId?: string;
      /** A routine's declared tools; see `InboundMessage.toolScope`. */
      toolScope?: readonly string[];
    } = {}
  ): number | undefined {
    return this.enqueue(agentId, {
      id: options.messageId ?? randomUUID(),
      fromId: "user",
      fromName: "user",
      ...(options.synthetic === true ? { synthetic: true } : {}),
      ...(options.addressed === false ? { addressed: false as const } : {}),
      text: clampMessage(text, AGENT_MESSAGE_MAX_LENGTH),
      priority: false,
      receivedAt: new Date().toISOString(),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
      ...(options.steerable === false ? { steerable: false } : {}),
      ...(options.lane !== undefined ? { lane: options.lane } : {}),
      ...(options.toolScope !== undefined ? { toolScope: options.toolScope } : {}),
    });
  }

  /**
   * Takes the queued messages for one conversation, leaving the others queued.
   *
   * One turn reads one conversation — a turn that mixed a Telegram group's question
   * with the team room's instructions would answer both into the wrong context. What
   * stays queued wakes a follow-up turn of its own.
   */
  drain(
    agentId: string,
    conversation: string = MAIN_CONVERSATION,
    now: number = Date.now()
  ): InboundMessage[] {
    const queue = this.pending.get(agentId) ?? [];
    const mine = queue.filter(
      message => (message.conversation ?? MAIN_CONVERSATION) === conversation
    );
    if (mine.length === 0) return [];

    // One lane per turn — so a person's question is never batched into the same turn
    // as a nightly digest, and never queues behind one either.
    const chosen = chooseLane(mine, now);
    if (chosen === undefined) return [];

    const inLane = mine.filter(message => laneOf(message) === chosen);
    // A kickoff — a message flagged steerable:false — is one piece of work with its own
    // card and board row, and it gets a turn of its own: the first one alone when it is
    // at the head, and otherwise everything ahead of it. Chat messages still batch (R1a):
    // two lines typed in quick succession are one thought, and a turn per line would
    // answer each with half the context. Before this, three links queued behind a
    // running turn were drained into one turn together, and the three cards that
    // promised three answers all showed the same one.
    const firstKickoff = inLane.findIndex(message => message.steerable === false);
    const taken =
      firstKickoff === 0 ? inLane.slice(0, 1) : firstKickoff > 0 ? inLane.slice(0, firstKickoff) : inLane;
    const left = queue.filter(message => !taken.includes(message));
    if (left.length === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, left);
    return taken;
  }

  pendingCount(agentId: string): number {
    return this.pending.get(agentId)?.length ?? 0;
  }

  /**
   * Mid-turn steering: the *user's* messages queued for one conversation, taken by
   * its running turn at a round boundary.
   *
   * User messages only, deliberately. A teammate's message is new work that deserves
   * its own turn and its own causal record — that behaviour is pinned by the race
   * catalog — while the user talking to a turn already in flight is steering it.
   * Taken messages are marked started in the durable inbox exactly as a drain marks
   * them: whoever consumes a message owns that bookkeeping.
   */
  takeSteering(agentId: string, conversation: string = MAIN_CONVERSATION): InboundMessage[] {
    const queue = this.pending.get(agentId) ?? [];
    const taken = queue.filter(
      message =>
        (message.conversation ?? MAIN_CONVERSATION) === conversation && isSteering(message)
    );
    if (taken.length === 0) return [];
    const left = queue.filter(message => !taken.includes(message));
    if (left.length === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, left);
    this.inbox?.start(taken.map(message => message.admission));
    return taken;
  }

  /**
   * Queued messages for one of an agent's conversations.
   *
   * Public alongside `isActive` for whoever owes an acknowledgement: a channel
   * telling a chat "N ahead of you" reads the number from here rather than guessing.
   */
  /**
   * Calls `listener` when a steering message is queued for this conversation — at once if
   * one already is. Returns the unsubscribe. The listener is a wake-up, not a delivery:
   * the turn still takes the messages at its next round boundary, exactly as before.
   */
  onSteering(agentId: string, conversation: string, listener: () => void): () => void {
    const key = workerKey(agentId, conversation);
    const listeners = this.steeringListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.steeringListeners.set(key, listeners);
    const queued = (this.pending.get(agentId) ?? []).some(
      message =>
        (message.conversation ?? MAIN_CONVERSATION) === conversation && isSteering(message)
    );
    if (queued) listener();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.steeringListeners.delete(key);
    };
  }

  /**
   * Queues a system message into one of an agent's conversations and wakes it.
   *
   * For findings that finish after the turn that asked for them was woken away — a fork's
   * result landing after its join was interrupted. Never steering (system messages are not),
   * so it opens a turn of its own once the conversation is free, where the agent reads it
   * as what it is: a late report, not an instruction.
   */
  deliverSystem(agentId: string, text: string, conversation: string = MAIN_CONVERSATION): number | undefined {
    const seq = this.enqueue(agentId, {
      id: randomUUID(),
      fromId: SYSTEM_SENDER,
      fromName: SYSTEM_SENDER,
      text: clampMessage(text, AGENT_MESSAGE_MAX_LENGTH),
      priority: false,
      receivedAt: new Date().toISOString(),
      ...(conversation !== MAIN_CONVERSATION ? { conversation } : {}),
    });
    void this.wake(agentId);
    return seq;
  }

  queuedCount(agentId: string, conversation: string = MAIN_CONVERSATION): number {
    const queue = this.pending.get(agentId);
    if (queue === undefined) return 0;
    return queue.filter(m => (m.conversation ?? MAIN_CONVERSATION) === conversation).length;
  }

  /** Whether a turn is in flight for this agent and conversation. */
  isActive(agentId: string, conversation: string = MAIN_CONVERSATION): boolean {
    return this.active.has(workerKey(agentId, conversation));
  }

  /** The distinct conversations an agent currently has messages queued for. */
  private pendingConversations(agentId: string): string[] {
    const queue = this.pending.get(agentId);
    if (queue === undefined) return [];
    const seen = new Set<string>();
    const order: string[] = [];
    for (const message of queue) {
      const conversation = message.conversation ?? MAIN_CONVERSATION;
      if (!seen.has(conversation)) {
        seen.add(conversation);
        order.push(conversation);
      }
    }
    return order;
  }

  /**
   * Runs a turn for an agent, serialized against any turn already in flight.
   *
   * `userDriven` turns are protected from priority interrupts.
   */
  async runExclusive(
    agentId: string,
    options: { userDriven?: boolean; conversation?: string } = {}
  ): Promise<void> {
    const agent = this.registry.tryGet(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    const conversation = options.conversation ?? MAIN_CONVERSATION;
    const key = workerKey(agentId, conversation);

    // Every caller chains onto the current tail *for this conversation*, so turns for
    // one agent-and-conversation run in arrival order and exactly one is ever in
    // flight — while a different conversation of the same agent runs concurrently.
    const previous = this.chains.get(key) ?? Promise.resolve();

    const run = (async () => {
      await previous;

      const controller = new AbortController();
      this.active.set(key, {
        controller,
        userDriven: options.userDriven ?? false,
      });

      let inbound: InboundMessage[] = [];
      try {
        // Drain inside the exclusive section, so messages that arrived while we
        // were queued are picked up by this turn instead of spawning another —
        // this conversation's messages only; the rest wake their own turns.
        inbound = this.drain(agentId, conversation);
        // An empty drain is a turn with nothing to say and no reason to say it: the
        // messages that queued this call were consumed by a running turn's steering
        // while this call waited on the chain. Burning a model call on an empty
        // prompt would answer a question nobody is still asking.
        if (inbound.length === 0) return;
        // Marked started before the turn runs, not after it finishes. After would mean replaying
        // half-finished turns, and a turn that deployed something before dying would deploy it
        // twice; resuming one properly needs per-step checkpoints, which do not exist yet.
        this.inbox?.start(inbound.map(message => message.admission));
        this.onEvent({ type: "turn_started", agentId, inboundCount: inbound.length });
        await this.runTurn(agent, inbound, controller.signal, conversation);
        this.onEvent({ type: "turn_finished", agentId });
      } catch (error) {
        // The senders are told. Their acknowledgement said the message would be delivered, and it
        // was — into a turn that then failed, which they would otherwise wait on forever. This is
        // the one case where silence turns that acknowledgement into a lie.
        this.notifySenders(agent, inbound, error);
        throw error;
      } finally {
        if (this.active.get(key)?.controller === controller) {
          this.active.delete(key);
        }
      }
    })();

    // The stored tail must never reject, or an unrelated later turn would
    // inherit this one's failure. The caller still sees it via `await run`.
    // A settled tail is left in place: there is at most one per workerKey, and
    // awaiting an already-resolved promise costs a microtask.
    this.chains.set(key, run.catch(() => {}));

    await run;

    // Anything that landed for this conversation during the turn — or the priority
    // message that cut it short — deserves a follow-up. When this call came from a
    // worker loop, that loop handles it and the guard makes this a no-op.
    if (this.queuedCount(agentId, conversation) > 0) {
      void this.wake(agentId);
    }
  }

  /**
   * Drives turns for an agent, one worker loop per conversation, concurrently.
   *
   * Each conversation with queued messages gets its own loop that drains that
   * conversation until it is empty — so a long team-room task and a quick Telegram
   * question progress at the same time rather than one waiting on the other. A loop
   * is guarded by its workerKey, so a burst in one conversation still collapses into
   * a single turn there, and the loop is what makes a priority interrupt safe: it
   * re-runs after the aborted turn unwinds without dropping the message that caused it.
   */
  async wake(agentId: string): Promise<void> {
    const loops: Promise<void>[] = [];
    for (const conversation of this.pendingConversations(agentId)) {
      const key = workerKey(agentId, conversation);
      if (this.wakeScheduled.has(key)) continue;
      this.wakeScheduled.add(key);

      loops.push(
        (async () => {
          try {
            while (this.queuedCount(agentId, conversation) > 0) {
              try {
                await this.runExclusive(agentId, { userDriven: false, conversation });
              } catch (error) {
                // Stop this conversation's loop, keep its queue. Anything still here arrived *after*
                // the failed turn started — the message that turn was given was taken off the queue
                // before it ran — so draining discarded work whose sender had already been told
                // "Sent". The loop stops because a turn that fails without consuming anything would
                // otherwise retry forever; stopping and forgetting are not the same thing.
                this.onEvent({
                  type: "turn_failed",
                  agentId,
                  error: error instanceof Error ? error.message : String(error),
                  waiting: this.queuedCount(agentId, conversation),
                });
                return;
              }
            }
          } finally {
            this.wakeScheduled.delete(key);
          }
        })()
      );
    }
    // Await the conversation loops this call started, so `await wake()` still means
    // "this agent's queued work has drained" — while different conversations drained
    // concurrently. A loop already running for a conversation (guarded above) is not
    // awaited here; whoever started it awaits it.
    await Promise.all(loops);
  }

  /**
   * Resolves once no agent has a turn in flight and no message is queued.
   *
   * Loops rather than awaiting once, because a finishing turn can send a message
   * that wakes another agent, which is the whole point of the system.
   */
  async idle(timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Promise.allSettled([...this.chains.values()]);
      if (this.active.size === 0 && this.totalPending() === 0) return;
      // Give a just-scheduled wake a chance to register in `chains`.
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Agents did not settle within ${timeoutMs / 1000}s`);
  }

  /** Ids of agents with at least one turn in flight (any conversation). For status. */
  activeAgentIds(): string[] {
    // Keys are `agentId conversation`; the agent id is everything before the space.
    const ids = new Set<string>();
    for (const key of this.active.keys()) ids.add(key.slice(0, key.indexOf(" ")));
    return [...ids];
  }

  private totalPending(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }
}

export type BusEvent =
  | {
      type: "message_sent";
      fromId: string;
      fromName: string;
      toId: string;
      toName: string;
      priority: boolean;
      text: string;
    }
  | { type: "turn_started"; agentId: string; inboundCount: number }
  | { type: "turn_finished"; agentId: string }
  | {
      type: "turn_failed";
      agentId: string;
      error: string;
      /**
       * Messages still queued for this agent, which the failure did not consume.
       *
       * Reported because they are kept rather than discarded, and a queue nobody mentions is
       * indistinguishable from work that was silently thrown away.
       */
      waiting: number;
    }
  | { type: "turn_interrupted"; agentId: string; reason: string };
