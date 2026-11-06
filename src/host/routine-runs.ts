/**
 * What a routine did, run by run, and when it is stopped for doing it badly (INV-1665).
 *
 * The scheduler has always written `started` / `finished` / `skipped` / `observed` lines to
 * `schedules.jsonl`; nothing read them back except to learn when each routine last ran. So a
 * routine that failed every hour overnight looked, on the page, exactly like one that worked:
 * a "last ran" time. This module is the reading: the ledger folded into runs, newest first, each
 * with one word for how it came out and one line for why.
 *
 * And the consequence, which is the other half of the item: a routine that fails K times in a
 * row is held — paused by the host, with the last failure as the reason — rather than burning a
 * turn every window until a person happens to look. A hold is the host's own state, written to
 * the same ledger, not a line in the box's skill file: an agent that can write the file must not
 * be able to clear a pause the host put there by deleting it.
 *
 * Holds and skips carry a `code` as well as a sentence, so the next reason to stop a routine
 * (a credential it needs is missing, INV-1666) is another code through the same two doors —
 * `skip(slug, reason)` for one window, `hold(slug, reason)` until a person resumes it.
 *
 * The boundary, said wherever a result is shown: **done means this run ended, not that the work
 * was accepted.** A routine that wrote a wrong report and stopped cleanly is done.
 */

import { existsSync, readFileSync } from "node:fs";
import type { RunResult } from "./run-result.ts";

/** Why a routine did not run, or was stopped. `code` is for machines and tests; `text` is the line a person reads. */
export interface RoutineReason {
  code: "overlap_in_flight" | "consecutive_failures" | (string & {});
  text: string;
}

/** One line of the ledger. Append-only, like everything else durable here. */
export interface RunRecord {
  slug: string;
  at: string;
  event: "started" | "finished" | "skipped" | "observed" | "held" | "resumed" | "pause-after";
  /** On `observed`: what would have run, in one line (INV-1458). */
  would?: string;
  /** Which agent ran it. On `started` and `finished`. */
  agent?: string;
  /** Where the run reports, on `started`: the chat a person opens to see what it said. */
  deliver?: string;
  /** On `started`: fired by a person's "run now" rather than its window. */
  manual?: boolean;
  /** Tokens billed to that agent between start and finish, on `finished`. */
  tokens?: number;
  /** How long the run took, on `finished`. */
  ms?: number;
  /** How the run came out, on `finished` (INV-1404): done, partial or failed. */
  result?: RunResult;
  /** On `skipped` and `held`, and on a failed `finished`: why, in a machine word and a sentence. */
  code?: string;
  reason?: string;
  /** On `held` / `resumed`: who did it — "host" for an automatic hold, else the person. */
  by?: string;
  /** On `pause-after`: the new K. */
  pauseAfter?: number;
}

/**
 * The ledger's lines, in order. A torn last line is the normal cost of append-only: it is skipped
 * rather than refusing to start, which would make one bad byte turn every automation off.
 */
export function readRunLedger(path: string): RunRecord[] {
  if (!existsSync(path)) return [];
  const records: RunRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as RunRecord;
      if (typeof record.slug === "string" && !Number.isNaN(Date.parse(record.at))) records.push(record);
    } catch { /* torn line */ }
  }
  return records;
}

/** One run as a person reads it. */
export interface RoutineRun {
  at: string;
  outcome: RunResult | "skipped" | "observed" | "running" | "interrupted";
  reason?: string;
  code?: string;
  agent?: string;
  deliver?: string;
  manual?: boolean;
  ms?: number;
  tokens?: number;
}

export interface RoutineHold {
  at: string;
  by: string;
  code: string;
  reason: string;
}

export const DEFAULT_PAUSE_AFTER = 3;

/**
 * Folds one routine's ledger lines into runs, newest first. A `started` with no `finished` after
 * it is `running` while this process owns it and `interrupted` once a restart has passed.
 */
export function runsOf(records: readonly RunRecord[], slug: string, options: { limit?: number; running?: boolean } = {}): RoutineRun[] {
  const runs: RoutineRun[] = [];
  let open: RoutineRun | undefined;
  for (const record of records) {
    if (record.slug !== slug) continue;
    if (record.event === "started") {
      if (open !== undefined) open.outcome = "interrupted";
      open = { at: record.at, outcome: "running", ...pick(record, ["agent", "deliver", "manual"]) };
      runs.push(open);
    } else if (record.event === "finished") {
      const run = open ?? (runs.push({ at: record.at, outcome: "done" }), runs[runs.length - 1]!);
      // A finish that says nothing about its result came from a runner that did not say; it ended, which is done.
      run.outcome = record.result ?? "done";
      Object.assign(run, pick(record, ["agent", "ms", "tokens", "code", "reason"]));
      open = undefined;
    } else if (record.event === "skipped") {
      runs.push({ at: record.at, outcome: "skipped", code: record.code ?? "overlap_in_flight", reason: record.reason ?? "the previous run had not finished" });
    } else if (record.event === "observed") {
      runs.push({ at: record.at, outcome: "observed", ...(record.would !== undefined ? { reason: `would have: ${record.would}` } : {}) });
    }
  }
  if (open !== undefined && options.running !== true) open.outcome = "interrupted";
  return runs.slice(-(options.limit ?? 20)).reverse();
}

function pick<K extends keyof RunRecord>(record: RunRecord, keys: readonly K[]): Partial<Pick<RunRecord, K>> {
  const out: Partial<Pick<RunRecord, K>> = {};
  for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

/**
 * The host's holds on routines and the failure streaks that lead to them.
 *
 * A streak counts finished runs that failed, in a row; a run that ended done or partial ends it,
 * and a skip or an observation does not touch it — neither is the routine trying and failing.
 * Resuming clears both the hold and the streak, so a routine a person turned back on gets K
 * fresh tries rather than being stopped again by the first failure.
 */
export class RoutineHolds {
  private readonly streaks = new Map<string, { count: number; last?: string }>();
  private readonly holds = new Map<string, RoutineHold>();
  pauseAfter = DEFAULT_PAUSE_AFTER;

  /** Replays one ledger line; the same rules as live, so a restart lands where the process left off. */
  replay(record: RunRecord): void {
    if (record.event === "pause-after" && record.pauseAfter !== undefined) this.pauseAfter = record.pauseAfter;
    else if (record.event === "finished") this.noteFinished(record.slug, record.result, record.reason, record.at, false);
    else if (record.event === "held") this.holds.set(record.slug, { at: record.at, by: record.by ?? "host", code: record.code ?? "held", reason: record.reason ?? "" });
    else if (record.event === "resumed") this.release(record.slug);
  }

  /**
   * A run finished. Returns the hold it caused, when this failure was the K-th in a row and the
   * routine is not already held — the caller writes it down and says it.
   */
  noteFinished(slug: string, result: RunResult | undefined, reason: string | undefined, at: string, live = true): RoutineHold | undefined {
    if (result !== "failed") {
      this.streaks.delete(slug);
      return undefined;
    }
    const streak = { count: (this.streaks.get(slug)?.count ?? 0) + 1, ...(reason !== undefined ? { last: reason } : {}) };
    this.streaks.set(slug, streak);
    if (!live || this.pauseAfter <= 0 || streak.count < this.pauseAfter || this.holds.has(slug)) return undefined;
    const hold: RoutineHold = {
      at,
      by: "host",
      code: "consecutive_failures",
      reason: `failed ${streak.count} times in a row; the last: ${streak.last ?? "the run failed"}`,
    };
    this.holds.set(slug, hold);
    return hold;
  }

  /** Holds a routine for a reason of the caller's (INV-1666's missing credential is one). */
  hold(slug: string, reason: RoutineReason, at: string, by = "host"): RoutineHold {
    const hold = { at, by, code: reason.code, reason: reason.text };
    this.holds.set(slug, hold);
    return hold;
  }

  /** Clears the hold and the streak. Whether there was a hold to clear. */
  release(slug: string): boolean {
    this.streaks.delete(slug);
    return this.holds.delete(slug);
  }

  holdOf(slug: string): RoutineHold | undefined {
    return this.holds.get(slug);
  }

  streakOf(slug: string): number {
    return this.streaks.get(slug)?.count ?? 0;
  }

  all(): { slug: string; hold: RoutineHold }[] {
    return [...this.holds].map(([slug, hold]) => ({ slug, hold }));
  }
}

/** The boundary sentence that goes wherever a "done" is shown. */
export const DONE_MEANS = "Done means the run ended, not that its work was accepted.";

/** The runs as lines, for the CLI: the same list the page shows. */
export function formatRuns(slug: string, runs: readonly RoutineRun[], hold: RoutineHold | undefined): string[] {
  const lines = [`${slug}${hold !== undefined ? ` — paused by ${hold.by} ${hold.at.slice(0, 16).replace("T", " ")}: ${hold.reason}` : ""}`];
  if (runs.length === 0) lines.push("  no runs recorded");
  for (const run of runs) {
    const extra = [run.manual === true ? "by hand" : undefined, run.agent, run.ms !== undefined ? `${Math.round(run.ms / 1000)}s` : undefined].filter(Boolean).join(", ");
    lines.push(`  ${run.at.slice(0, 19).replace("T", " ")}Z  ${run.outcome.padEnd(11)}${run.reason !== undefined ? ` ${run.reason}` : ""}${extra !== "" ? `  (${extra})` : ""}`);
  }
  lines.push(`  ${DONE_MEANS}`);
  return lines;
}
