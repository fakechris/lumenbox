/**
 * What one agent may spend on the model (INV-1615): a line for the day and a line for one wake.
 *
 * On 2026-11-04 a turn ran to its 59th round at 80–100k tokens a round and nothing stepped in
 * until the plan was exhausted. The limits that existed were about something else: the box's jobs
 * and memory (INV-1557), what an agent pushes to people (INV-1576), one turn's number of calls
 * (INV-1354), the installation's forecast line (INV-1612). None was "this agent has spent enough
 * today". So every agent has two lines, in the currency the configured rates use:
 *
 *   - **per wake**: at 80% the next tool result says so; at 100% the turn ends at the round
 *     boundary and hands its progress back, the way the call budget does.
 *   - **per day**: at 80% the same reminder; at 100% the agent is paused — the durable pause a
 *     person would use (INV-1554), with the reason on the record — the admins are told once, and
 *     the next local day it is resumed, unless a person did first.
 *
 * Priced with the same `priceOf` every report uses. A model with no rate cannot be priced, so its
 * tokens count toward a separate token line and the reminder names the model: a line nobody can
 * price is a line nobody can tune, and silence would be the old failure again. Those tokens are
 * counted as fresh-input equivalents: a cache read at a tenth, which is what providers charge
 * for one. Counted at full weight, a 90k-token context re-read each round crossed half a
 * million in six rounds and ended ordinary turns (2026-11-05, 0.3.19). Settings live in
 * one ledger beside the push budget's, so a restart keeps them.
 *
 * A wake is one turn, named by its `turnId`, and an agent can have several at once: a member's
 * turn and a guest's (INV-1708), or a guest answer's review (INV-1721), record rows for the same
 * agent in between each other. One "current wake" per agent let each reset the other to zero, so
 * neither line could be reached (INV-1735). Each turn keeps its own total; the totals live in a
 * map bounded by recency, so a turn that has ended is dropped once enough others have spoken.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine, appendLineDurably } from "./jsonl.ts";
import { priceOf, type Priceable, type Rates } from "./spend.ts";

export interface SpendLimitConfig {
  /** The day's line, in the rates' currency. */
  perDay: number;
  /** One wake's line, in the rates' currency. */
  perWake: number;
  /** The day's line for models the rates cannot price, in fresh-input-equivalent tokens (a cache read counts a tenth). */
  perDayTokens: number;
  /** One wake's line for unpriced models, in the same tokens. */
  perWakeTokens: number;
}

export const DEFAULT_SPEND_LIMITS: SpendLimitConfig = { perDay: 20, perWake: 2, perDayTokens: 30_000_000, perWakeTokens: 2_000_000 };
/** What a cache read weighs against a fresh input token in the unpriced line. */
export const CACHE_READ_WEIGHT = 0.1;

/** Where the reminder goes out, once per line per day or per wake. */
const WARN_AT = 0.8;
/** How many turns' totals are kept at once, across agents; the least recently charged goes first. */
export const OPEN_WAKES = 256;

export interface SpendRow extends Priceable {
  agentId: string;
  agentName: string;
  turnId?: string;
  /** A rejected or failed call carries no spend; only successful rows count (the usage ledger marks the rest). */
  rejection?: string;
}

export interface SpendToday {
  day: string;
  spent: number;
  /** Conservative allowance held for unreported failed calls; not invoiced spend. */
  reserved: number;
  unpricedTokens: number;
  unpricedModels: string[];
  limits: SpendLimitConfig;
  /** Paused by this module today, and when. */
  pausedAt?: string;
}

/** What a turn does with one more row. */
export type SpendVerdict =
  | { kind: "ok" }
  | { kind: "warn"; text: string }
  | { kind: "hit_wake"; report: string }
  | { kind: "hit_day"; report: string; enforce: () => Promise<void> };

export interface SpendLimitDeps {
  /** Today's rows from the usage ledger, so a restart does not forget the morning. */
  ledger: () => readonly SpendRow[];
  rates: () => Rates;
  /** The durable pause (INV-1554). */
  pause: (agentId: string, reason: string) => Promise<unknown>;
  resume: (agentId: string, by: string) => Promise<unknown>;
  /** Whether a person has since resumed the agent: then the day's end is not ours to act on. */
  isPaused: (agentId: string) => boolean;
  /** Tells the admins, once per pause. */
  notify: (text: string) => void;
  nameOf: (agentId: string) => string;
  log: (line: string) => void;
  now?: () => Date;
}

type LedgerLine =
  | { kind: "limits"; at: string; agentId: string; limits: Partial<SpendLimitConfig> | null }
  | { kind: "paused"; at: string; agentId: string; day: string }
  | { kind: "resumed"; at: string; agentId: string; day: string }
  | { kind: "reservation"; at: string; row: SpendRow };

interface Tally { day: string; spent: number; reserved: number; unpricedTokens: number; unpricedModels: Set<string>; warnedDay: boolean; pausedAt?: string }
interface WakeTally { spent: number; reserved: number; unpricedTokens: number; unpricedModels: Set<string>; warned: boolean }

const PAUSE_BY = "LumenBox (spend limit)";

/** The local calendar day, the same day the briefings and the push budget use. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function money(amount: number): string {
  return amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);
}

function tokens(count: number): string {
  return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M tokens` : `${Math.round(count / 1_000)}k tokens`;
}

export class SpendLimits {
  private readonly limits = new Map<string, Partial<SpendLimitConfig>>();
  private readonly days = new Map<string, Tally>();
  /** Keyed by agent and turn, in order of the last row each was charged. */
  private readonly wakes = new Map<string, WakeTally>();
  private readonly pausedByUs = new Map<string, string>();
  private readonly reservations: { at: string; row: SpendRow }[] = [];
  private loadedDay: string | undefined;

  constructor(private readonly deps: SpendLimitDeps, private readonly path?: string) {
    if (path !== undefined) this.restore(path);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  limitsOf(agentId: string): SpendLimitConfig {
    return { ...DEFAULT_SPEND_LIMITS, ...(this.limits.get(agentId) ?? {}) };
  }

  /** A person sets an agent's lines; null goes back to the defaults. Each line must be a positive number. */
  setLimits(agentId: string, limits: Partial<SpendLimitConfig> | null): SpendLimitConfig {
    if (limits === null) this.limits.delete(agentId);
    else {
      for (const [key, value] of Object.entries(limits)) {
        if (!(key in DEFAULT_SPEND_LIMITS)) throw new Error(`Unknown limit ${key}`);
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
      }
      this.limits.set(agentId, { ...(this.limits.get(agentId) ?? {}), ...limits });
    }
    this.write({ kind: "limits", at: this.now().toISOString(), agentId, limits: limits === null ? null : this.limits.get(agentId) ?? {} });
    return this.limitsOf(agentId);
  }

  /** Today's spend against today's lines, for the page. */
  today(agentId: string): SpendToday {
    const tally = this.tallyFor(agentId);
    return { day: tally.day, spent: tally.spent, reserved: tally.reserved, unpricedTokens: tally.unpricedTokens, unpricedModels: [...tally.unpricedModels].sort(), limits: this.limitsOf(agentId), ...(tally.pausedAt !== undefined ? { pausedAt: tally.pausedAt } : {}) };
  }

  /** The agents this module paused and has not yet resumed. */
  pausedForSpend(): { agentId: string; day: string }[] {
    return [...this.pausedByUs.entries()].map(([agentId, day]) => ({ agentId, day }));
  }

  /**
   * One more successful model call. Says what the turn should do: nothing, remind once, end the
   * wake, or end the wake and pause the agent (the pause is the `enforce` the caller runs after
   * its report is on the record, so the hand-back is said before the turn is cut).
   */
  note(row: SpendRow): SpendVerdict { return this.charge(row, false); }

  /** Missing usage is not free. Hold a conservative ceiling, separately from measured billing. */
  reserveUnreported(row: SpendRow): SpendVerdict {
    this.tallyFor(row.agentId); // load before adding, so this reservation is charged once
    const held = { at: this.now().toISOString(), row };
    if (this.path !== undefined) appendLineDurably(this.path, JSON.stringify({ kind: "reservation", ...held }));
    this.reservations.push(held);
    return this.charge(row, true);
  }

  private reservationPrice(row: SpendRow): number | undefined {
    const rate = this.deps.rates()[row.model];
    return rate === undefined ? undefined : (row.inputTokens * Math.max(rate.inputPerM, rate.cacheReadPerM ?? rate.inputPerM, rate.cacheWritePerM ?? rate.inputPerM) + row.outputTokens * rate.outputPerM) / 1e6;
  }

  private charge(row: SpendRow, reservation: boolean): SpendVerdict {
    if (row.rejection !== undefined) return { kind: "ok" };
    const tally = this.tallyFor(row.agentId);
    const price = reservation ? this.reservationPrice(row) : priceOf(row, this.deps.rates());
    const wake = this.wakeFor(row.agentId, row.turnId ?? "");
    this.add(tally, row, price, reservation);
    this.add(wake, row, price, reservation);
    const limits = this.limitsOf(row.agentId);
    const name = this.deps.nameOf(row.agentId);
    const dayHit = (tally.spent + tally.reserved) >= limits.perDay || tally.unpricedTokens >= limits.perDayTokens;
    const wakeHit = (wake.spent + wake.reserved) >= limits.perWake || wake.unpricedTokens >= limits.perWakeTokens;
    if (dayHit && tally.pausedAt === undefined) {
      tally.pausedAt = this.now().toISOString();
      const report = this.report("day", name, tally, limits);
      return {
        kind: "hit_day",
        report,
        enforce: async () => {
          const reason = `spend limit: ${this.lineText("day", tally, limits)} reached on ${tally.day}`;
          this.pausedByUs.set(row.agentId, tally.day);
          this.write({ kind: "paused", at: this.now().toISOString(), agentId: row.agentId, day: tally.day });
          await this.deps.pause(row.agentId, reason);
          this.deps.notify(`${name} reached its daily spend line (${this.lineText("day", tally, limits)}) and is paused until tomorrow. Resume it or raise the line in Settings → Team → Agents.`);
          this.deps.log(`${name} paused: ${reason}`);
        },
      };
    }
    if (wakeHit) return { kind: "hit_wake", report: this.report("wake", name, wake, limits) };
    const dayWarn = !tally.warnedDay && ((tally.spent + tally.reserved) >= limits.perDay * WARN_AT || tally.unpricedTokens >= limits.perDayTokens * WARN_AT);
    const wakeWarn = !wake.warned && ((wake.spent + wake.reserved) >= limits.perWake * WARN_AT || wake.unpricedTokens >= limits.perWakeTokens * WARN_AT);
    if (dayWarn) tally.warnedDay = true;
    if (wakeWarn) wake.warned = true;
    if (dayWarn || wakeWarn) {
      const parts = [
        ...(wakeWarn ? [`this wake has spent ${this.lineText("wake", wake, limits)}; at the line the turn ends and hands back`] : []),
        ...(dayWarn ? [`today you have spent ${this.lineText("day", tally, limits)}; at the line you are paused until tomorrow`] : []),
      ];
      return { kind: "warn", text: `[host] Spend: ${parts.join("; ")}. Finish what matters most first.${this.unpricedNote(wakeWarn ? wake : tally)}` };
    }
    return { kind: "ok" };
  }

  /** A new local day: the agents paused for spend are resumed, unless a person already did. Call on a timer. */
  async sweep(): Promise<string[]> {
    const today = dayOf(this.now());
    const resumed: string[] = [];
    for (const [agentId, day] of [...this.pausedByUs.entries()]) {
      if (day === today) continue;
      this.pausedByUs.delete(agentId);
      this.write({ kind: "resumed", at: this.now().toISOString(), agentId, day });
      if (!this.deps.isPaused(agentId)) continue;
      await this.deps.resume(agentId, `${PAUSE_BY}: a new day`);
      resumed.push(agentId);
      this.deps.log(`${this.deps.nameOf(agentId)} resumed: a new day after the ${day} spend line`);
    }
    return resumed;
  }

  /** The running total of one turn, made most recent; the least recent beyond the bound is forgotten. */
  private wakeFor(agentId: string, turnId: string): WakeTally {
    const key = `${agentId}\u0000${turnId}`;
    const wake = this.wakes.get(key) ?? { spent: 0, reserved: 0, unpricedTokens: 0, unpricedModels: new Set<string>(), warned: false };
    this.wakes.delete(key);
    this.wakes.set(key, wake);
    for (const oldest of this.wakes.keys()) {
      if (this.wakes.size <= OPEN_WAKES) break;
      this.wakes.delete(oldest);
    }
    return wake;
  }

  private add(into: { spent: number; reserved: number; unpricedTokens: number; unpricedModels: Set<string> }, row: Priceable, price: number | undefined, reservation = false): void {
    if (price !== undefined) { if (reservation) into.reserved += price; else into.spent += price; }
    else {
      into.unpricedTokens += row.inputTokens + row.outputTokens + row.cacheWriteTokens + Math.round(row.cacheReadTokens * CACHE_READ_WEIGHT);
      into.unpricedModels.add(row.model);
    }
  }

  private lineText(which: "day" | "wake", of: { spent: number; reserved: number; unpricedTokens: number }, limits: SpendLimitConfig): string {
    const line = which === "day" ? limits.perDay : limits.perWake;
    const tokenLine = which === "day" ? limits.perDayTokens : limits.perWakeTokens;
    const parts = [`${money(of.spent + of.reserved)} of ${money(line)}`];
    if (of.unpricedTokens > 0) parts.push(`${tokens(of.unpricedTokens)} of ${tokens(tokenLine)} unpriced`);
    return parts.join(" and ") + (of.reserved > 0 ? ` (includes ${money(of.reserved)} reserved for unreported failed calls, not measured spend)` : "");
  }

  private unpricedNote(of: { unpricedModels: Set<string> }): string {
    return of.unpricedModels.size === 0 ? "" : ` Unpriced model${of.unpricedModels.size === 1 ? "" : "s"} (no rate in config.json, counted in tokens): ${[...of.unpricedModels].sort().join(", ")}.`;
  }

  private report(which: "day" | "wake", name: string, of: { spent: number; reserved: number; unpricedTokens: number; unpricedModels: Set<string> }, limits: SpendLimitConfig): string {
    const line = this.lineText(which, of, limits);
    return which === "wake"
      ? `I have reached my spend line for this wake (${line}), so I am stopping here and handing back what I have. Say "go on" to continue; the line is in Settings → Team → Agents.${this.unpricedNote(of)}`
      : `${name} has reached its daily spend line (${line}) and is paused until tomorrow. An admin can resume it or raise the line in Settings → Team → Agents.${this.unpricedNote(of)}`;
  }

  /** Today's running total for an agent, loaded from the ledger the first time the day is seen. */
  private tallyFor(agentId: string): Tally {
    const today = dayOf(this.now());
    if (this.loadedDay !== today) {
      this.days.clear();
      this.wakes.clear();
      this.loadedDay = today;
      const rates = this.deps.rates();
      for (const row of this.deps.ledger()) {
        if (row.rejection !== undefined) continue;
        const tally = this.blank(row.agentId, today);
        this.add(tally, row, priceOf(row, rates));
      }
      for (const held of this.reservations) {
        if (dayOf(new Date(held.at)) !== today) continue;
        const tally = this.blank(held.row.agentId, today);
        this.add(tally, held.row, this.reservationPrice(held.row), true);
        this.add(this.wakeFor(held.row.agentId, held.row.turnId ?? ""), held.row, this.reservationPrice(held.row), true);
      }
    }
    return this.blank(agentId, today);
  }

  private blank(agentId: string, day: string): Tally {
    let tally = this.days.get(agentId);
    if (tally === undefined) {
      tally = { day, spent: 0, reserved: 0, unpricedTokens: 0, unpricedModels: new Set(), warnedDay: false };
      this.days.set(agentId, tally);
    }
    return tally;
  }

  private write(line: LedgerLine): void {
    if (this.path !== undefined) appendLine(this.path, JSON.stringify(line));
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    for (const text of readFileSync(path, "utf8").split("\n")) {
      if (text.trim() === "") continue;
      try {
        const line = JSON.parse(text) as LedgerLine;
        if (line.kind === "limits") { if (line.limits === null) this.limits.delete(line.agentId); else this.limits.set(line.agentId, line.limits); }
        else if (line.kind === "paused") this.pausedByUs.set(line.agentId, line.day);
        else if (line.kind === "resumed") this.pausedByUs.delete(line.agentId);
        else if (line.kind === "reservation") this.reservations.push({ at: line.at, row: line.row });
      } catch {
        // A torn line is one setting lost, not a reason to run without any.
      }
    }
  }
}

/** The rows of today's usage ledger that this module counts: the successful ones, with their day taken from `at`. */
export function todaysRows(records: readonly (SpendRow & { at?: string })[], now: Date): SpendRow[] {
  const today = dayOf(now);
  return records.filter(record => record.at !== undefined && dayOf(new Date(record.at)) === today);
}
