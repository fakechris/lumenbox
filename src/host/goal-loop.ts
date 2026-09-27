/**
 * The continuation loop of goal mode (docs/74 §3.3, §3.5–3.8, §7 R4–R6 and R10–R11; INV-770).
 *
 * A pursuit that is `active` is kept moving by the host: whenever its conversation goes quiet,
 * one continuation wake is started — never queued behind a person, never more than one at a
 * time — and the turn it opens runs under the pursuit's `workId`. Four stops bound it: three
 * continuations in a row that called no working tool (anti-spin), plan + todos + workspace
 * unchanged across continuations (stalled), a count of continuations, and active time. At a
 * count or time limit the last turn is one round with no tools that reports where things
 * stand, and that report is the one continuation text the person is sent. A continuation
 * that fails is retried with backoff, then the goal pauses and says so.
 *
 * What this file does not do: decide that a goal is finished. That is the gate (INV-771),
 * which the executor asks for through the Goal tool; the loop only keeps the work moving
 * until something else stops it.
 *
 * Shape: one class with injected deps, so the whole loop runs in a unit test with a fake bus
 * and a fake clock. The orchestrator owns the real one and feeds it three facts — a turn
 * finished, a task changed, a turn is starting — and one report per continuation turn.
 */
import type { InboundMessage } from "../agents/bus.ts";
import type { Task, TaskStore } from "./tasks.ts";
import { continuationNotice, finishOnlyNotice, GOAL_BOOKKEEPING_TOOLS, type GoalMarker, type PausedReason, type Pursuit, stopNotice } from "./goal-mode.ts";
import { stateHashOf } from "./progress.ts";
import type { DurableState } from "./durable.ts";
import { createHash } from "node:crypto";

/** Continuations in a row that did no work before the goal pauses (Grok Bot: 3). */
export const ANTI_SPIN_LIMIT = 3;
/** Continuations in a row that changed nothing (plan, todos, workspace) before the goal pauses. */
export const STALL_LIMIT = 2;
/** Failed continuation turns in a row before the goal pauses. */
export const MAX_CONTINUATION_RETRIES = 2;
/** How long the conversation must stay quiet before a continuation starts. */
export const CONTINUATION_DELAY_MS = 1_500;
/** Backoff after a failed continuation turn: this × 2^(failures-1). */
export const RETRY_BACKOFF_MS = 30_000;

export interface GoalTurnReport {
  marker: GoalMarker;
  turnId?: string;
  conversation?: string;
  how: string;
  /** Whether any tool outside the bookkeeping set ran. */
  worked: boolean;
  /** The turn's final text, when it had one. Delivered only for a finish-only turn. */
  finalText?: string;
}

export interface GoalLoopDeps {
  tasks: TaskStore;
  /** Which agent pursues a task: its assignee. Absent means the loop cannot wake anyone. */
  agentName: (agentId: string) => string | undefined;
  bus: {
    isActive(agentId: string, conversation: string): boolean;
    queuedCount(agentId: string, conversation: string): number;
    sendFromUser(agentId: string, text: string, options: { conversation?: string; steerable?: boolean; lane?: "user" | "agent" | "background"; synthetic?: boolean; goal?: GoalMarker }): number | undefined;
    wake(agentId: string): Promise<void>;
  };
  /** Anything else that holds the conversation: an open turn in the ledger, a question, an approval. */
  busy: (agentId: string, conversation: string) => string[];
  /** The wake gate (policy): a stopped agent or one over its wake rate is refused. */
  wakeGate: (agentId: string) => { allowed: boolean; reason?: string };
  /** Plan and todos as the prompt sees them, for the stall hash. */
  durableState: (agentId: string, conversation: string) => DurableState | undefined;
  /** The workspace as path→hash, when there is a box to ask. */
  manifest?: () => Promise<Map<string, string> | undefined>;
  /** Tell the person, in their chat. */
  notify: (task: Task, text: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  /** Injectable for tests; defaults to the real timers. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

interface Key {
  taskId: string;
  agentId: string;
  conversation: string;
}

interface Pending {
  seq: number;
  personSeq: number;
  cancel: () => void;
}

export class GoalLoop {
  /** How many person-opened turns this conversation has seen; a wake scheduled before one is stale. */
  private readonly personSeq = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Map<string, { seq: number; startedAt: number }>();
  private seq = 0;

  constructor(private readonly deps: GoalLoopDeps) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  private schedule(fn: () => void, ms: number): { cancel: () => void } {
    if (this.deps.schedule !== undefined) return this.deps.schedule(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  private keyOf(task: Task): Key | undefined {
    if (task.assigneeId === undefined || task.conversation === undefined) return undefined;
    return { taskId: task.id, agentId: task.assigneeId, conversation: task.conversation };
  }

  private convKey(agentId: string, conversation: string): string {
    return `${agentId}/${conversation}`;
  }

  /** Every pursuit that is running, keyed for the loop. */
  private activePursuits(): Task[] {
    return this.deps.tasks.list().filter(task => task.pursuit?.status === "active" && this.keyOf(task) !== undefined);
  }

  // ── The three facts the orchestrator feeds ────────────────────────────────────────────

  /** A turn ended for this agent; whichever of its conversations has a running pursuit is reconsidered. */
  onTurnFinished(agentId: string): void {
    for (const task of this.activePursuits()) {
      if (task.assigneeId === agentId) this.consider(task);
    }
  }

  /** The board changed; a pursuit that just became active (created, resumed) is reconsidered. */
  onTaskChanged(task: Task): void {
    if (task.pursuit === undefined) return;
    if (task.pursuit.status === "active") this.consider(task);
    else this.cancelPending(task.id);
  }

  /**
   * A turn is starting. A person's message bumps the conversation's sequence, which makes any
   * continuation scheduled before it stale (review R6: a queued wake must not overtake a person).
   * Returns whether a goal-marked inbound should run at all.
   */
  turnStarting(agentId: string, conversation: string, inbound: readonly InboundMessage[]): boolean {
    const key = this.convKey(agentId, conversation);
    const person = inbound.some(message => message.fromId === "user" && message.synthetic !== true);
    if (person) {
      this.personSeq.set(key, (this.personSeq.get(key) ?? 0) + 1);
      // A wake still waiting for its delay is abandoned: the person's turn ends first, and
      // its ending reconsiders the goal.
      for (const task of this.activePursuits()) {
        if (task.assigneeId === agentId && task.conversation === conversation) this.cancelPending(task.id);
      }
    }
    const marker = inbound.find(message => message.goal !== undefined)?.goal;
    if (marker === undefined) return true;
    // A verification wake belongs to the gate (INV-771): it runs while the goal is verifying,
    // and the gate decides whether this attempt is still the one it wants.
    if (marker.verify !== undefined) {
      const verifying = this.deps.tasks.get(marker.taskId)?.pursuit;
      return verifying?.status === "verifying" && verifying.verifying?.attempt === marker.verify.attempt;
    }
    const task = this.deps.tasks.get(marker.taskId);
    const stillActive = task?.pursuit?.status === "active";
    const current = (this.personSeq.get(key) ?? 0) === marker.personSeq;
    const latest = this.pending.get(marker.taskId) === undefined && !this.running.has(marker.taskId);
    if (!stillActive || !current || !latest) {
      this.deps.log(`goal ${marker.taskId}: continuation ${marker.seq} not run (${!stillActive ? "goal no longer active" : !current ? "a person spoke first" : "superseded"})`);
      return false;
    }
    this.running.set(marker.taskId, { seq: marker.seq, startedAt: this.now() });
    return true;
  }

  /** On startup: every active pursuit is looked at again (its counters live on the board). */
  rearm(): number {
    const tasks = this.activePursuits();
    for (const task of tasks) this.consider(task);
    return tasks.length;
  }

  // ── Scheduling ───────────────────────────────────────────────────────────────────────

  private cancelPending(taskId: string): void {
    const pending = this.pending.get(taskId);
    if (pending === undefined) return;
    pending.cancel();
    this.pending.delete(taskId);
  }

  /** Decide whether this pursuit should get a continuation now, and arm one if so. */
  consider(task: Task): void {
    const key = this.keyOf(task);
    const pursuit = task.pursuit;
    if (key === undefined || pursuit === undefined || pursuit.status !== "active") return;
    if (this.pending.has(task.id) || this.running.has(task.id)) return;
    const busy = [
      ...(this.deps.bus.isActive(key.agentId, key.conversation) ? ["a turn is running"] : []),
      ...(this.deps.bus.queuedCount(key.agentId, key.conversation) > 0 ? ["messages are queued"] : []),
      ...this.deps.busy(key.agentId, key.conversation),
    ];
    if (busy.length > 0) return;
    const limit = this.limitReached(pursuit);
    const seq = ++this.seq;
    const personSeq = this.personSeq.get(this.convKey(key.agentId, key.conversation)) ?? 0;
    const timer = this.schedule(() => {
      this.pending.delete(task.id);
      this.start(key, seq, personSeq, limit);
    }, CONTINUATION_DELAY_MS);
    this.pending.set(task.id, { seq, personSeq, cancel: timer.cancel });
  }

  private limitReached(pursuit: Pursuit): PausedReason | undefined {
    if (pursuit.spent.continuations >= pursuit.limits.continuations) return "continuations";
    if (pursuit.spent.activeMs >= pursuit.limits.activeMs) return "deadline";
    return undefined;
  }

  private start(key: Key, seq: number, personSeq: number, limit: PausedReason | undefined): void {
    const task = this.deps.tasks.get(key.taskId);
    const pursuit = task?.pursuit;
    if (task === undefined || pursuit === undefined || pursuit.status !== "active") return;
    // Re-checked at the moment of starting, not only when scheduled: a person may have spoken
    // during the delay (then the sequence moved and this wake is dropped at turnStarting), or
    // a turn may have begun.
    if ((this.personSeq.get(this.convKey(key.agentId, key.conversation)) ?? 0) !== personSeq) return;
    if (this.deps.bus.isActive(key.agentId, key.conversation) || this.deps.bus.queuedCount(key.agentId, key.conversation) > 0 || this.deps.busy(key.agentId, key.conversation).length > 0) return;
    const gate = this.deps.wakeGate(key.agentId);
    if (!gate.allowed) {
      this.deps.log(`goal ${task.id}: continuation held by the wake gate${gate.reason !== undefined ? ` (${gate.reason})` : ""}`);
      return;
    }
    const marker: GoalMarker = {
      taskId: task.id,
      workId: pursuit.workId,
      seq,
      personSeq,
      ...(limit !== undefined ? { finishOnly: true as const, reason: limit } : {}),
    };
    const nth = pursuit.spent.continuations + 1;
    this.deps.tasks.setPursuit(task.id, current => ({ ...current, spent: { ...current.spent, continuations: nth } }), limit === undefined ? `continuation ${nth} started` : `finish-only turn started: ${limit}`);
    this.deps.log(`goal ${task.id}: ${limit === undefined ? `continuation ${nth}` : `finish-only turn (${limit})`} for ${this.deps.agentName(key.agentId) ?? key.agentId} (workId ${pursuit.workId})`);
    const text = limit === undefined ? continuationNotice(task, nth) : finishOnlyNotice(task, limit);
    this.deps.bus.sendFromUser(key.agentId, text, { conversation: key.conversation, synthetic: true, steerable: false, lane: "background", goal: marker });
    void this.deps.bus.wake(key.agentId);
  }

  // ── The report ───────────────────────────────────────────────────────────────────────

  /** A continuation turn ended; account for it and decide what happens next. */
  async turnEnded(report: GoalTurnReport): Promise<void> {
    const { marker } = report;
    const run = this.running.get(marker.taskId);
    this.running.delete(marker.taskId);
    const task = this.deps.tasks.get(marker.taskId);
    const pursuit = task?.pursuit;
    if (task === undefined || pursuit === undefined) return;
    const elapsed = run === undefined ? 0 : Math.max(0, this.now() - run.startedAt);

    if (marker.finishOnly === true) {
      const reason = marker.reason ?? "continuations";
      this.deps.tasks.setPursuit(task.id, current => ({ ...current, status: "paused", pausedReason: reason, spent: { ...current.spent, activeMs: current.spent.activeMs + elapsed } }), `paused: ${reason}, after a finish-only turn`);
      this.deps.log(`goal ${task.id}: paused (${reason}) after ${pursuit.spent.continuations} continuations`);
      await this.tell(task, `${report.finalText?.trim() ? `${report.finalText.trim()}\n\n` : ""}${stopNotice(this.deps.tasks.get(task.id)!, reason)}`);
      return;
    }

    if (report.how !== "done" && report.how !== "silent") {
      const failures = (pursuit.spent.errorStreak ?? 0) + 1;
      if (failures > MAX_CONTINUATION_RETRIES) {
        this.deps.tasks.setPursuit(task.id, current => ({ ...current, status: "paused", pausedReason: "error", spent: { ...current.spent, errorStreak: failures, activeMs: current.spent.activeMs + elapsed } }), `paused: ${failures} continuation turns failed in a row (last: ${report.how})`);
        this.deps.log(`goal ${task.id}: paused (error) after ${failures} failed continuations`);
        await this.tell(task, stopNotice(this.deps.tasks.get(task.id)!, "error", `最近一次：${report.how}`));
        return;
      }
      this.deps.tasks.setPursuit(task.id, current => ({ ...current, spent: { ...current.spent, errorStreak: failures, activeMs: current.spent.activeMs + elapsed } }), `continuation turn ${report.how}; retry ${failures} of ${MAX_CONTINUATION_RETRIES} after backoff`);
      const delay = RETRY_BACKOFF_MS * 2 ** (failures - 1);
      this.deps.log(`goal ${task.id}: continuation ${report.how}; retrying in ${Math.round(delay / 1000)}s`);
      const key = this.keyOf(task)!;
      const seq = ++this.seq;
      const personSeq = this.personSeq.get(this.convKey(key.agentId, key.conversation)) ?? 0;
      const timer = this.schedule(() => { this.pending.delete(task.id); this.start(key, seq, personSeq, undefined); }, delay);
      this.pending.set(task.id, { seq, personSeq, cancel: timer.cancel });
      return;
    }

    const idleStreak = report.worked ? 0 : pursuit.spent.idleStreak + 1;
    const stateHash = await this.stateHash(task);
    const stallStreak = stateHash !== undefined && stateHash === pursuit.spent.lastStateHash ? (pursuit.spent.stallStreak ?? 0) + 1 : 0;
    const stop: PausedReason | undefined = idleStreak >= ANTI_SPIN_LIMIT ? "anti_spin" : stallStreak >= STALL_LIMIT ? "stalled" : undefined;
    this.deps.tasks.setPursuit(
      task.id,
      current => ({
        ...current,
        ...(stop !== undefined ? { status: "paused" as const, pausedReason: stop } : {}),
        spent: { ...current.spent, idleStreak, stallStreak, errorStreak: 0, activeMs: current.spent.activeMs + elapsed, ...(stateHash !== undefined ? { lastStateHash: stateHash } : {}) },
      }),
      stop !== undefined
        ? `paused: ${stop} after continuation ${pursuit.spent.continuations}`
        : `continuation ${pursuit.spent.continuations} ended (${report.worked ? "worked" : "no working tool call"}${stateHash !== undefined ? `, state ${stateHash.slice(0, 8)}` : ""})`
    );
    if (stop !== undefined) {
      this.deps.log(`goal ${task.id}: paused (${stop}) after ${pursuit.spent.continuations} continuations`);
      await this.tell(task, stopNotice(this.deps.tasks.get(task.id)!, stop));
      return;
    }
    // The next continuation is considered by the turn_finished fact that follows this report.
  }

  /** Plan + todos + workspace, one digest. Absent when neither is readable. */
  private async stateHash(task: Task): Promise<string | undefined> {
    const key = this.keyOf(task);
    if (key === undefined) return undefined;
    const durable = this.deps.durableState(key.agentId, key.conversation);
    const manifest = this.deps.manifest === undefined ? undefined : await this.deps.manifest();
    if (durable === undefined && manifest === undefined) return undefined;
    const hash = createHash("sha256");
    hash.update(stateHashOf(durable ?? {}));
    if (manifest !== undefined) for (const [path, digest] of [...manifest.entries()].sort()) hash.update(`\n${path}\t${digest}`);
    return hash.digest("hex").slice(0, 16);
  }

  private async tell(task: Task, text: string): Promise<void> {
    try {
      await this.deps.notify(task, text);
    } catch (error) {
      this.deps.log(`goal ${task.id}: could not tell the person: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** For the turn: whether a call is work as far as the loop is concerned. */
export function isWorkingTool(name: string): boolean {
  return !GOAL_BOOKKEEPING_TOOLS.has(name);
}
