/**
 * One bounded queue per actor (INV-554).
 *
 * Being @-mentioned on twenty items in a morning is a normal day, not an attack. Nothing
 * upstream covered it: the channel's run slots are per conversation, the policy gate reads
 * tokens already spent, and the follow-up budget counts a room's unprompted nudges. So a
 * consumer that took work as it arrived would start twenty turns for one person, each
 * paying, and the twentieth would be as late as the first was.
 *
 * Three rules, each the opposite of a quiet failure:
 *
 * - **Single concurrency, and the wait is visible.** One turn at a time per actor; the rest
 *   wait in a queue anyone can print. An invisible queue is indistinguishable from being
 *   ignored, which is the complaint this exists to prevent.
 * - **Full means refused, not queued.** Past capacity the request is turned down in words,
 *   so the person can ask again later or ask somebody else. Silent queueing behind a wall of
 *   nineteen others is a deadline missed with nobody told.
 * - **Cancelled stays cancelled.** A retry — a poll pass, a redelivery, a resumed process —
 *   re-offers ids that were already withdrawn. A queue that forgets cancellations answers
 *   questions nobody is waiting for any more, in the requester's name.
 *
 * Deadlines are the fourth: a request whose deadline has passed is dropped here rather than
 * run late, because the ledger's own sweep has already closed it and a second answer to a
 * closed request is worse than none.
 */

export interface QueuedRequest {
  id: string;
  /** What it is about, in a few words — this is what a person reads in the queue. */
  subject?: string;
  /** Epoch ms. Past it the request is dropped rather than run late. */
  deadlineAt?: number;
  /** Who pays for the turn: the principal the request is charged to. */
  payer?: string;
}

export type Admission =
  | { accepted: true; running: boolean; position: number }
  /** Already here: an ordinary poll pass re-offering what it offered last time. */
  | { accepted: false; reason: "known" }
  /** Withdrawn earlier and offered again. Never runs. */
  | { accepted: false; reason: "cancelled" }
  /** Its deadline has already passed. */
  | { accepted: false; reason: "lapsed" }
  /** No room. The caller must say so to whoever asked. */
  | { accepted: false; reason: "full"; why: string };

export interface QueueOptions {
  /** How many may wait, not counting the one running. */
  capacity?: number;
  /** How many run at once. One, for now — see the file comment. */
  concurrency?: number;
  now?: () => Date;
}

export interface QueueView {
  actor: string;
  running: { id: string; subject?: string; since: string }[];
  waiting: { id: string; subject?: string; since: string; position: number }[];
  capacity: number;
}

interface Entry extends QueuedRequest {
  offeredAt: number;
}

/** How many cancelled ids are remembered. Enough to outlive any redelivery window. */
const CANCELLED_MEMORY = 500;

export class ActorQueue {
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly waiting: Entry[] = [];
  private readonly running = new Map<string, Entry>();
  private readonly cancelled: string[] = [];

  constructor(
    readonly actor: string,
    options: QueueOptions = {}
  ) {
    this.capacity = Math.max(1, options.capacity ?? 8);
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.now = options.now ?? (() => new Date());
  }

  offer(request: QueuedRequest): Admission {
    if (this.cancelled.includes(request.id)) return { accepted: false, reason: "cancelled" };
    if (this.running.has(request.id) || this.waiting.some(entry => entry.id === request.id)) {
      return { accepted: false, reason: "known" };
    }
    if (request.deadlineAt !== undefined && request.deadlineAt <= this.now().getTime()) {
      return { accepted: false, reason: "lapsed" };
    }
    if (this.waiting.length >= this.capacity) {
      return {
        accepted: false,
        reason: "full",
        why:
          `I already have ${this.waiting.length} question${this.waiting.length === 1 ? "" : "s"} waiting and one in hand, ` +
          `which is as many as I take at once. Ask me again when one of them is answered, or ask somebody who is free — ` +
          `queueing this behind the others would just miss its deadline quietly.`,
      };
    }
    this.waiting.push({ ...request, offeredAt: this.now().getTime() });
    return { accepted: true, running: false, position: this.waiting.length };
  }

  /** The next request that may run now, or `undefined`. Lapsed ones are dropped, not returned. */
  next(): QueuedRequest | undefined {
    if (this.running.size >= this.concurrency) return undefined;
    const at = this.now().getTime();
    while (this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      if (entry.deadlineAt !== undefined && entry.deadlineAt <= at) continue;
      this.running.set(entry.id, entry);
      return entry;
    }
    return undefined;
  }

  /** It ran, or it failed. Either way it is no longer holding the slot. */
  done(id: string): void {
    this.running.delete(id);
  }

  /**
   * Withdrawn. Remembered, so the next poll pass re-offering the same id does not revive it —
   * and forgotten only when 500 newer cancellations have pushed it out.
   */
  cancel(id: string): void {
    this.running.delete(id);
    const index = this.waiting.findIndex(entry => entry.id === id);
    if (index >= 0) this.waiting.splice(index, 1);
    if (!this.cancelled.includes(id)) this.cancelled.push(id);
    while (this.cancelled.length > CANCELLED_MEMORY) this.cancelled.shift();
  }

  /**
   * Keeps only what the source still lists, and remembers the rest as cancelled.
   *
   * A withdrawn request does not arrive as an event: it simply stops being in the inbox. So
   * "no longer offered" is the only signal there is, and treating it as a cancellation is
   * what stops a redelivery of the same id being answered later (INV-554 A3). Anything in
   * flight is left alone — a turn already running is not withdrawn by a page that moved.
   */
  retainOnly(ids: ReadonlySet<string>): string[] {
    const dropped = this.waiting.filter(entry => !ids.has(entry.id)).map(entry => entry.id);
    for (const id of dropped) this.cancel(id);
    return dropped;
  }

  get depth(): number {
    return this.waiting.length;
  }

  view(): QueueView {
    const iso = (at: number) => new Date(at).toISOString();
    return {
      actor: this.actor,
      running: [...this.running.values()].map(entry => ({ id: entry.id, ...(entry.subject !== undefined ? { subject: entry.subject } : {}), since: iso(entry.offeredAt) })),
      waiting: this.waiting.map((entry, index) => ({ id: entry.id, ...(entry.subject !== undefined ? { subject: entry.subject } : {}), since: iso(entry.offeredAt), position: index + 1 })),
      capacity: this.capacity,
    };
  }
}

/** One queue per actor, made on first sight. */
export class ActorQueues {
  private readonly queues = new Map<string, ActorQueue>();

  constructor(private readonly options: QueueOptions = {}) {}

  for(actor: string): ActorQueue {
    const existing = this.queues.get(actor);
    if (existing !== undefined) return existing;
    const queue = new ActorQueue(actor, this.options);
    this.queues.set(actor, queue);
    return queue;
  }

  views(): QueueView[] {
    return [...this.queues.values()].map(queue => queue.view()).filter(view => view.running.length > 0 || view.waiting.length > 0);
  }
}

/** One line per actor with anything in hand, for a log or a status page. */
export function describeQueues(views: readonly QueueView[]): string[] {
  return views.map(
    view =>
      `${view.actor}: ${view.running.length > 0 ? `answering ${view.running[0]!.subject ?? view.running[0]!.id}` : "idle"}` +
      (view.waiting.length === 0 ? "" : `, ${view.waiting.length} waiting (${view.waiting.map(entry => entry.subject ?? entry.id).join(", ")})`)
  );
}
