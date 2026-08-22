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
import type { Inbox } from "./inbox.ts";
import {
  AgentNotFoundError,
  clampMessage,
  MAIN_CONVERSATION,
  type AgentRecord,
  type AgentRegistry,
} from "./registry.ts";

export const AGENT_MESSAGE_MAX_LENGTH = 8000;

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

export class AgentBus {
  private readonly pending = new Map<string, InboundMessage[]>();
  /** Tail of each agent's serialized turn chain. Never rejects. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveTurn>();
  /** Agents with a wake already queued, so a burst collapses into one turn. */
  private readonly wakeScheduled = new Set<string>();

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

    const message: InboundMessage = {
      id: randomUUID(),
      fromId: input.fromId,
      fromName,
      text,
      priority,
      receivedAt: new Date().toISOString(),
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
  private enqueue(agentId: string, message: InboundMessage): void {
    // Recorded before it is queued, and before the sender is told anything. The other order would
    // acknowledge work that is not yet written down, which is the whole failure being fixed.
    const admission = this.inbox?.admit(agentId, message);
    const queue = this.pending.get(agentId) ?? [];
    queue.push({ ...message, admission });
    this.pending.set(agentId, queue);

    if (!message.priority) return;

    // Priority supersedes background work but never interrupts the user's own turn:
    // the user is watching that one, and yanking it out from under them is worse
    // than a few seconds of delay.
    const running = this.active.get(agentId);
    if (running && !running.userDriven) {
      this.onEvent({ type: "turn_interrupted", agentId, reason: "priority_message" });
      running.controller.abort();
    }
  }

  /** Injects a message from the user (or an operator) into an agent's queue. */
  sendFromUser(agentId: string, text: string, options: { conversation?: string } = {}): void {
    this.enqueue(agentId, {
      id: randomUUID(),
      fromId: "user",
      fromName: "user",
      text: clampMessage(text, AGENT_MESSAGE_MAX_LENGTH),
      priority: false,
      receivedAt: new Date().toISOString(),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
    });
  }

  /**
   * Takes the queued messages for one conversation, leaving the others queued.
   *
   * One turn reads one conversation — a turn that mixed a Telegram group's question
   * with the team room's instructions would answer both into the wrong context. What
   * stays queued wakes a follow-up turn of its own.
   */
  drain(agentId: string, conversation: string = MAIN_CONVERSATION): InboundMessage[] {
    const queue = this.pending.get(agentId) ?? [];
    const taken = queue.filter(
      message => (message.conversation ?? MAIN_CONVERSATION) === conversation
    );
    const left = queue.filter(
      message => (message.conversation ?? MAIN_CONVERSATION) !== conversation
    );
    if (left.length === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, left);
    return taken;
  }

  /** The conversation of the oldest queued message, for waking in arrival order. */
  private nextConversation(agentId: string): string | undefined {
    const queue = this.pending.get(agentId);
    if (queue === undefined || queue.length === 0) return undefined;
    return queue[0]?.conversation ?? MAIN_CONVERSATION;
  }

  pendingCount(agentId: string): number {
    return this.pending.get(agentId)?.length ?? 0;
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

    // Every caller chains onto the current tail, so turns for one agent run in
    // arrival order and exactly one is ever in flight.
    const previous = this.chains.get(agentId) ?? Promise.resolve();

    const run = (async () => {
      await previous;

      const controller = new AbortController();
      this.active.set(agentId, {
        controller,
        userDriven: options.userDriven ?? false,
      });

      let inbound: InboundMessage[] = [];
      try {
        // Drain inside the exclusive section, so messages that arrived while we
        // were queued are picked up by this turn instead of spawning another —
        // this conversation's messages only; the rest wake their own turns.
        inbound = this.drain(agentId, conversation);
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
        if (this.active.get(agentId)?.controller === controller) {
          this.active.delete(agentId);
        }
      }
    })();

    // The stored tail must never reject, or an unrelated later turn would
    // inherit this one's failure. The caller still sees it via `await run`.
    // A settled tail is left in place: there is at most one per agent, and
    // awaiting an already-resolved promise costs a microtask.
    this.chains.set(agentId, run.catch(() => {}));

    await run;

    // Anything that landed during the turn — or the priority message that cut it
    // short — deserves a follow-up turn. When this call came from `wake`, its loop
    // handles that and the guard makes this a no-op.
    if (this.pendingCount(agentId) > 0) {
      void this.wake(agentId);
    }
  }

  /**
   * Drives turns for an agent until its queue is empty.
   *
   * The loop is what makes an interrupt safe. A priority message aborts the
   * running turn *before* that turn has consumed the message, so one turn is not
   * enough — and it cannot be a single re-entrant `wake` call either, because the
   * guard below is still held while the aborted turn unwinds. Looping here keeps
   * the guard's other job (collapsing a burst into one turn) without dropping the
   * message that caused the interrupt.
   */
  async wake(agentId: string): Promise<void> {
    if (this.pendingCount(agentId) === 0) return;
    if (this.wakeScheduled.has(agentId)) return;
    this.wakeScheduled.add(agentId);

    try {
      while (this.pendingCount(agentId) > 0) {
        try {
          // One conversation per turn, oldest message first: a Telegram group's
          // question and the team room's instruction each get their own context.
          await this.runExclusive(agentId, {
            userDriven: false,
            conversation: this.nextConversation(agentId),
          });
        } catch (error) {
          // Stop the loop, keep the queue. Anything still here arrived *after* the failed turn
          // started — the message that turn was given was taken off the queue before it ran — so
          // draining discarded work whose sender had already been told "Sent". The loop still has
          // to stop, because a turn that fails without consuming anything would otherwise be
          // retried forever; the difference is that stopping and forgetting are not the same thing.
          const waiting = this.pendingCount(agentId);
          this.onEvent({
            type: "turn_failed",
            agentId,
            error: error instanceof Error ? error.message : String(error),
            waiting,
          });
          return;
        }
      }
    } finally {
      this.wakeScheduled.delete(agentId);
    }
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

  /** Names of agents currently inside a turn. For status output. */
  activeAgentIds(): string[] {
    return [...this.active.keys()];
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
