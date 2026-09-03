/**
 * The fork ledger: a record that a piece of delegated work exists, written before the work
 * starts and settled only once its findings are durably in the parent's hands (docs/32 §1).
 *
 * Four events per fork — `prepared`, `admitted`, `committed`, `dropped` — because the two
 * that v1 had were the whole review's objection: "begin" said nothing about whether the child's
 * message had reached the durable inbox, and "settle" was written before the parent's transcript
 * held the result. Every reference we read (Grok Bot's pending-wakes file, OpenClaw's runs.json,
 * Hermes's delegation rows) writes the record before the side effect; only Hermes settles after
 * delivery, and that is the one that never loses a result.
 *
 * Append-only, replayed, compacted when nothing is open — the TurnLedger shape — with one
 * deliberate difference: `prepared` is fsync'd and a failed write *throws*, and the Fork tool
 * turns that into "not started". This is the one file where bookkeeping is allowed to stop work.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentboxHome } from "../config.ts";
import { appendLine, appendLineDurably } from "./jsonl.ts";

export function pendingWorkPath(): string {
  return process.env.AGENTBOX_PENDING_WORK ?? join(agentboxHome(), "pending-work.jsonl");
}

/** Rewrite the file once settled lines outnumber this, and only when nothing is open. */
const COMPACT_AT = 500;

export type CommitHow = "done" | "failed" | "late";
export type DropWhy = "restart" | "unrecorded";

export type WorkKind = "fork" | "delegate";

interface PreparedRecord {
  event: "prepared";
  id: string;
  /** Absent in records from before slice two, which were all forks. */
  kind?: WorkKind;
  agentId: string;
  workId?: string;
  turnId?: string;
  parent: string;
  child: string;
  brief: string;
  at: string;
  build?: { version: string; commit: string };
}
interface AdmittedRecord { event: "admitted"; id: string; inboxSeq?: number; at: string }
interface CommittedRecord { event: "committed"; id: string; how: CommitHow; at: string }
interface DroppedRecord { event: "dropped"; id: string; why: DropWhy; at: string }
type Record_ = PreparedRecord | AdmittedRecord | CommittedRecord | DroppedRecord;

/** A fork or a delegated job that was prepared and neither committed nor dropped. */
export interface OpenFork {
  id: string;
  kind: WorkKind;
  agentId: string;
  parent: string;
  child: string;
  brief: string;
  at: string;
  /** Present once the child's message reached the durable inbox. */
  inboxSeq?: number;
  admitted: boolean;
}

/** What the startup sweep needs from the rest of the host, narrowed so it can be faked. */
export interface SweepDeps {
  /** Cancels every unstarted admission in fork conversations; returns how many. */
  dropForkAdmissions: () => number;
  /** Ends every interrupted turn record in fork conversations; returns how many. */
  endForkTurns: (how: string) => number;
  lastWordsOf: (agentId: string, conversation: string) => string | undefined;
  /** Queues a system note durably; returns whether it was admitted. */
  deliver: (agentId: string, text: string, conversation: string) => boolean;
  /** Whether a note carrying this tag already waits in the parent's inbox. */
  noteQueued: (agentId: string, conversation: string, tag: string) => boolean;
  agentExists: (agentId: string) => boolean;
  /**
   * What the box says about a delegated job (docs/32 slice two): running, exited with a
   * code, interrupted (the daemon restarted under it), or gone. Undefined when the box
   * cannot be asked, in which case the record stays open for the next start.
   */
  jobStatus: (
    agentId: string,
    jobId: string
  ) => Promise<{ running: boolean; exit_code?: number; interrupted?: boolean; log_path?: string } | undefined>;
}

/** The tag every note about a fork carries, so a restart can see one is already queued. */
export function forkTag(id: string): string {
  return `[fork ${id}]`;
}

/** Whether a conversation name is a fork child's (the `FORK_PREFIX` of tools.ts). */
export function isForkChild(conversation: string): boolean {
  return conversation.startsWith("fork/");
}

export class PendingWork {
  private readonly path: string | undefined;
  private lines = 0;

  constructor(
    path: string | null = pendingWorkPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.path = path ?? undefined;
  }

  /**
   * Records that a fork is about to be started. Durable before returning, or it throws —
   * and the caller must then not start the fork.
   */
  prepare(input: {
    agentId: string;
    kind?: WorkKind;
    parent: string;
    child: string;
    brief: string;
    workId?: string;
    turnId?: string;
    build?: { version: string; commit: string };
    now?: Date;
  }): string {
    const id = `pw-${randomUUID().slice(0, 12)}`;
    if (this.path === undefined) return id;
    const record: PreparedRecord = {
      event: "prepared",
      id,
      kind: input.kind ?? "fork",
      agentId: input.agentId,
      ...(input.workId !== undefined ? { workId: input.workId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      parent: input.parent,
      child: input.child,
      brief: input.brief.replace(/\s+/g, " ").trim().slice(0, 120),
      at: (input.now ?? new Date()).toISOString(),
      ...(input.build !== undefined ? { build: input.build } : {}),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendLineDurably(this.path, JSON.stringify(record));
    this.lines += 1;
    return id;
  }

  /** The child's message reached the durable inbox under this sequence. */
  admitted(id: string, inboxSeq: number | undefined, now = new Date()): void {
    this.append({ event: "admitted", id, ...(inboxSeq !== undefined ? { inboxSeq } : {}), at: now.toISOString() });
  }

  /** The findings are durably with the parent: in its transcript, or admitted to its inbox. */
  commit(entries: readonly { id: string; how: CommitHow }[], now = new Date()): void {
    for (const entry of entries) this.append({ event: "committed", id: entry.id, how: entry.how, at: now.toISOString() });
    this.maybeCompact();
  }

  dropped(id: string, why: DropWhy, now = new Date()): void {
    this.append({ event: "dropped", id, why, at: now.toISOString() });
    this.maybeCompact();
  }

  /**
   * Settles the delegated job with this id, if one is open. Called wherever the host observes
   * the job's end — the `Jobs` tool, the MCP face's lease renewal, the startup sweep — so the
   * first observer commits and the rest find nothing open. Returns whether one was.
   */
  commitDelegate(jobId: string, how: CommitHow, now = new Date()): boolean {
    const open = this.open().find(work => work.kind === "delegate" && work.child === jobId);
    if (open === undefined) return false;
    this.commit([{ id: open.id, how }], now);
    return true;
  }

  /** Forks prepared and never settled, oldest first. */
  open(): OpenFork[] {
    const open = new Map<string, OpenFork>();
    for (const record of this.read()) {
      if (record.event === "prepared") {
        open.set(record.id, {
          id: record.id,
          kind: record.kind ?? "fork",
          agentId: record.agentId,
          parent: record.parent,
          child: record.child,
          brief: record.brief,
          at: record.at,
          admitted: false,
        });
      } else if (record.event === "admitted") {
        const fork = open.get(record.id);
        if (fork !== undefined) {
          fork.admitted = true;
          if (record.inboxSeq !== undefined) fork.inboxSeq = record.inboxSeq;
        }
      } else {
        open.delete(record.id);
      }
    }
    return [...open.values()];
  }

  /**
   * Settles every open fork after a restart (docs/32 §1).
   *
   * Runs before the inbox replays and before interrupted turns are resumed. Two rules from the
   * implementation review, both fail-closed: what is cancelled does not depend on this file —
   * *every* unstarted admission in a `fork/*` conversation is dropped and *every* interrupted
   * `fork/*` turn is ended, ledger or no ledger, because a fork never resumes across a
   * restart; and the parent is told *before* the record is settled, so a crash in between
   * costs a repeated note (deduplicated by tag) rather than a lost one.
   */
  async sweep(deps: SweepDeps, now = new Date()): Promise<OpenFork[]> {
    deps.dropForkAdmissions();
    deps.endForkTurns("dropped-fork");
    const dropped: OpenFork[] = [];
    for (const fork of this.open()) {
      const tag = forkTag(fork.id);
      const exists = deps.agentExists(fork.agentId);
      if (fork.kind === "delegate") {
        // A delegated job outlives the host: boxd runs it, and boxd now says what became
        // of it (docs/32 slice two). Running stays open; exited is committed; interrupted or
        // gone is dropped, with the log's path so the parent can read what it left.
        const status = await deps.jobStatus(fork.agentId, fork.child);
        if (status === undefined) continue;
        if (status.running) continue;
        if (status.interrupted !== true && status.exit_code !== undefined) {
          this.commit([{ id: fork.id, how: status.exit_code === 0 ? "done" : "failed" }], now);
          continue;
        }
        if (exists) {
          const admitted = deps.deliver(
            fork.agentId,
            `${tag} A job you delegated (${fork.child}, brief: "${fork.brief}") ` +
              (status.interrupted === true
                ? `was interrupted by a restart of the box daemon; its exit was never seen`
                : `is gone from the box`) +
              `. ` +
              (status.log_path !== undefined ? `Its log is at ${status.log_path} — read_file it. ` : "") +
              `Anything it did is an attempt, not a result; nothing was re-run.`,
            fork.parent
          );
          if (!admitted) continue;
        }
        this.dropped(fork.id, "restart", now);
        dropped.push(fork);
        continue;
      }
      // A late result that reached the parent's inbox before the process died is delivered
      // work, not dropped work: the note is already queued, and it says so.
      if (exists && deps.noteQueued(fork.agentId, fork.parent, tag)) {
        this.commit([{ id: fork.id, how: "late" }], now);
        continue;
      }
      if (exists) {
        const last = fork.admitted ? deps.lastWordsOf(fork.agentId, fork.child) : undefined;
        const admitted = deps.deliver(
          fork.agentId,
          `${tag} A fork you started was dropped by a restart before its findings reached you` +
            (fork.admitted ? "" : " (it may never have been admitted)") +
            `. Its brief began: "${fork.brief}". ` +
            (last !== undefined && last.trim() !== ""
              ? `Its last words: "${last.replace(/\s+/g, " ").trim().slice(0, 300)}". `
              : "It had said nothing yet. ") +
            `Anything it did is an attempt, not a result; nothing was re-run. Decide whether the piece still needs doing.`,
          fork.parent
        );
        // A note that could not be admitted leaves the record open, so the next start tries
        // again — the one case where staying open is right.
        if (!admitted) continue;
      }
      this.dropped(fork.id, fork.admitted ? "restart" : "unrecorded", now);
      dropped.push(fork);
    }
    return dropped;
  }

  /**
   * Whether the ledger file exists but cannot be read. The sweep is fail-closed without it —
   * it cancels every fork admission regardless — but the operator should know the record of
   * *which* forks those were is gone.
   */
  unreadable(): string | undefined {
    if (this.path === undefined || !existsSync(this.path)) return undefined;
    try {
      readFileSync(this.path, "utf8");
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private append(record: AdmittedRecord | CommittedRecord | DroppedRecord): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(record));
      this.lines += 1;
    } catch (error) {
      // After `prepared`, a lost settle line costs one spurious "dropped" note on the next
      // start — the parent is told about a fork it already received. Loud, and survivable.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`pending-work: cannot write ${this.path} (${detail})`);
    }
  }

  private read(): Record_[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      const records: Record_[] = [];
      let lines = 0;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        try {
          const record = JSON.parse(line) as Record_;
          if (typeof record?.id === "string" && typeof record.event === "string") records.push(record);
        } catch {
          // A torn last line: at most one settle is lost, which the next sweep repairs loudly.
        }
      }
      this.lines = lines;
      return records;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`pending-work: cannot read ${this.path} (${detail})`);
      return [];
    }
  }

  private maybeCompact(): void {
    if (this.path === undefined || this.lines <= COMPACT_AT || this.open().length > 0) return;
    try {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, "", "utf8");
      renameSync(temp, this.path);
      this.lines = 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`pending-work: cannot compact ${this.path} (${detail})`);
    }
  }
}
