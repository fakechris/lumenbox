/**
 * The client API's durable change ledger (docs/106 §4.2, docs/110 §2, INV-2213): `<home>/changes.jsonl`.
 *
 * One line per change to something a client caches — a piece of work, an agent — with a sequence
 * number that only rises, across restarts. `GET /api/v1/changes?since=<seq>` and the replay of
 * `GET /api/v1/events` read it, so a phone asleep for days, or a server restarted between two of
 * its looks, catches up by what changed instead of reloading everything. The in-memory SSE ring
 * (`sse-replay.ts`, 512 frames) is the page's and is not this.
 *
 * A line says *that* something changed, never what it now says: the type, the id, the operation,
 * when. A client fetches the resource, through the same sight every read goes through. The routing
 * fields (who asked, who holds it, which box) stay on disk to judge who may be told of a change to
 * something no longer there; they are never sent.
 *
 * A feed (jsonl.ts): kept for `RETAIN_DAYS` and at most `RETAIN_LINES` lines, the newest always.
 * A client whose `since` is older than the oldest kept line is told to reset: reload, then go on.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendLine, type LedgerKind } from "../../host/jsonl.ts";

export const LEDGER_KIND: LedgerKind = "feed";
export const CHANGES_LEDGER = "changes.jsonl";
export const RETAIN_DAYS = 30;
export const RETAIN_LINES = 200_000;

export type ChangeType = "work" | "agent";
export type ChangeOp = "upsert" | "delete";

/** A line of the ledger. `seq`, `at`, `type`, `id`, `op` are what a client is shown; the rest is for judging who may be. */
export interface ChangeLine {
  seq: number;
  at: string;
  type: ChangeType;
  id: string;
  op: ChangeOp;
  /** Work: who asked and who holds it, as of this change. */
  requester?: string;
  assigneeId?: string;
  /** Agent: its box, and a fingerprint of what a client shows of it, so a restart does not announce what did not change. */
  boxId?: string;
  print?: string;
}

export type ChangeInput = Omit<ChangeLine, "seq" | "at">;

export class ChangeLedger {
  private lines: ChangeLine[] = [];
  private head = 0;
  private readonly listeners: ((line: ChangeLine) => void)[] = [];
  private readonly closers: (() => void)[] = [];

  /** `path` undefined: memory only. */
  constructor(private readonly path: string | undefined, private readonly warn: (line: string) => void = () => {}, private readonly now: () => Date = () => new Date()) {
    if (path !== undefined && existsSync(path)) {
      for (const raw of readFileSync(path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        try {
          const line = JSON.parse(raw) as ChangeLine;
          if (Number.isSafeInteger(line.seq) && line.seq > this.head) { this.lines.push(line); this.head = line.seq; }
        } catch {
          // One torn line at the end of a crash: the sequence goes on from the last whole one.
        }
      }
    }
    this.compact();
  }

  /** The newest sequence number: what a client that is up to date holds. 0 before the first change. */
  get latest(): number { return this.head; }

  /** The oldest sequence a `since` may name and still be answered without a reset. */
  get floor(): number { return (this.lines[0]?.seq ?? this.head + 1) - 1; }

  append(input: ChangeInput): ChangeLine {
    const line: ChangeLine = { seq: this.head + 1, at: this.now().toISOString(), ...input };
    this.head = line.seq;
    this.lines.push(line);
    if (this.path !== undefined) {
      try { appendLine(this.path, JSON.stringify(line)); } catch (error) { this.warn(`changes: could not record ${line.type} ${line.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.lines.length > RETAIN_LINES * 1.25) this.compact();
    for (const listener of this.listeners) {
      try { listener(line); } catch (error) { this.warn(`changes: a listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return line;
  }

  /** Lines after `since`, oldest first; `reset` when `since` is older than what is kept, or newer than anything written. */
  after(since: number): { reset: true } | { reset: false; lines: readonly ChangeLine[] } {
    if (since < this.floor || since > this.head) return { reset: true };
    const at = this.lines.findIndex(line => line.seq > since);
    return { reset: false, lines: at < 0 ? [] : this.lines.slice(at) };
  }

  /** The newest line for each key, in order: what the agent diff starts from. */
  lastOf(type: ChangeType): Map<string, ChangeLine> {
    const last = new Map<string, ChangeLine>();
    for (const line of this.lines) if (line.type === type) last.set(line.id, line);
    return last;
  }

  onAppend(listener: (line: ChangeLine) => void): () => void {
    this.listeners.push(listener);
    return () => { const at = this.listeners.indexOf(listener); if (at >= 0) this.listeners.splice(at, 1); };
  }

  /** Told once when the server stops, so a stream reading the ledger ends with it. */
  onClose(listener: () => void): () => void {
    this.closers.push(listener);
    return () => { const at = this.closers.indexOf(listener); if (at >= 0) this.closers.splice(at, 1); };
  }

  close(): void {
    for (const closer of this.closers.splice(0)) { try { closer(); } catch { /* a stream already gone */ } }
    this.listeners.length = 0;
  }

  /** Lets the old fall off the back: older than the window, or past the line limit; the newest line always stays, so the sequence survives. */
  private compact(): void {
    const horizon = this.now().getTime() - RETAIN_DAYS * 24 * 3_600_000;
    let start = Math.max(0, this.lines.length - RETAIN_LINES);
    while (start < this.lines.length - 1 && Date.parse(this.lines[start]!.at) < horizon) start += 1;
    if (start === 0) return;
    this.lines = this.lines.slice(start);
    if (this.path === undefined) return;
    try {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, this.lines.map(line => `${JSON.stringify(line)}\n`).join(""), "utf8");
      renameSync(temp, this.path);
    } catch (error) {
      this.warn(`changes: could not compact ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
