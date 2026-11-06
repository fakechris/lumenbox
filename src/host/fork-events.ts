/**
 * What a person sees of a fork (INV-1667): each child of a conversation, its state, its one-line
 * brief, its last activity, and the chain of one delegation — sent, started, reported, merged.
 *
 * The fork ledger (pending-work.ts, docs/32) is the authority for *whether* a fork's findings
 * reached its parent, and it forgets: it is compacted to nothing whenever nothing is open, because
 * its job is recovery, not history. This is the history beside it — the same forks, keyed by the
 * same ledger id, as events a page and the side door can read after the fact:
 *
 * - `fork.spawned`  the child's brief reached the durable inbox (the Fork tool, after `admitted`)
 * - `fork.started`  the child's first turn began (turn.ts)
 * - `fork.fenced`   the fence refused a withheld tool in the child (the dispatch refusal, docs/32 §2)
 * - `fork.reported` the child's findings came back, with its handoff status
 * - `fork.merged`   the findings are durably the parent's (the ledger's `committed`)
 * - `fork.dropped`  a restart dropped it before that (the ledger's `dropped`)
 *
 * Observation only: nothing here decides, fences or retries anything, and a write that fails is
 * a warning — the fork runs whether or not a person can see it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine, type LedgerKind } from "./jsonl.ts";
import { pendingWorkPath } from "./pending-work.ts";

export type ForkEventKind = "fork.spawned" | "fork.started" | "fork.fenced" | "fork.reported" | "fork.merged" | "fork.dropped";

/** How a child stands, for a person: still going, finished, stuck (partial, blocked, unstated, failed), stopped by the fence, or lost to a restart. */
export type ForkStatus = "running" | "done" | "stuck" | "fenced" | "dropped";

export interface ForkEvent {
  event: ForkEventKind;
  /** The fork ledger's id (pw-…). */
  id: string;
  at: string;
  /** On `fork.spawned`, who forked, from where, into which conversation, about what, for which task. */
  agentId?: string;
  parent?: string;
  child?: string;
  brief?: string;
  taskId?: string;
  /** `fork.reported`: the child's handoff status, or `failed`; `fork.merged`: how it was committed; `fork.dropped`: why. */
  status?: string;
  /** `fork.reported`: the handoff's reason; `fork.fenced`: the tool the fence refused. */
  detail?: string;
}

/** One child of a conversation, as the thread picker, the task card and the record show it. */
export interface ForkChild {
  id: string;
  agentId: string;
  parent: string;
  child: string;
  brief: string;
  taskId?: string;
  status: ForkStatus;
  /** The handoff's status word when it reported anything other than done, or the tool the fence refused. */
  reason?: string;
  lastAt: string;
  /** The chain, oldest first. */
  steps: { event: ForkEventKind; at: string; status?: string; detail?: string }[];
}

/** A window on the forks: the newest are kept whole and the oldest fall off; the ledger, not this, is owed every fork. */
export const LEDGER_KIND: LedgerKind = "feed";

/** How many forks the file keeps; older ones are dropped whole when it is rewritten. */
const KEEP_FORKS = 500;
const COMPACT_AT = 4000;

/** Beside the fork ledger, so whatever moves the ledger (a test's home, an override) moves this with it. */
export function forkEventsPath(ledgerPath = pendingWorkPath()): string {
  return join(dirname(ledgerPath), "fork-events.jsonl");
}

function statusOf(steps: ForkChild["steps"]): { status: ForkStatus; reason?: string } {
  if (steps.some(step => step.event === "fork.dropped")) return { status: "dropped" };
  const reported = steps.find(step => step.event === "fork.reported");
  const fenced = steps.find(step => step.event === "fork.fenced");
  if (reported?.status === "done") return { status: "done" };
  if (fenced !== undefined) return { status: "fenced", ...(fenced.detail !== undefined ? { reason: fenced.detail } : {}) };
  if (reported !== undefined) return { status: "stuck", reason: reported.detail !== undefined ? `${reported.status}: ${reported.detail}` : reported.status ?? "unstated" };
  return { status: "running" };
}

export class ForkEvents {
  private readonly path: string | undefined;
  private readonly forks = new Map<string, ForkChild>();
  private readonly byChild = new Map<string, string>();
  private readonly listeners = new Set<(event: ForkEvent, fork: ForkChild) => void>();
  private lines = 0;

  constructor(path: string | null = forkEventsPath(), private readonly onWarn: (message: string) => void = () => {}) {
    this.path = path ?? undefined;
    if (this.path === undefined || !existsSync(this.path)) return;
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        this.lines += 1;
        try { this.apply(JSON.parse(line) as ForkEvent); } catch { /* a torn line: one step lost, the fork stays */ }
      }
    } catch (error) {
      this.onWarn(`fork-events: cannot read ${this.path} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Called for every event that lands on a known fork, after it is applied. */
  onEvent(listener: (event: ForkEvent, fork: ForkChild) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  spawned(input: { id: string; agentId: string; parent: string; child: string; brief: string; taskId?: string }, now = new Date()): void {
    this.record({ event: "fork.spawned", ...input, brief: input.brief.replace(/\s+/g, " ").trim().slice(0, 120), at: now.toISOString() });
  }

  /** A turn began in a fork conversation; only its first counts. */
  started(agentId: string, child: string, now = new Date()): void {
    const fork = this.childOf(agentId, child);
    if (fork === undefined || fork.steps.some(step => step.event === "fork.started")) return;
    this.record({ event: "fork.started", id: fork.id, at: now.toISOString() });
  }

  /** The fence refused `tool` in a fork conversation. */
  fenced(agentId: string, child: string, tool: string, now = new Date()): void {
    const fork = this.childOf(agentId, child);
    if (fork !== undefined) this.record({ event: "fork.fenced", id: fork.id, detail: tool, at: now.toISOString() });
  }

  reported(id: string, status: string, reason?: string, now = new Date()): void {
    this.record({ event: "fork.reported", id, status, ...(reason !== undefined ? { detail: reason } : {}), at: now.toISOString() });
  }

  /** The ledger committed or dropped this id; ids that are not forks (delegates, effects) are ignored. */
  settled(id: string, how: "merged" | "dropped", status: string, now = new Date()): void {
    if (this.forks.has(id)) this.record({ event: how === "merged" ? "fork.merged" : "fork.dropped", id, status, at: now.toISOString() });
  }

  /** Every child an agent forked, in the order they were sent — fork 1 before fork 2. */
  children(agentId: string): ForkChild[] {
    return [...this.forks.values()].filter(fork => fork.agentId === agentId).sort((a, b) => a.steps[0]!.at.localeCompare(b.steps[0]!.at));
  }

  /** The children forked while working a task, oldest first — the order they were sent. */
  ofTask(taskId: string): ForkChild[] {
    return [...this.forks.values()].filter(fork => fork.taskId === taskId).sort((a, b) => a.steps[0]!.at.localeCompare(b.steps[0]!.at));
  }

  /** "分了 N 个子任务，M 个完成" for a task's reply in a chat, or nothing when it forked nothing. */
  tallyLine(taskId: string): string | undefined {
    const forks = this.ofTask(taskId);
    if (forks.length === 0) return undefined;
    const done = forks.filter(fork => fork.status === "done").length;
    const running = forks.filter(fork => fork.status === "running").length;
    return `分了 ${forks.length} 个子任务，${done} 个完成${running > 0 ? `，${running} 个仍在进行` : ""}。`;
  }

  private childOf(agentId: string, child: string): ForkChild | undefined {
    const id = this.byChild.get(`${agentId}\u0000${child}`);
    return id === undefined ? undefined : this.forks.get(id);
  }

  private apply(event: ForkEvent): ForkChild | undefined {
    if (typeof event?.id !== "string" || typeof event.event !== "string") return undefined;
    let fork = this.forks.get(event.id);
    if (event.event === "fork.spawned") {
      if (fork !== undefined || event.agentId === undefined || event.child === undefined) return undefined;
      fork = {
        id: event.id, agentId: event.agentId, parent: event.parent ?? "main", child: event.child, brief: event.brief ?? "",
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}), status: "running", lastAt: event.at, steps: [],
      };
      this.forks.set(event.id, fork);
      this.byChild.set(`${fork.agentId}\u0000${fork.child}`, fork.id);
    }
    if (fork === undefined) return undefined;
    fork.steps.push({ event: event.event, at: event.at, ...(event.status !== undefined ? { status: event.status } : {}), ...(event.detail !== undefined ? { detail: event.detail } : {}) });
    fork.lastAt = event.at;
    const { status, reason } = statusOf(fork.steps);
    fork.status = status;
    if (reason !== undefined) fork.reason = reason; else delete fork.reason;
    return fork;
  }

  private record(event: ForkEvent): void {
    const fork = this.apply(event);
    if (fork === undefined) return;
    if (this.path !== undefined) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        appendLine(this.path, JSON.stringify(event));
        this.lines += 1;
        if (this.lines > COMPACT_AT) this.compact();
      } catch (error) {
        this.onWarn(`fork-events: cannot write ${this.path} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    for (const listener of this.listeners) {
      try { listener(event, fork); } catch (error) { this.onWarn(`fork-events: a listener threw (${error instanceof Error ? error.message : String(error)})`); }
    }
  }

  /** Keeps the newest forks whole: a fork's later steps without its `spawned` would be unreadable. */
  private compact(): void {
    const kept = [...this.forks.values()].sort((a, b) => a.steps[0]!.at.localeCompare(b.steps[0]!.at)).slice(-KEEP_FORKS);
    for (const fork of this.forks.values()) {
      if (!kept.includes(fork)) { this.forks.delete(fork.id); this.byChild.delete(`${fork.agentId}\u0000${fork.child}`); }
    }
    const lines = kept.flatMap(fork => fork.steps.map(step => JSON.stringify({
      event: step.event, id: fork.id, at: step.at,
      ...(step.event === "fork.spawned" ? { agentId: fork.agentId, parent: fork.parent, child: fork.child, brief: fork.brief, ...(fork.taskId !== undefined ? { taskId: fork.taskId } : {}) } : {}),
      ...(step.status !== undefined ? { status: step.status } : {}),
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
    })));
    const temp = `${this.path!}.${process.pid}.tmp`;
    writeFileSync(temp, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    renameSync(temp, this.path!);
    this.lines = lines.length;
  }
}

