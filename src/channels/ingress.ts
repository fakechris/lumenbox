/**
 * Every message that arrived from outside, and what became of it.
 *
 * Written because a message that arrived and went nowhere left exactly the same trace as
 * a message that never arrived: none. A person reported that the bot had stopped
 * answering, and finding out why took two rounds of adding log lines and asking them to
 * send again — first to learn that the message reached the adapter at all, then to learn
 * that a bare mention had been stripped to an empty string and discarded. A second cause,
 * rich text being dropped as an unhandled type, was then visible only because those lines
 * happened to still be there.
 *
 * That should have been one `grep`. This makes it one.
 *
 * Two records per message, not one. A single record written at the point of decision
 * cannot show a message that arrived and was never decided about — an adapter that hangs
 * fetching a sender's name, a turn that never returns — and "still open" is exactly the
 * state worth seeing when somebody says nothing came back.
 *
 * Not the transcript and not the inbox. Both of those begin after a message has been
 * accepted, which is downstream of every decision that can silently drop one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine, archivedLines, archiveSettled, type LedgerKind } from "../host/jsonl.ts";

/** Settled entries beyond this and the file is rewritten as just what is unresolved. */
/**
 * What happened at the door, and it is not a queue.
 *
 * Declared because `compact()` was written as though it were one: see the method. The
 * guard in architecture-guard.test.ts requires this line and requires a `record` to
 * archive (jsonl.ts).
 */
export const LEDGER_KIND: LedgerKind = "record";

const COMPACT_AT = 500;

/** What became of a message. */
export type Fate =
  /** Handed to an agent. */
  | "admitted"
  /** The sender may not drive this installation. */
  | "refused"
  /** Discarded before it ever reached the manager, with a reason. */
  | "dropped"
  /** Heard in a room but not addressed to the bot: kept as context, no turn. */
  | "heard";

export interface Arrival {
  id: string;
  channel: string;
  identity: string;
  chatKey: string;
  /** The wire's own type, since being an unhandled one is a real reason to disappear. */
  kind: string;
  chars: number;
  /**
   * The platform's own idea of which conversation this belongs to, when it has one.
   *
   * Recorded but not yet used. A conversation here is keyed on the chat alone, so a room
   * running for days is one unbounded history and a finished topic keeps steering new
   * questions. Whether to key on the thread instead is a decision with visible
   * consequences, so the evidence is collected before it is taken.
   */
  threadId?: string;
  rootId?: string;
  chatType?: string;
  /** When it reached us. */
  at: string;
  /**
   * When the vendor says it was sent, when the wire says. The catch-up floor prefers this:
   * a replayed message "arrives" at replay time, and a floor built on that would jump past
   * everything older that the same sweep did not get to.
   */
  sentAt?: string;
}

export interface IngressRecord extends Arrival {
  fate?: Fate;
  /** Why, when the fate needs one. Absent for a plain admission. */
  reason?: string;
  settledAt?: string;
}

export function ingressPath(home: string): string {
  return join(home, "ingress.jsonl");
}

/**
 * The ledger. Append-only and read by replaying, so a process that dies mid-write leaves
 * a torn last line and nothing else — which every reader here already skips.
 */
export class Ingress {
  private settled = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** A message came in. Called before anything can decide to drop it. */
  arrived(arrival: Arrival): void {
    appendLine(this.path, JSON.stringify({ event: "arrived", arrival }));
  }

  /** What became of it. */
  decided(id: string, fate: Fate, reason?: string): void {
    appendLine(
      this.path,
      JSON.stringify({
        event: "settled",
        id,
        fate,
        ...(reason !== undefined ? { reason } : {}),
        at: new Date().toISOString(),
      })
    );
    this.settled += 1;
    if (this.settled >= COMPACT_AT) this.compact();
  }

  /**
   * Everything the live file knows, newest last.
   *
   * Live only by default, because every caller here wants the recent picture — the health
   * check's last-seen time, the sweep's floor, the operator's listing — and paying to
   * parse months of archive for those would be a good reason to stop keeping them. Ask for
   * `archived` when the question is historical; `settled()` is the one that always does.
   */
  list(options: { archived?: boolean } = {}): IngressRecord[] {
    if (!existsSync(this.path)) return [];
    const byId = new Map<string, IngressRecord>();
    let settled = 0;
    const lines = options.archived === true
      ? [...archivedLines(this.path), ...readFileSync(this.path, "utf8").split("\n")]
      : readFileSync(this.path, "utf8").split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      let record: {
        event?: string;
        arrival?: Arrival;
        id?: string;
        fate?: Fate;
        reason?: string;
        at?: string;
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.event === "arrived" && record.arrival !== undefined) {
        byId.set(record.arrival.id, { ...record.arrival });
      } else if (record.event === "settled" && record.id !== undefined) {
        const existing = byId.get(record.id);
        if (existing !== undefined) {
          existing.fate = record.fate;
          if (record.reason !== undefined) existing.reason = record.reason;
          existing.settledAt = record.at;
        }
        settled += 1;
      }
    }
    // Only live lines drive compaction; an archive that made the file look full would
    // have it compact for ever.
    if (options.archived !== true) this.settled = settled;
    return [...byId.values()];
  }

  /**
   * Whether this arrival already reached a decision, archives included.
   *
   * The one question that must never be answered from the live file alone. A `false` here
   * means the sweep replays the message, and replaying a message that was answered a month
   * ago is answering a person twice.
   */
  decidedAlready(id: string): boolean {
    const live = this.list().find(record => record.id === id);
    if (live !== undefined) return live.fate !== undefined;
    return this.list({ archived: true }).some(record => record.id === id && record.fate !== undefined);
  }

  /**
   * Messages that arrived and were never decided about.
   *
   * The question "why did nothing come back" has three different answers — it never
   * arrived, it was refused, it is still going — and this is the only one of the three
   * that no other record can show.
   */
  unresolved(): IngressRecord[] {
    return this.list().filter(record => record.fate === undefined);
  }

  /**
   * Keeps the live file to what is unresolved, and moves the rest to an archive.
   *
   * It used to drop them, on the reasoning that a settled arrival is of no further
   * interest. Two things were interested. The catch-up sweep asks "was this message
   * already decided" before replaying it, and after a compaction the answer for every
   * older message was no — a vendor replaying a week-old message would have been answered
   * twice. And the question this ledger exists for, "why did nothing come back", stopped
   * having an answer for anything past the last five hundred arrivals.
   *
   * The lines are archived as they were written rather than re-serialised, so replaying an
   * archive through `list()` reconstructs exactly what was there.
   */
  private compact(): void {
    const openIds = new Set(this.unresolved().map(record => record.id));
    const live: string[] = [];
    const settled: string[] = [];
    for (const line of this.rawLines()) {
      const id = idOf(line);
      // An unparseable line is nobody's history; it stays where it is rather than being
      // filed as a record of something.
      (id === undefined || openIds.has(id) ? live : settled).push(line);
    }
    archiveSettled(this.path, settled);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, live.map(line => `${line}\n`).join(""), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.settled = 0;
  }

  private rawLines(): string[] {
    if (!existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "");
    } catch {
      return [];
    }
  }
}

/** Which arrival a line is about, whichever kind of line it is. */
function idOf(line: string): string | undefined {
  try {
    const record = JSON.parse(line) as { event?: string; arrival?: { id?: string }; id?: string };
    if (record.event === "arrived") return record.arrival?.id;
    if (record.event === "settled") return record.id;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a catch-up sweep starts looking, from what the ledger knows.
 *
 * The rule (OpenClaw's Telegram offset store expresses the same one in update ids): never
 * pass an arrival that has not been decided. With one amendment measured on 2026-09-02:
 * an arrival from 2026-08-28 that never got a fate had pinned every sweep's floor to that
 * day, and a floor five days back with an ascending page of twenty meant the sweep read
 * the same twenty handled messages every ten minutes and never reached today. An undecided
 * arrival older than the window is a lost cause the sweep would not replay anyway, so it
 * does not hold the floor; and the floor is never older than the window itself.
 */
export function catchUpFloor(
  records: readonly IngressRecord[],
  now: number,
  windowMs: number
): string | undefined {
  if (records.length === 0) return undefined;
  const edge = now - windowMs;
  const when = (record: IngressRecord) => record.sentAt ?? record.at;
  const pending = records.find(
    record => record.fate === undefined && new Date(when(record)).getTime() >= edge
  );
  const chosen = pending !== undefined ? when(pending) : when(records[records.length - 1]!);
  const chosenMs = new Date(chosen).getTime();
  return Number.isFinite(chosenMs) && chosenMs < edge ? new Date(edge).toISOString() : chosen;
}
