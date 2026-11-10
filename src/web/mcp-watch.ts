/**
 * The side door's change feed (INV-1508, docs/90 §3.3): a supervisor outside learns within seconds
 * that a piece of work moved, without polling every task and without the host calling out.
 *
 * `watch` is a long poll. The host keeps a bounded ring of changes read off the board's own
 * onChange — a task's status, its stage-table row, its goal's status and pause reason — and only
 * when one of those differs from what the task last showed, so a note appended to a history is not
 * an event. A caller holds a cursor; a call returns what came after it, or waits for the next
 * change up to its limit. A cursor older than the ring says `reset`: read task_status again.
 * Not SSE and not a webhook: a host that dials out to a caller's URL is a new egress surface,
 * and this is a reading door.
 *
 * A task's creation is not on the board's change stream; its first move is, and that is when the feed first
 * shows it. The stage is read when the task changes. A turn starting or ending does not change the task, so
 * `working` versus `idle` moves without an event; status, the person/* rows and the goal do not.
 *
 * A fork of a task's turn is on the feed too (INV-1667): `fork.spawned`, `fork.started`, `fork.fenced`,
 * `fork.reported`, `fork.merged`, `fork.dropped`, each an event carrying the task it was forked for —
 * so a supervisor sees "split in two, one stuck" as it happens, not only the task's status after.
 */

import type { ForkChild, ForkEvent, ForkEvents } from "../host/fork-events.ts";
import type { Task } from "../host/tasks.ts";
import { randomUUID } from "node:crypto";

export const FEED_CAPACITY = 2000;
export const WAIT_MAX_SECONDS = 30;

export interface WatchEvent {
  seq: number;
  at: string;
  taskId: string;
  requester: string;
  status: string;
  stage?: string;
  pursuit?: { status: string; pausedReason?: string };
  /** A record watermark changed; reread the authorized task, not tool bodies through this door. */
  execution?: { revision: string };
  /** Present when the event is a fork of the task's turn moving, not the task itself. */
  fork?: { event: ForkEvent["event"]; id: string; child: string; brief: string; status: ForkChild["status"]; detail?: string };
}

export interface WatchResult {
  events: WatchEvent[];
  /** Hand this back as `since` next time. */
  cursor: string;
  /** The cursor was older than what the feed still holds: some changes are gone; read task_status. */
  reset: boolean;
}

interface Waiter {
  matches: (event: WatchEvent) => boolean;
  wake: () => void;
}

export class ChangeFeed {
  private readonly epoch = randomUUID();
  private readonly events: WatchEvent[] = [];
  private readonly last = new Map<string, string>();
  private seq = 0;
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly options: { capacity?: number; stageOf?: (task: Task) => string | undefined; now?: () => Date } = {}) {}

  /** Called for every board change; becomes an event only when what a watcher reads moved. */
  record(task: Task): void {
    const stage = this.options.stageOf?.(task);
    const pursuit = task.pursuit === undefined ? undefined : { status: task.pursuit.status, ...(task.pursuit.pausedReason !== undefined ? { pausedReason: task.pursuit.pausedReason } : {}) };
    const shown = JSON.stringify([task.status, stage, pursuit]);
    if (this.last.get(task.id) === shown) return;
    this.last.set(task.id, shown);
    const event: WatchEvent = {
      seq: ++this.seq,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      taskId: task.id,
      requester: task.requester,
      status: task.status,
      ...(stage !== undefined ? { stage } : {}),
      ...(pursuit !== undefined ? { pursuit } : {}),
    };
    this.push(event);
  }

  /** A fork of this task's turn moved (INV-1667): always an event, since each is a step nobody has seen. */
  recordFork(task: Task, event: ForkEvent, fork: ForkChild): void {
    const detail = event.detail ?? event.status;
    this.push({
      seq: ++this.seq,
      at: event.at,
      taskId: task.id,
      requester: task.requester,
      status: task.status,
      fork: { event: event.event, id: fork.id, child: fork.child, brief: fork.brief, status: fork.status, ...(detail !== undefined ? { detail } : {}) },
    });
  }

  recordExecution(task: Task, revision: string): void {
    this.push({ seq: ++this.seq, at: (this.options.now?.() ?? new Date()).toISOString(), taskId: task.id,
      requester: task.requester, status: task.status, execution: { revision } });
  }

  private push(event: WatchEvent): void {
    this.events.push(event);
    if (this.events.length > (this.options.capacity ?? FEED_CAPACITY)) this.events.shift();
    for (const waiter of [...this.waiters]) if (waiter.matches(event)) waiter.wake();
  }

  /** What came after `since`, for this filter, now. No `since`: nothing yet, and the cursor to start from. */
  since(since: string | undefined, matches: (event: WatchEvent) => boolean): WatchResult {
    const cursor = this.epoch + ":" + this.seq;
    if (since === undefined || since === "") return { events: [], cursor, reset: false };
    const split = since.lastIndexOf(":");
    // Old numeric cursors reset once; an old process's equal sequence is never trusted in a new epoch.
    if (split < 0 || since.slice(0, split) !== this.epoch) return { events: [], cursor, reset: true };
    const from = Number(since.slice(split + 1));
    if (!Number.isInteger(from) || from < 0 || from > this.seq) return { events: [], cursor, reset: true };
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    const reset = from + 1 < oldest && from < this.seq;
    return { events: this.events.filter(event => event.seq > from && matches(event)), cursor, reset };
  }

  /** `since`, or wait up to `waitMs` for the next matching change; an aborted wait releases its listener. */
  async wait(since: string | undefined, matches: (event: WatchEvent) => boolean, waitMs: number, signal?: AbortSignal): Promise<WatchResult> {
    const now = this.since(since, matches);
    if (now.events.length > 0 || now.reset || since === undefined || since === "" || waitMs <= 0 || signal?.aborted) return now;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(waiter); signal?.removeEventListener("abort", done); resolve(); };
      const waiter: Waiter = { matches, wake: done };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", done, { once: true });
    });
    return this.since(since, matches);
  }

  /** How many calls are waiting now; for the tests that say a dropped connection lets go. */
  waiting(): number {
    return this.waiters.size;
  }
}

/** Puts every fork step of a task's turns on the feed (INV-1667); a fork with no task (a chat aside, the team room) is not a task's change. */
export function feedForks(feed: ChangeFeed, forks: ForkEvents | undefined, taskOf: (id: string) => Task | undefined): void {
  forks?.onEvent((event, fork) => {
    const task = fork.taskId !== undefined ? taskOf(fork.taskId) : undefined;
    if (task !== undefined) feed.recordFork(task, event, fork);
  });
}

export function describeWatch(result: WatchResult): string {
  if (result.reset) return `reset: some changes are no longer held; read task_status again. cursor: ${result.cursor}`;
  if (result.events.length === 0) return `no changes. cursor: ${result.cursor}`;
  const lines = result.events.map(event => event.fork !== undefined ? `${event.taskId} ${event.fork.event} ${event.fork.child} (${event.fork.status}${event.fork.detail !== undefined ? `: ${event.fork.detail}` : ""}) "${event.fork.brief}" at ${event.at}` : `${event.taskId} ${event.status}${event.stage !== undefined ? ` ${event.stage}` : ""}${event.pursuit !== undefined ? ` goal ${event.pursuit.status}${event.pursuit.pausedReason !== undefined ? ` (${event.pursuit.pausedReason})` : ""}` : ""} at ${event.at}`);
  return `${lines.join("\n")}\ncursor: ${result.cursor}`;
}
