/**
 * What is broken right now, how many times, and whose task it is (INV-1741).
 *
 * Failures were scattered: an error event in the Activity feed, a line in the audit, a job end
 * the next turn read, a receipt the outbox gave up on, a routine's run history. None of them
 * answered the question a person arrives with — what broke, how often, for which task — and none
 * had a Retry: a person had to find the conversation and type `/retry`.
 *
 * This is the one list. Five sources write into it — a turn that threw (provider, tool, spend
 * line, a 429 the retries could not outlast), a job the turn let go of that ended badly, a host
 * message the outbox could not get into a chat, a routine run that failed, the box not answering —
 * and each also says when the same thing succeeded, which resolves the entry. The same failure
 * for the same task (or conversation) with the same kind of reason is one entry with a count, so
 * a command failing ten times is one line that says 10, not ten lines.
 *
 * A person acts on an entry three ways: Retry (each kind through its own path, `retryException`),
 * Hand to me (it becomes a decision on the attention strip, attention.ts), or Dismiss. Only a
 * delivery and a routine are ever retried without a person — the outbox's own backoff and the
 * scheduler's (outbox.ts, schedule.ts) — because a turn or a command failing is the agent's to
 * judge, and a second unasked-for turn on top of one that just went wrong is not help.
 *
 * Append-only and replayed, like the other ledgers; resolved entries stay readable for seven days,
 * which is what the history half of the view shows, and then fall off.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyFailure } from "./failure-taxonomy.ts";
import { appendLine, type LedgerKind } from "./jsonl.ts";

/** A window on what failed lately: resolved entries older than a week are meant to go. */
export const LEDGER_KIND: LedgerKind = "feed";

export const EXCEPTION_KINDS = ["turn", "job", "delivery", "routine", "box"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** How long a resolved entry stays on the view's history. */
export const KEEP_RESOLVED_MS = 7 * 24 * 60 * 60_000;
/** Rewrite the file once it holds this many lines. */
const COMPACT_AT = 2_000;

export interface ExceptionEntry {
  /** This episode of the failure: a new id when the same thing breaks again after it was resolved. */
  id: string;
  kind: ExceptionKind;
  agent?: string;
  conversation?: string;
  task?: string;
  /** What failed: the conversation of a turn, a job's command, a delivery's chat, a routine's slug, the box. */
  subject: string;
  /** The latest reason, cut short. */
  reason: string;
  /** How many times it failed in this episode. */
  attempt: number;
  firstAt: string;
  at: string;
  resolvedAt?: string;
  resolution?: "succeeded" | "dismissed";
  resolvedBy?: string;
  /** Handed to a person (Hand to me): a decision on the attention strip until resolved. */
  handedAt?: string;
  handedBy?: string;
  retriedAt?: string;
  retriedBy?: string;
}

export interface Failure {
  kind: ExceptionKind;
  agent?: string;
  conversation?: string;
  task?: string;
  subject: string;
  reason: string;
}

type Line =
  | ({ e: "failed"; key: string; at: string } & Failure)
  | { e: "resolved"; key: string; at: string; how: "succeeded" | "dismissed"; by?: string }
  | { e: "handed" | "retried"; key: string; at: string; by: string };

const cut = (text: string, n = 300) => text.replace(/\s+/g, " ").trim().slice(0, n);

/** What makes two failures the same one: the kind, whose, for which task or conversation, on what, and the kind of reason. */
export function exceptionKey(failure: Omit<Failure, "reason"> & { reason: string }): string {
  return [failure.kind, failure.agent ?? "", failure.task ?? failure.conversation ?? "", failure.subject, classifyFailure(failure.reason)].join("\u0000");
}

const episodeId = (key: string, at: string) => `x${createHash("sha256").update(`${key}\u0000${at}`).digest("hex").slice(0, 12)}`;

export class ExceptionLedger {
  private lines = 0;

  constructor(
    private readonly path: string,
    private readonly options: {
      now?: () => Date;
      /** The live task an agent is doing in a conversation, so an entry is grouped under it. */
      taskOf?: (agentId: string, conversation: string) => string | undefined;
    } = {}
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** It failed (again). Returns the entry as it now stands. */
  failed(failure: Failure): ExceptionEntry {
    const task = failure.task ?? (failure.agent !== undefined && failure.conversation !== undefined ? this.options.taskOf?.(failure.agent, failure.conversation) : undefined);
    const line = { ...failure, ...(task !== undefined ? { task } : {}), reason: cut(failure.reason) };
    const key = exceptionKey(line);
    this.append({ e: "failed", key, at: this.now().toISOString(), ...line });
    return this.byKey(key)!;
  }

  /** The same entry failed again — a Retry that did not work counts on it, whatever its reason now says. */
  failedAgain(id: string, reason: string): ExceptionEntry | undefined {
    const entry = this.get(id);
    if (entry === undefined) return undefined;
    const failure = { kind: entry.kind, subject: entry.subject, reason: cut(reason), ...(entry.agent !== undefined ? { agent: entry.agent } : {}), ...(entry.conversation !== undefined ? { conversation: entry.conversation } : {}), ...(entry.task !== undefined ? { task: entry.task } : {}) };
    this.append({ e: "failed", key: this.keyOf(entry), at: this.now().toISOString(), ...failure });
    return this.get(id);
  }

  /**
   * The same thing worked: every open entry it matches is resolved. A job matches by its command
   * in its conversation; a turn by its conversation; a delivery by its chat; a routine by its slug.
   */
  succeeded(match: { kind: ExceptionKind; subject: string; agent?: string; conversation?: string }): ExceptionEntry[] {
    const open = this.list().filter(entry =>
      entry.resolvedAt === undefined && entry.kind === match.kind && entry.subject === match.subject &&
      (match.agent === undefined || entry.agent === match.agent) && (match.conversation === undefined || entry.conversation === match.conversation)
    );
    for (const entry of open) this.append({ e: "resolved", key: this.keyOf(entry), at: this.now().toISOString(), how: "succeeded" });
    return open.map(entry => this.get(entry.id)!);
  }

  dismiss(id: string, by: string): ExceptionEntry | undefined {
    return this.act(id, key => ({ e: "resolved", key, at: this.now().toISOString(), how: "dismissed", by }));
  }

  hand(id: string, by: string): ExceptionEntry | undefined {
    return this.act(id, key => ({ e: "handed", key, at: this.now().toISOString(), by }));
  }

  retried(id: string, by: string): ExceptionEntry | undefined {
    return this.act(id, key => ({ e: "retried", key, at: this.now().toISOString(), by }));
  }

  get(id: string): ExceptionEntry | undefined {
    return this.replay().episodes.find(entry => entry.id === id);
  }

  /** Open entries, then the last week's resolved ones; newest first within each. */
  list(): ExceptionEntry[] {
    const since = this.now().getTime() - KEEP_RESOLVED_MS;
    const kept = this.replay().episodes.filter(entry => entry.resolvedAt === undefined || Date.parse(entry.resolvedAt) >= since);
    return kept.sort((a, b) => Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) || b.at.localeCompare(a.at));
  }

  private act(id: string, line: (key: string) => Line): ExceptionEntry | undefined {
    const entry = this.get(id);
    if (entry === undefined || entry.resolvedAt !== undefined) return entry;
    this.append(line(this.keyOf(entry)));
    return this.get(id);
  }

  private keyOf(entry: ExceptionEntry): string {
    return this.replay().keyOf.get(entry.id)!;
  }

  private byKey(key: string): ExceptionEntry | undefined {
    return this.replay().current.get(key);
  }

  private replay(): { episodes: ExceptionEntry[]; current: Map<string, ExceptionEntry>; keyOf: Map<string, string> } {
    const episodes: ExceptionEntry[] = [];
    const current = new Map<string, ExceptionEntry>();
    const keyOf = new Map<string, string>();
    if (!existsSync(this.path)) return { episodes, current, keyOf };
    let count = 0;
    for (const raw of readFileSync(this.path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      count += 1;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // A torn last line is what a crash leaves; skipping it is the recovery.
      }
      const open = current.get(line.key);
      if (line.e === "failed") {
        if (open !== undefined && open.resolvedAt === undefined) {
          Object.assign(open, { attempt: open.attempt + 1, at: line.at, reason: line.reason, ...(line.task !== undefined ? { task: line.task } : {}) });
          continue;
        }
        const entry: ExceptionEntry = {
          id: episodeId(line.key, line.at), kind: line.kind, subject: line.subject, reason: line.reason, attempt: 1, firstAt: line.at, at: line.at,
          ...(line.agent !== undefined ? { agent: line.agent } : {}),
          ...(line.conversation !== undefined ? { conversation: line.conversation } : {}),
          ...(line.task !== undefined ? { task: line.task } : {}),
        };
        episodes.push(entry);
        current.set(line.key, entry);
        keyOf.set(entry.id, line.key);
        continue;
      }
      if (open === undefined || open.resolvedAt !== undefined) continue;
      if (line.e === "resolved") Object.assign(open, { resolvedAt: line.at, resolution: line.how, ...(line.by !== undefined ? { resolvedBy: line.by } : {}) });
      else if (line.e === "handed") Object.assign(open, { handedAt: line.at, handedBy: line.by });
      else Object.assign(open, { retriedAt: line.at, retriedBy: line.by });
    }
    this.lines = count;
    return { episodes, current, keyOf };
  }

  private append(line: Line): void {
    appendLine(this.path, JSON.stringify(line));
    this.lines += 1;
    if (this.lines >= COMPACT_AT) this.compact();
  }

  /** Rewrites the file as what the view still shows: open entries and the last week's resolved ones. */
  compact(): void {
    const { episodes, keyOf } = this.replay();
    const since = this.now().getTime() - KEEP_RESOLVED_MS;
    const kept: string[] = [];
    for (const entry of episodes) {
      if (entry.resolvedAt !== undefined && Date.parse(entry.resolvedAt) < since) continue;
      const key = keyOf.get(entry.id)!;
      const failure = { kind: entry.kind, subject: entry.subject, reason: entry.reason, ...(entry.agent !== undefined ? { agent: entry.agent } : {}), ...(entry.conversation !== undefined ? { conversation: entry.conversation } : {}), ...(entry.task !== undefined ? { task: entry.task } : {}) };
      // The count survives as that many failed lines; the first keeps the episode's id.
      kept.push(JSON.stringify({ e: "failed", key, at: entry.firstAt, ...failure }));
      for (let n = 1; n < entry.attempt; n++) kept.push(JSON.stringify({ e: "failed", key, at: entry.at, ...failure }));
      if (entry.handedAt !== undefined) kept.push(JSON.stringify({ e: "handed", key, at: entry.handedAt, by: entry.handedBy }));
      if (entry.retriedAt !== undefined) kept.push(JSON.stringify({ e: "retried", key, at: entry.retriedAt, by: entry.retriedBy }));
      if (entry.resolvedAt !== undefined) kept.push(JSON.stringify({ e: "resolved", key, at: entry.resolvedAt, how: entry.resolution, ...(entry.resolvedBy !== undefined ? { by: entry.resolvedBy } : {}) }));
    }
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, kept.map(line => `${line}\n`).join(""), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.lines = kept.length;
  }
}

/** A job the watch saw end (job-watch.ts): a failure on a non-zero exit, a kill or an unknown exit; else a success. */
export function noteJobEnd(ledger: ExceptionLedger, job: { agentId: string; conversation: string; command: string }, end: { exit_code?: number; interrupted?: boolean; killed?: boolean; tail: string }): void {
  const failed = end.killed === true || end.interrupted === true || (end.exit_code !== undefined && end.exit_code !== 0);
  const where = { agent: job.agentId, conversation: job.conversation, subject: job.command.slice(0, 500) };
  if (!failed) { ledger.succeeded({ kind: "job", ...where }); return; }
  const how = end.killed === true ? "timed out: stopped at the time limit" : end.interrupted === true ? "exit unknown (the box daemon restarted)" : `exit code ${end.exit_code}`;
  const last = end.tail.trim().split("\n").at(-1)?.trim() ?? "";
  ledger.failed({ kind: "job", ...where, reason: last === "" ? how : `${how}: ${last}` });
}

/**
 * A turn ended (orchestrator.ts): thrown is a failure, finished resolves the conversation's turn entry.
 * A turn every message of which is background — a routine's, a job's wake — is counted by its own
 * source, so one failure is not two lines.
 */
export function noteTurnEnd(ledger: ExceptionLedger, agentId: string, conversation: string, inbound: readonly { lane?: string }[], error?: unknown): void {
  try {
    if (error === undefined) { ledger.succeeded({ kind: "turn", subject: conversation, agent: agentId, conversation }); return; }
    if (inbound.length > 0 && inbound.every(message => message.lane === "background")) return;
    ledger.failed({ kind: "turn", agent: agentId, conversation, subject: conversation, reason: error instanceof Error ? error.message : String(error) });
  } catch (failure) {
    console.error(`[exceptions] ${failure instanceof Error ? failure.message : String(failure)}`); // bookkeeping never fails a turn
  }
}

/** A routine run ended (schedule.ts): failed counts, done or partial resolves. */
export function noteRoutineEnd(ledger: ExceptionLedger, slug: string, agent: string, result: string | undefined, reason: string | undefined): void {
  if (result === "failed") ledger.failed({ kind: "routine", agent, subject: slug, reason: reason ?? "the run failed" });
  else ledger.succeeded({ kind: "routine", subject: slug });
}

/** What each kind of Retry needs, injected so each path is the one its source already has. */
export interface RetryDeps {
  /** Opens a fresh turn in the conversation that failed, saying what failed and who asked. */
  rerunTurn: (agentId: string, conversation: string, note: string) => Promise<void>;
  /**
   * Runs the command again in the agent's own shell session for that conversation; resolves to its
   * exit code, or `running` when it outlived the window and the job watch has it now.
   */
  rerunCommand: (agentId: string, conversation: string, command: string) => Promise<{ exit_code?: number; running?: boolean; tail?: string }>;
  /** Tries the chat's pending messages once more; how many went. */
  redeliver: (chatKey: string) => Promise<{ tried: number; sent: number }>;
  /** Runs the routine now, by hand. */
  runRoutine: (slug: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Asks the box again, reconnecting when it does not answer. */
  reconnectBox: () => Promise<{ connected: boolean; detail: string }>;
}

export type RetryOutcome = { ok: true; detail: string; resolved?: boolean } | { ok: false; detail: string };

/** Retry, each kind by its own path; the ledger is told how it came out where the answer is already known. */
export async function retryException(ledger: ExceptionLedger, id: string, by: string, deps: RetryDeps): Promise<RetryOutcome> {
  const entry = ledger.get(id);
  if (entry === undefined) return { ok: false, detail: "no such entry" };
  if (entry.resolvedAt !== undefined) return { ok: false, detail: "already resolved" };
  ledger.retried(id, by);
  const failed = (reason: string): RetryOutcome => {
    ledger.failedAgain(id, reason);
    return { ok: false, detail: reason };
  };
  const resolved = (detail: string): RetryOutcome => {
    ledger.succeeded({ kind: entry.kind, subject: entry.subject, ...(entry.agent !== undefined ? { agent: entry.agent } : {}), ...(entry.conversation !== undefined ? { conversation: entry.conversation } : {}) });
    return { ok: true, detail, resolved: true };
  };
  try {
    switch (entry.kind) {
      case "turn": {
        if (entry.agent === undefined || entry.conversation === undefined) return { ok: false, detail: "the entry names no conversation" };
        // Not awaited: a turn is minutes long, and its own end resolves the entry (or counts it again).
        void deps.rerunTurn(entry.agent, entry.conversation, `[host] Your last turn here failed (${entry.attempt} time${entry.attempt === 1 ? "" : "s"}): ${entry.reason}\n${by} asked for it to be tried again. Pick up the request you were working on from where it stands; check what already happened before repeating anything outside the box.`).catch(() => undefined);
        return { ok: true, detail: "a new turn was started" };
      }
      case "job": {
        if (entry.agent === undefined || entry.conversation === undefined) return { ok: false, detail: "the entry names no conversation" };
        const ran = await deps.rerunCommand(entry.agent, entry.conversation, entry.subject);
        if (ran.running === true) return { ok: true, detail: "running; the entry is settled when it ends" };
        if (ran.exit_code === 0) return resolved("the command succeeded");
        const last = (ran.tail ?? "").trim().split("\n").at(-1)?.trim() ?? "";
        return failed(`exit code ${ran.exit_code ?? "unknown"}${last !== "" ? `: ${last}` : ""}`);
      }
      case "delivery": {
        const sent = await deps.redeliver(entry.subject);
        if (sent.tried === 0) return resolved("nothing was left to send");
        return sent.sent === sent.tried ? resolved(`${sent.sent} message${sent.sent === 1 ? "" : "s"} sent`) : { ok: false, detail: `${sent.tried - sent.sent} of ${sent.tried} still not sent` };
      }
      case "routine": {
        const run = await deps.runRoutine(entry.subject);
        return run.ok ? { ok: true, detail: "the routine is running" } : { ok: false, detail: run.reason };
      }
      case "box": {
        const box = await deps.reconnectBox();
        return box.connected ? resolved(box.detail) : failed(box.detail);
      }
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** Entries grouped by task for the view: each task's group, then the ones with no task, by kind. */
export function groupExceptions(entries: readonly ExceptionEntry[], titleOf: (taskId: string) => string | undefined): { task?: string; title: string; open: number; entries: ExceptionEntry[] }[] {
  const groups = new Map<string, { task?: string; title: string; open: number; entries: ExceptionEntry[] }>();
  for (const entry of entries) {
    const key = entry.task !== undefined ? `task:${entry.task}` : `kind:${entry.kind}`;
    const group = groups.get(key) ?? { ...(entry.task !== undefined ? { task: entry.task } : {}), title: entry.task !== undefined ? `${entry.task}: ${titleOf(entry.task) ?? ""}`.replace(/: $/, "") : entry.kind, open: 0, entries: [] };
    group.entries.push(entry);
    if (entry.resolvedAt === undefined) group.open += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.open - a.open || Number(b.task !== undefined) - Number(a.task !== undefined));
}
