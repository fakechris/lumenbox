/**
 * A forecast of provider usage, and a door that shuts before the next call (INV-1612).
 *
 * Two different questions, kept apart on purpose:
 *
 *   - What did the calls we already made cost, at the rates configured for the spend report.
 *     That stays in spend.ts. A number baked into source would go stale and still look official.
 *   - Whether the next call should be refused because a rolling window is already at a line the
 *     operator set. That is this file. It is a forecast, not a bill, and it says so.
 *
 * The vendor's own windows start at first use (MiniMax: 5 hours, and 7 days; the 5-hour refresh
 * does not refill the week). The ledger is a rolling window ending now, and compaction keeps
 * about 48 hours by default, so a 7-day figure cannot see a full week. Both limits are named
 * in the status line rather than papered over.
 *
 * MiniMax-M3.1-Flash has one exception to "never invent a price": the China list published
 * 2026-11-04 is input 1, output 4, cache read 0.1 per million. Configured rates of 0.30 / 1.20 /
 * 0.06 understate that list. When the configured input for that model (or its Preview) is
 * missing or below 1, the forecast uses the list. Every other model stays unpriced, and an
 * unpriced model means the window does not pause. A partial sum is not a reason to stop.
 *
 * `AGENTBOX_QUOTA_PAUSE_AT` is the line, in the same unit as the rates. Unset means do not
 * refuse, and means this file does not read the ledger on the call path.
 *
 * The remains GET is a second signal, off unless `AGENTBOX_QUOTA_REMAINS=1`. The parser accepts
 * only a shape that was actually captured (model_remains, model_name "general"). Official pages
 * confirm the URL and the 5-hour and 7-day rules; they did not publish this JSON. An older
 * guessed shape is ignored. The key is never written into a message.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome, envNumber } from "../config.ts";
import { priceOf, type Rate, type Rates } from "./spend.ts";
import { UsageLog, type UsageRecord } from "./usage.ts";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** China list for MiniMax-M3.1-Flash, 2026-11-04. Yuan per million. Not a table for other models. */
export const M31_FLASH_LIST: Rate = { inputPerM: 1, outputPerM: 4, cacheReadPerM: 0.1, cacheWritePerM: 0 };

const LIST_MODELS = new Set(["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"]);
const REMAINS_URL = "https://www.minimax.cn/v1/token_plan/remains";
const LEDGER_CACHE_MS = 60_000;
const REMAINS_CACHE_MS = 10 * 60_000;

export interface ForecastRow {
  model: string;
  at?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rejection?: string;
  metering?: UsageRecord["metering"];
}

export interface WindowForecast {
  money?: number;
  unpriced: string[];
  records: number;
  /** When the oldest included row leaves this rolling window, if it has a readable time. */
  clearsAt?: string;
}

export interface Forecast {
  five: WindowForecast;
  week: WindowForecast;
  hold: boolean;
  line: string;
}

/**
 * The general chat window from a captured remains body.
 *
 * `*_remaining_percent` is what is left, not what was used. `status` 1 is limited, 2 is
 * exhausted, 3 is unlimited. Counts may be 0 while the percents are the part that means
 * something. `model_name` "video" is a different pool and is not read.
 */
export interface GeneralRemains {
  intervalStatus: number;
  intervalRemainingPercent: number;
  intervalEndMs: number;
  weeklyStatus: number;
  weeklyRemainingPercent: number;
  weeklyEndMs: number;
}

export interface RemainsDecision {
  pause: boolean;
  untilMs?: number;
}

interface LedgerSnapshot {
  at: number;
  records: UsageRecord[];
  rates: Rates;
}

let ledgerCache: LedgerSnapshot | undefined;
let remainsCache: { at: number; parsed?: GeneralRemains } | undefined;
let remainsKey: (() => string | undefined) | undefined;
let ledgerWarned = false;
let ledgerReads = 0;

/** How many times the default path opened the ledger. Tests use it to prove an unset line does not. */
export function quotaLedgerReads(): number {
  return ledgerReads;
}

/** Drops the process caches. Tests use it so one case cannot answer the next. */
export function resetQuotaCache(): void {
  ledgerCache = undefined;
  remainsCache = undefined;
  ledgerWarned = false;
}

function pauseAtFromEnv(): number | undefined {
  const value = envNumber("AGENTBOX_QUOTA_PAUSE_AT", Number.NaN);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Rates for the forecast. The spend report keeps whatever was configured. Only the two
 * M3.1-Flash names are filled from the China list, and only when their configured input is
 * missing or below that list.
 */
export function ratesForForecast(configured: Rates | undefined): { rates: Rates; listPriced: string[] } {
  const rates: Rates = { ...(configured ?? {}) };
  const listPriced: string[] = [];
  for (const model of LIST_MODELS) {
    const rate = rates[model];
    if (rate === undefined || !(typeof rate.inputPerM === "number" && rate.inputPerM >= 1)) {
      rates[model] = { ...M31_FLASH_LIST };
      listPriced.push(model);
    }
  }
  return { rates, listPriced };
}

function windowOf(records: readonly ForecastRow[], rates: Rates, now: number, windowMs: number): WindowForecast {
  const start = now - windowMs;
  const included = records.filter(record => {
    if (record.rejection !== undefined || record.model === "rejected") return false;
    const at = Date.parse(record.at ?? "");
    return Number.isNaN(at) || at >= start;
  });
  const unpriced = [...new Set(included.filter(record => priceOf(record, rates) === undefined).map(record => record.model))].sort();
  const times = included.map(record => Date.parse(record.at ?? "")).filter(at => !Number.isNaN(at));
  const oldest = times.length > 0 ? Math.min(...times) : undefined;
  return {
    ...(unpriced.length === 0
      ? { money: included.reduce((sum, record) => sum + (priceOf(record, rates) ?? 0), 0) }
      : {}),
    unpriced,
    records: included.length,
    ...(oldest !== undefined ? { clearsAt: new Date(oldest + windowMs).toISOString() } : {}),
  };
}

function amount(window: WindowForecast): string {
  if (window.unpriced.length > 0) return `unpriced ${window.unpriced.join(", ")}`;
  if (window.records === 0) return "empty";
  return String(Math.round((window.money ?? 0) * 1000) / 1000);
}

/** One status line. The money is a forecast. Hold is named with the disposition, not with vendor prose. */
export function forecastOf(
  records: readonly ForecastRow[],
  priced: { rates: Rates; listPriced: string[] },
  now: number,
  pauseAt?: number
): Forecast {
  const five = windowOf(records, priced.rates, now, FIVE_HOURS_MS);
  const week = windowOf(records, priced.rates, now, WEEK_MS);
  const hold =
    pauseAt !== undefined &&
    pauseAt > 0 &&
    ((five.money !== undefined && five.money >= pauseAt) || (week.money !== undefined && week.money >= pauseAt));
  const models = new Set(records.filter(record => record.rejection === undefined && record.model !== "rejected").map(record => record.model));
  const listed = priced.listPriced.filter(model => models.has(model));
  const listNote =
    listed.length > 0
      ? `${listed.join(", ")} uses the 2026-11-04 China list (1 / 4 / 0.1 per million) where the configured input was missing or below 1.`
      : "";
  const line = [
    "Forecast, not a bill.",
    `Rolling 5h ${amount(five)}${five.clearsAt !== undefined ? ` (clears ${five.clearsAt})` : ""}.`,
    `Rolling 7d ${amount(week)}.`,
    "The 7d figure only sees what the ledger still holds (default 48h). Both windows roll from now, which only approximates a vendor window that starts at first use.",
    listNote,
    hold ? "Hold: yes (quota_hold)." : pauseAt === undefined ? "Hold: no (no pause line)." : "Hold: no.",
  ]
    .filter(part => part !== "")
    .join(" ");
  return { five, week, hold, line };
}

/**
 * The captured remains body, or undefined when it is not that shape.
 *
 * `base_resp.status_code` other than 0 (a missing key is still HTTP 200) is not a window.
 * A body that only has a guessed `current_interval_reset_time` is not a window either.
 */
export function parseMinimaxRemains(body: unknown): GeneralRemains | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const base = root.base_resp;
  if (base !== null && typeof base === "object") {
    const code = (base as { status_code?: unknown }).status_code;
    if (code !== undefined && code !== 0) return undefined;
  }
  if (!Array.isArray(root.model_remains)) return undefined;
  const general = root.model_remains.find(
    row => row !== null && typeof row === "object" && (row as { model_name?: unknown }).model_name === "general"
  );
  if (general === undefined || general === null || typeof general !== "object") return undefined;
  const row = general as Record<string, unknown>;
  const intervalStatus = finite(row.current_interval_status);
  const intervalRemainingPercent = finite(row.current_interval_remaining_percent);
  const weeklyStatus = finite(row.current_weekly_status);
  const weeklyRemainingPercent = finite(row.current_weekly_remaining_percent);
  if (
    intervalStatus === undefined ||
    intervalRemainingPercent === undefined ||
    weeklyStatus === undefined ||
    weeklyRemainingPercent === undefined
  ) {
    return undefined;
  }
  return {
    intervalStatus,
    intervalRemainingPercent,
    intervalEndMs: finite(row.end_time) ?? 0,
    weeklyStatus,
    weeklyRemainingPercent,
    weeklyEndMs: finite(row.weekly_end_time) ?? 0,
  };
}

/**
 * Pause when a window is exhausted (status 2) or its remaining percent is at or under `floor`.
 * Status 3 is unlimited and does not pause, whatever the percent says. The end time is the
 * later of the windows that paused, so one window recovering does not hide the other.
 */
export function remainsPause(remains: GeneralRemains, floor: number): RemainsDecision {
  const interval = remains.intervalStatus !== 3 && (remains.intervalStatus === 2 || remains.intervalRemainingPercent <= floor);
  const weekly = remains.weeklyStatus !== 3 && (remains.weeklyStatus === 2 || remains.weeklyRemainingPercent <= floor);
  if (!interval && !weekly) return { pause: false };
  const untils = [interval ? remains.intervalEndMs : 0, weekly ? remains.weeklyEndMs : 0].filter(ms => ms > 0);
  return { pause: true, ...(untils.length > 0 ? { untilMs: Math.max(...untils) } : {}) };
}

function cachedRemainsDecision(): RemainsDecision {
  const parsed = remainsCache?.parsed;
  if (parsed === undefined) return { pause: false };
  return remainsPause(parsed, 0);
}

function readRates(): Rates {
  try {
    const parsed = JSON.parse(readFileSync(join(agentboxHome(), "config.json"), "utf8")) as { rates?: Rates };
    return parsed.rates ?? {};
  } catch {
    return {};
  }
}

function readLedger(now: number): LedgerSnapshot {
  if (ledgerCache !== undefined && now - ledgerCache.at < LEDGER_CACHE_MS) return ledgerCache;
  ledgerReads += 1;
  const records = new UsageLog().since(0, Number.MAX_SAFE_INTEGER);
  ledgerCache = { at: now, records, rates: readRates() };
  return ledgerCache;
}

function warnLedger(error: unknown): void {
  if (ledgerWarned) return;
  ledgerWarned = true;
  const detail = error instanceof Error ? error.message : "unreadable";
  console.error(`[quota] the usage forecast could not be read (${detail}); not pausing`);
}

/** The settings line. Reads the ledger because a person asked. Names a failure instead of inventing a zero. */
export function quotaStatusLine(now = Date.now()): string {
  const remains = cachedRemainsDecision();
  let line: string;
  try {
    const ledger = readLedger(now);
    line = forecastOf(ledger.records, ratesForForecast(ledger.rates), now, pauseAtFromEnv()).line;
  } catch (error) {
    warnLedger(error);
    line = "Forecast, not a bill. The usage ledger could not be read. Hold: no.";
  }
  if (!remains.pause) return line;
  const until = remains.untilMs !== undefined ? new Date(remains.untilMs).toISOString() : "the window resets";
  return `${line} Remains general window holds until ${until} (quota_hold).`;
}

/**
 * Refuses a model call before it is sent. Undefined means send it.
 *
 * With no argument, an unset pause line returns before any ledger read. A remains decision
 * already in memory can still refuse: that cache is filled only when the remains flag is on.
 */
export function quotaHoldError(label: string, source?: QuotaSource): Error | undefined {
  if (source === undefined) {
    const remains = cachedRemainsDecision();
    if (remains.pause) return holdError(label, remains);
    const pauseAt = pauseAtFromEnv();
    if (pauseAt === undefined) return undefined;
    try {
      const now = Date.now();
      const ledger = readLedger(now);
      const forecast = forecastOf(ledger.records, ratesForForecast(ledger.rates), now, pauseAt);
      if (!forecast.hold) return undefined;
      return new QuotaHoldError(`${label}: ${forecast.line} No call was made.`);
    } catch (error) {
      warnLedger(error);
      return undefined;
    }
  }
  if (source.remains !== undefined && source.remains !== null) {
    const remains = remainsPause(source.remains, source.floor ?? 0);
    if (remains.pause) return holdError(label, remains);
  }
  if (source.pauseAt === undefined || source.pauseAt === null || !(source.pauseAt > 0)) return undefined;
  const now = source.now?.() ?? Date.now();
  const forecast = forecastOf(source.records ?? [], ratesForForecast(source.rates), now, source.pauseAt);
  if (!forecast.hold) return undefined;
  return new QuotaHoldError(`${label}: ${forecast.line} No call was made.`);
}

export interface QuotaSource {
  now?: () => number;
  records?: readonly ForecastRow[];
  rates?: Rates;
  pauseAt?: number | null;
  remains?: GeneralRemains | null;
  floor?: number;
}

/** A refusal the retry loop already understands: providerResting, so it is usage_limit and not retried. */
export class QuotaHoldError extends Error {
  readonly providerResting = true as const;
  constructor(message: string) {
    super(message);
    this.name = "QuotaHoldError";
  }
}

function holdError(label: string, remains: RemainsDecision): QuotaHoldError {
  const until = remains.untilMs !== undefined ? new Date(remains.untilMs).toISOString() : "the window resets";
  return new QuotaHoldError(
    `${label}: quota_hold. MiniMax remains says the general window is out until ${until}. Forecast, not a bill. No call was made.`
  );
}

/**
 * Polls the China remains endpoint while `AGENTBOX_QUOTA_REMAINS=1`.
 *
 * Off by default, including under tests: the flag is not in the test environment, and this
 * returns before any request. The key is read by the caller and sent as a header. It is not
 * put on the URL and not put in the error we keep. A failed request leaves the previous
 * decision alone for this interval and does not pause anyone by itself.
 */
export function startRemainsPolling(readKey: () => string | undefined, fetchImpl: typeof fetch = globalThis.fetch): void {
  remainsKey = readKey;
  if (envNumber("AGENTBOX_QUOTA_REMAINS", 0) !== 1) return;
  const tick = (): void => {
    const key = remainsKey?.();
    if (key === undefined || key === "") return;
    const now = Date.now();
    if (remainsCache !== undefined && now - remainsCache.at < REMAINS_CACHE_MS) return;
    void fetchImpl(REMAINS_URL, { headers: { authorization: `Bearer ${key}` } })
      .then(async response => {
        const parsed = parseMinimaxRemains(await response.json());
        remainsCache = { at: Date.now(), ...(parsed !== undefined ? { parsed } : {}) };
      })
      .catch(() => {
        remainsCache = { at: Date.now(), ...(remainsCache?.parsed !== undefined ? { parsed: remainsCache.parsed } : {}) };
      });
  };
  tick();
  const timer = setInterval(tick, REMAINS_CACHE_MS);
  timer.unref?.();
}
