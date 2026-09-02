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

import { envNumber } from "../config.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/**
 * What a model call was for. Four, because that is how many kinds of call exist.
 *
 * `turn` is the agent thinking. The other three are the harness keeping house around it.
 */
export type UsageKind = "turn" | "summarize" | "memory" | "select" | "review";

/** What a row with no kind is reported as. Not a kind: the absence of one. */
export const UNATTRIBUTED = "unattributed";

export interface UsageRecord {
  /** Monotonic within this file. What a collector remembers instead of a time. */
  seq: number;
  at: string;
  agentId: string;
  agentName: string;
  /**
   * The piece of work this call belongs to, stable across every resume of it.
   *
   * The field that was missing. Everything worth asking about long work is a join — what did
   * this task cost, which turn was the expensive one, what does a fetch-and-summarise usually
   * run to — and there was nothing to join on: a row carried an agent and a timestamp, so the
   * only available answer was "same agent, near in time", which is a guess.
   *
   * Not `turnId`, which is minted per attempt (`turn.ts`) and would split one long piece of
   * work into as many rows-groups as it had crashes. Optional because rows written before the
   * field existed keep replaying, and they should read as unattributed rather than as a group.
   */
  workId?: string;
  /** Which thread it ran in. A fork child has its own, which is what makes one costable. */
  conversation?: string;
  /**
   * The attempt, as opposed to the work — and the key the task board already writes down.
   *
   * `workId` is the right thing to *group* by and the wrong thing to join a task on: every
   * change on the board records the turn it was made in (`TaskChange.run`), and that is a
   * turn id. Without this column the board's own record pointed at nothing, which is why
   * "of 46 tasks, zero can be costed" was true while both files were full of numbers.
   */
  turnId?: string;
  /**
   * What the call was for.
   *
   * The turn loop is one kind of spend and the bookkeeping around it is another: summarising a
   * history, extracting a memory, choosing which memories to show. Those run on the cheap
   * profile and are individually trivial, which is exactly why a grand total says nothing
   * about whether any of them is worth changing.
   *
   * Absent on rows written before the field existed. Those read as `unattributed` rather than
   * being folded into `turn`, because folding them would make the first day after this ships
   * look like a jump in turn cost that never happened.
   */
  kind?: UsageKind;
  /**
   * Who this spend is on behalf of — the principal id of whoever drove the turn.
   * Absent for work no person triggered directly: a teammate's wake, a scheduled run.
   * This is what makes "what did each person cost" answerable.
   */
  principal?: string;
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
const COMPACT_AT = envNumber("AGENTBOX_USAGE_COMPACT_AT", 20_000);
const KEEP_ON_COMPACT = envNumber("AGENTBOX_USAGE_KEEP", 5_000);
/**
 * How far back compaction always keeps records, whatever the count.
 *
 * Because the rolling budget is summed from this file. Two days covers the 24-hour default budget
 * window with room to spare, so a record still inside the window is never dropped.
 */
const RETAIN_MS = envNumber("AGENTBOX_USAGE_RETAIN_HOURS", 48) * 3_600_000;

export class UsageLog {
  private nextSeq = 1;
  private lines = 0;
  /**
   * Why the numbers here cannot be trusted, once something has gone wrong with the file.
   *
   * A swallowed write means spend happened and was not counted; a failed read means the total is
   * unknown. Both used to come back as zero, which a budget cannot tell from "nothing spent" — so
   * the one condition under which a ceiling matters most was the one that removed it. Sticky for
   * the life of the process: a write that failed is not un-failed by a later one succeeding, and
   * the records it lost are gone.
   */
  private unavailableReason: string | undefined;

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
      // Sticky, like a write failure: if the file existed but could not be read at startup, spend
      // cannot be measured, and the very first budget check must not read that as "nothing spent".
      this.unavailableReason ??= `the usage log could not be read at startup (${detail})`;
      this.onWarn(`usage: cannot read ${this.path} (${detail}); numbering restarts`);
    }
  }

  record(entry: Omit<UsageRecord, "seq" | "at">, now = new Date()): UsageRecord {
    const full: UsageRecord = { seq: this.nextSeq++, at: now.toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(full));
      this.lines++;
      if (this.lines > COMPACT_AT) this.compact();
    } catch (error) {
      // Never fail a turn over accounting. A lost record is a billing question; a failed turn is
      // the user's work.
      const detail = error instanceof Error ? error.message : String(error);
      this.unavailableReason ??= `a usage record could not be written (${detail})`;
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
    } catch (error) {
      // A whole-file read failure, not a torn line — those are skipped per line above and are the
      // normal cost of append-only.
      const detail = error instanceof Error ? error.message : String(error);
      this.unavailableReason ??= `the usage log could not be read (${detail})`;
      this.onWarn(`usage: cannot read ${this.path} (${detail})`);
      return [];
    }
  }

  /**
   * Why spend cannot be measured, or `undefined` when it can.
   *
   * Exists so a budget can refuse rather than fail open. Returning a number would have meant
   * inventing one, and every number here is either a lie or a licence to spend.
   */
  unavailable(): string | undefined {
    return this.unavailableReason;
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

  /** One person's total billed tokens since a moment — for the per-principal cap. */
  spentSincePrincipal(sinceMs: number, principalId: string): number {
    let total = 0;
    for (const record of this.since(0, Number.MAX_SAFE_INTEGER)) {
      if ((record.principal ?? "") !== principalId) continue;
      const at = Date.parse(record.at ?? "");
      if (!Number.isNaN(at) && at < sinceMs) continue;
      total +=
        record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    }
    return total;
  }

  /**
   * One agent's total billed tokens since a moment — for the per-agent allowance.
   *
   * The unit a person actually reasons about when they say "give it a daily budget and
   * let it decide inside that": the budget belongs to the worker, not to the human who
   * happened to ask, and not to the whole box. Without this the only ceilings were
   * box-wide and per-person, so an agent could not be given room of its own.
   */
  spentSinceAgent(sinceMs: number, agentId: string): number {
    let total = 0;
    for (const record of this.since(0, Number.MAX_SAFE_INTEGER)) {
      if (record.agentId !== agentId) continue;
      const at = Date.parse(record.at ?? "");
      if (!Number.isNaN(at) && at < sinceMs) continue;
      total +=
        record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    }
    return total;
  }

  /**
   * Whether anything has been dropped from the front of this file.
   *
   * Inferred rather than recorded: sequence numbers start at one and survive restarts, so a
   * file whose first record is not `seq: 1` has lost its beginning. No new state to keep in
   * sync, and it stays true for a file compacted by a build that never knew about this.
   */
  compacted(): boolean {
    const first = this.since(0, 1)[0];
    return first !== undefined && first.seq !== 1;
  }

  /** Totals over what is still in the file. Not a billing figure: compaction drops the tail. */
  totals(afterSeq = 0): UsageTotals {
    return this.sum(this.since(afterSeq, Number.MAX_SAFE_INTEGER));
  }

  /**
   * Spend since a moment, broken out by the person it was on behalf of.
   *
   * Work no person triggered directly — a teammate's wake, a scheduled run — is
   * grouped under an empty principal, so nothing is dropped and the parts sum to the
   * whole. This is the "what did each person cost" the framework asks for.
   */
  byPrincipalSince(sinceMs: number): { principal: string; totals: UsageTotals }[] {
    const groups = new Map<string, UsageRecord[]>();
    for (const record of this.since(0, Number.MAX_SAFE_INTEGER)) {
      const at = Date.parse(record.at ?? "");
      if (!Number.isNaN(at) && at < sinceMs) continue;
      const key = record.principal ?? "";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(record);
    }
    return [...groups.entries()]
      .map(([principal, records]) => ({ principal, totals: this.sum(records) }))
      .sort((a, b) => b.totals.outputTokens - a.totals.outputTokens);
  }

  /**
   * Spend broken out by what the call was for.
   *
   * The question this answers that a grand total cannot: the housekeeping calls are cheap and
   * frequent, so a day that reads as expensive is either an agent doing a lot of thinking or a
   * compaction loop, and those want completely different responses.
   */
  byKind(sinceMs = 0): { kind: string; totals: UsageTotals }[] {
    const groups = new Map<string, UsageRecord[]>();
    for (const record of this.since(0, Number.MAX_SAFE_INTEGER)) {
      const at = Date.parse(record.at ?? "");
      if (!Number.isNaN(at) && at < sinceMs) continue;
      const key = record.kind ?? UNATTRIBUTED;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(record);
    }
    return [...groups.entries()]
      .map(([kind, records]) => ({ kind, totals: this.sum(records) }))
      .sort((a, b) => b.totals.outputTokens - a.totals.outputTokens);
  }

  /**
   * Bills one call that is not the agent thinking.
   *
   * The turn loop writes its own row with everything it knows; this is for the three calls
   * around the edges, which know their model and their tokens and little else. It exists so
   * that "what did the model cost" stops meaning "what did the turn loop cost", which is what
   * it silently meant while these three were unmetered.
   *
   * `principal` was missing here while the turn rows carried it, so summarisation, memory
   * and selection spend for a person's work landed in the unattributed group: a
   * per-principal total was the turn's cost and not the work's. Found by the identity-box
   * review, which had been told this attribution already worked.
   */
  recordAside(options: {
    kind: UsageKind;
    agentId: string;
    agentName: string;
    provider: string;
    model: string;
    usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    workId?: string;
    conversation?: string;
    /** Who this is on behalf of. Absent when nobody drove it — a wake, a scheduled run. */
    principal?: string;
  }): void {
    this.record({
      kind: options.kind,
      agentId: options.agentId,
      agentName: options.agentName,
      provider: options.provider,
      model: options.model,
      // Not a round of anything: these calls sit outside the loop that counts rounds.
      round: 0,
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
      ...(options.principal !== undefined ? { principal: options.principal } : {}),
      inputTokens: options.usage.input_tokens ?? 0,
      outputTokens: options.usage.output_tokens ?? 0,
      cacheReadTokens: options.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: options.usage.cache_creation_input_tokens ?? 0,
    });
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

  /**
   * Rewrites the file with its tail. Temp plus rename, so a reader never sees half a file.
   *
   * Keeps the last `KEEP_ON_COMPACT` records *and* everything newer than a retention horizon,
   * whichever is larger. The horizon matters: the rolling budget is measured from this file, and
   * dropping records that are still inside the budget window would make a box that spent its whole
   * budget in a burst read as having spent almost nothing right afterwards — the ceiling stops
   * applying exactly when it should bite. Two days comfortably covers the 24-hour default window.
   */
  private compact(now = Date.now()): void {
    try {
      const all = this.since(0, Number.MAX_SAFE_INTEGER);
      const horizon = now - RETAIN_MS;
      const byCount = all.slice(-KEEP_ON_COMPACT);
      const oldestKept = byCount.length > 0 ? Date.parse(byCount[0]!.at) : now;
      // If the count-tail already reaches past the horizon, it is enough; otherwise widen to the
      // horizon so no in-window record is lost.
      const kept =
        Number.isFinite(oldestKept) && oldestKept <= horizon
          ? byCount
          : all.filter((record, index) => index >= all.length - KEEP_ON_COMPACT || Date.parse(record.at) >= horizon);
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
