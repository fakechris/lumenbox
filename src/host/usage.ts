/**
 * What a turn cost, written down.
 *
 * Every round already reported input, output and cache tokens, and nothing consumed it: no total,
 * no record, no budget. For something that spends its owner's money per token that is the gap with
 * the most consequence, and the data was already there being thrown away.
 *
 * The format is chosen for the thing that will read it, which is a collector pulling from outside
 * the box ([../docs/08-control-plane.md](../docs/08-control-plane.md) §8):
 *
 *   - Append-only JSONL, one record per round. Not aggregated in place, so a metering bug loses a
 *     report rather than the history, and totals stay queries.
 *   - A monotonic sequence number per record, so a reader remembers an offset rather than a
 *     timestamp. A collector that was down for an hour catches up; one that reads by time either
 *     double-counts or skips, depending on which way its clock is wrong.
 *   - The agent and the model on every record. Cost is per tenant in the end, but "which agent
 *     spent it" is the question actually asked, and it cannot be reconstructed later.
 *
 * Deliberately not here: prices. A record says tokens; what a token costs belongs to whoever bills,
 * changes without warning, and would be wrong in a file nobody remembers to update.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

export interface UsageRecord {
  /** Monotonic within this file. What a collector remembers instead of a time. */
  seq: number;
  at: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  /** Which round of the turn: a turn that ran long is visible as such. */
  round: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageTotals {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Kept alongside the transcripts: same lifetime, same volume, same backup. */
export function usageLogPath(): string {
  return process.env.AGENTBOX_USAGE_LOG ?? join(agentboxHome(), "usage.jsonl");
}

/**
 * Compacted at this many records, keeping the tail.
 *
 * High enough that a collector polling every few seconds never misses anything, low enough that the
 * file does not become the largest thing in the state directory. Compaction preserves sequence
 * numbers, so a reader's offset stays meaningful across it.
 */
const COMPACT_AT = Number(process.env.AGENTBOX_USAGE_COMPACT_AT ?? 20_000);
const KEEP_ON_COMPACT = Number(process.env.AGENTBOX_USAGE_KEEP ?? 5_000);

export class UsageLog {
  private nextSeq = 1;
  private lines = 0;

  constructor(
    private readonly path: string = usageLogPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.load();
  }

  /** Reads the last sequence number so numbering continues across restarts. */
  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "");
      this.lines = lines.length;
      for (let at = lines.length - 1; at >= 0; at--) {
        try {
          const record = JSON.parse(lines[at]!) as UsageRecord;
          if (typeof record.seq === "number") {
            this.nextSeq = record.seq + 1;
            return;
          }
        } catch {
          // A torn last line: keep looking backwards rather than restarting the sequence, which
          // would make two records share a number and a collector silently skip one.
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot read ${this.path} (${detail}); numbering restarts`);
    }
  }

  record(entry: Omit<UsageRecord, "seq" | "at">, now = new Date()): UsageRecord {
    const full: UsageRecord = { seq: this.nextSeq++, at: now.toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
      this.lines++;
      if (this.lines > COMPACT_AT) this.compact();
    } catch (error) {
      // Never fail a turn over accounting. A lost record is a billing question; a failed turn is
      // the user's work.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot write ${this.path} (${detail})`);
    }
    return full;
  }

  /** Records after `afterSeq`, which is how a collector catches up. */
  since(afterSeq = 0, limit = 1000): UsageRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, "utf8")
        .split("\n")
        .filter(line => line.trim() !== "")
        .flatMap(line => {
          try {
            return [JSON.parse(line) as UsageRecord];
          } catch {
            return [];
          }
        })
        .filter(record => typeof record.seq === "number" && record.seq > afterSeq)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Totals over a time window, which is what a rolling budget is actually about.
   *
   * `sinceMs` is a timestamp, not a duration, so the caller owns the clock and this stays testable.
   * A record whose `at` cannot be read counts as inside the window: dropping it would make an
   * unreadable line reduce measured spend, and a budget that fails open on bad data is worse than
   * one that occasionally refuses early.
   */
  totalsSince(sinceMs: number): UsageTotals {
    return this.sum(
      this.since(0, Number.MAX_SAFE_INTEGER).filter(record => {
        const at = Date.parse(record.at ?? "");
        return Number.isNaN(at) || at >= sinceMs;
      })
    );
  }

  /** Totals over what is still in the file. Not a billing figure: compaction drops the tail. */
  totals(afterSeq = 0): UsageTotals {
    return this.sum(this.since(afterSeq, Number.MAX_SAFE_INTEGER));
  }

  private sum(records: readonly UsageRecord[]): UsageTotals {
    return records.reduce<UsageTotals>(
      (sum, record) => ({
        records: sum.records + 1,
        inputTokens: sum.inputTokens + record.inputTokens,
        outputTokens: sum.outputTokens + record.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + record.cacheWriteTokens,
      }),
      { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    );
  }

  /** Rewrites the file with its tail. Temp plus rename, so a reader never sees half a file. */
  private compact(): void {
    try {
      const kept = this.since(0, Number.MAX_SAFE_INTEGER).slice(-KEEP_ON_COMPACT);
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.map(record => `${JSON.stringify(record)}\n`).join(""), "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
      this.onWarn(`usage: compacted to the most recent ${kept.length} records`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot compact ${this.path} (${detail})`);
    }
  }
}
