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

import {
  AgentNotFoundError,
  clampBlock,
  type AgentRecord,
  type AgentRegistry,
} from "./registry.ts";

export const AGENT_MESSAGE_MAX_LENGTH = 8000;

/** Prefix that marks a turn as woken by a teammate rather than the user. */
export const AGENT_WAKE_CUE = "[agent]";

export interface InboundMessage {
  fromId: string;
  fromName: string;
  text: string;
  priority: boolean;
  receivedAt: string;
}

/** Runs one turn for an agent. Returns when the agent's turn is finished. */
export type TurnRunner = (
  agent: AgentRecord,
  inbound: readonly InboundMessage[],
  signal: AbortSignal
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
    private readonly onEvent: (event: BusEvent) => void = () => {}
  ) {}

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
    const text = clampBlock(input.text ?? "", AGENT_MESSAGE_MAX_LENGTH);
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

    return priority
      ? `Sent to ${target.profile.name} as a priority message — it interrupts their current ` +
          `non-user work and wakes them now. Delivery is asynchronous: if they reply it will ` +
          `arrive later as a new message that wakes you. Don't wait on it.`
      : `Sent to ${target.profile.name}. Delivery is asynchronous: if they reply it will arrive ` +
          `later as a new message that wakes you. Don't wait on it.`;
  }

  /** Queues an inbound message and interrupts the recipient if it is priority. */
  private enqueue(agentId: string, message: InboundMessage): void {
    const queue = this.pending.get(agentId) ?? [];
    queue.push(message);
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
  sendFromUser(agentId: string, text: string): void {
    this.enqueue(agentId, {
      fromId: "user",
      fromName: "user",
      text: clampBlock(text, AGENT_MESSAGE_MAX_LENGTH),
      priority: false,
      receivedAt: new Date().toISOString(),
    });
  }

  drain(agentId: string): InboundMessage[] {
    const queue = this.pending.get(agentId) ?? [];
    this.pending.delete(agentId);
    return queue;
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
    options: { userDriven?: boolean } = {}
  ): Promise<void> {
    const agent = this.registry.tryGet(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);

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

      try {
        // Drain inside the exclusive section, so messages that arrived while we
        // were queued are picked up by this turn instead of spawning another.
        const inbound = this.drain(agentId);
        this.onEvent({ type: "turn_started", agentId, inboundCount: inbound.length });
        await this.runTurn(agent, inbound, controller.signal);
        this.onEvent({ type: "turn_finished", agentId });
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
          await this.runExclusive(agentId, { userDriven: false });
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
