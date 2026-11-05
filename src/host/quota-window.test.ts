/**
 * The usage forecast and the remains fixture (INV-1612).
 *
 * No test here opens a socket. The pause line is a number the caller supplies, or the env in
 * one case that writes a temp ledger. An unset line must not open the ledger at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIVE_HOURS_MS,
  forecastOf,
  M31_FLASH_LIST,
  parseMinimaxRemains,
  quotaHoldError,
  quotaLedgerReads,
  QuotaHoldError,
  ratesForForecast,
  remainsPause,
  resetQuotaCache,
  type ForecastRow,
  type GeneralRemains,
} from "./quota-window.ts";
import { UsageLog } from "./usage.ts";

const now = Date.parse("2026-11-04T12:00:00.000Z");

function row(over: Partial<ForecastRow> = {}): ForecastRow {
  return {
    model: "MiniMax-M3.1-Flash",
    at: new Date(now - 60_000).toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

const STALE = { "MiniMax-M3.1-Flash": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 } };

test("a stale MiniMax flash input is replaced by the China list; other models are not given a price", () => {
  const priced = ratesForForecast({ ...STALE, "claude-opus-5": { inputPerM: 5, outputPerM: 25 } });
  assert.deepEqual(priced.rates["MiniMax-M3.1-Flash"], M31_FLASH_LIST);
  assert.deepEqual(priced.rates["MiniMax-M3.1-Flash-Preview"], M31_FLASH_LIST);
  assert.deepEqual(priced.rates["claude-opus-5"], { inputPerM: 5, outputPerM: 25 });

  const kept = ratesForForecast({ "MiniMax-M3.1-Flash": { inputPerM: 1.5, outputPerM: 6, cacheReadPerM: 0.2, cacheWritePerM: 0 } });
  assert.equal(kept.rates["MiniMax-M3.1-Flash"]?.inputPerM, 1.5);
  assert.equal(kept.listPriced.includes("MiniMax-M3.1-Flash"), false);
});

test("the window pauses only when every row in it is priced and the money reaches the line", () => {
  const flash = row({ inputTokens: 1_000_000 });
  const reached = forecastOf([flash], ratesForForecast(STALE), now, 1);
  assert.equal(reached.five.money, 1);
  assert.equal(reached.hold, true);
  assert.match(reached.line, /Forecast, not a bill/);
  assert.match(reached.line, /Hold: yes \(quota_hold\)/);
  assert.match(reached.line, /China list/);
  assert.match(reached.line, /default 48h/);
  assert.equal(reached.five.clearsAt, new Date(now - 60_000 + FIVE_HOURS_MS).toISOString());

  const under = forecastOf([flash], ratesForForecast(STALE), now, 1.01);
  assert.equal(under.hold, false);
  assert.match(under.line, /Hold: no\./);

  const unset = forecastOf([flash], ratesForForecast(STALE), now, undefined);
  assert.equal(unset.hold, false);
  assert.match(unset.line, /no pause line/);

  const stranger = row({ model: "MiniMax-M3", inputTokens: 50_000_000 });
  const partial = forecastOf([flash, stranger], ratesForForecast(STALE), now, 0.01);
  assert.equal(partial.five.money, undefined);
  assert.deepEqual(partial.five.unpriced, ["MiniMax-M3"]);
  assert.equal(partial.hold, false);

  const rejected = row({ model: "rejected", rejection: "quota_hold", inputTokens: 50_000_000 });
  const ignored = forecastOf([flash, rejected], ratesForForecast(STALE), now, 1);
  assert.equal(ignored.five.money, 1);
  assert.equal(ignored.hold, true);

  // Outside the 5 hours, still inside the week: only the week can hold.
  const old = row({ at: new Date(now - FIVE_HOURS_MS - 60_000).toISOString(), inputTokens: 2_000_000 });
  const weekOnly = forecastOf([old], ratesForForecast(STALE), now, 2);
  assert.equal(weekOnly.five.records, 0);
  assert.equal(weekOnly.week.money, 2);
  assert.equal(weekOnly.hold, true);
});

/** Captured shape. Not copied from an official schema: the official pages did not publish one. */
const REMAINS = {
  model_remains: [
    {
      model_name: "video",
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
      end_time: 1,
      current_weekly_status: 2,
      current_weekly_remaining_percent: 0,
      weekly_end_time: 2,
    },
    {
      model_name: "general",
      start_time: 1782381600000,
      end_time: 1782399600000,
      remains_time: 2669853,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_interval_remaining_percent: 10,
      current_interval_status: 1,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      current_weekly_remaining_percent: 69,
      current_weekly_status: 1,
      weekly_start_time: 1782086400000,
      weekly_end_time: 1782691200000,
      weekly_remains_time: 294269853,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

test("remains: the general window, not video, and only the captured shape", () => {
  const parsed = parseMinimaxRemains(REMAINS);
  assert.ok(parsed !== undefined);
  assert.equal(parsed!.intervalRemainingPercent, 10);
  assert.equal(remainsPause(parsed!, 10).pause, true);
  assert.equal(remainsPause(parsed!, 10).untilMs, 1782399600000);
  assert.equal(remainsPause(parsed!, 0).pause, false);

  const exhausted: GeneralRemains = { ...parsed!, intervalStatus: 2, intervalRemainingPercent: 40 };
  const decision = remainsPause(exhausted, 0);
  assert.equal(decision.pause, true);
  assert.equal(decision.untilMs, 1782399600000);

  const unlimited: GeneralRemains = { ...parsed!, intervalStatus: 3, intervalRemainingPercent: 0, weeklyStatus: 3, weeklyRemainingPercent: 0 };
  assert.equal(remainsPause(unlimited, 0).pause, false);

  assert.equal(parseMinimaxRemains({ data: { current_interval_reset_time: "2026-11-05T00:00:00Z" } }), undefined);
  assert.equal(parseMinimaxRemains({ ...REMAINS, base_resp: { status_code: 1004, status_msg: "no key" } }), undefined);

  const error = quotaHoldError("MiniMax", { remains: exhausted, floor: 0, pauseAt: null });
  assert.ok(error instanceof QuotaHoldError);
  assert.match(error!.message, /quota_hold/);
  assert.match(error!.message, /Forecast, not a bill/);
  assert.match(error!.message, /2026-/);
  assert.equal(error!.providerResting, true);
});

test("the pause line reads the ledger only when it is set, and then refuses at the line", () => {
  resetQuotaCache();
  const previousHome = process.env.AGENTBOX_HOME;
  const previousPause = process.env.AGENTBOX_QUOTA_PAUSE_AT;
  delete process.env.AGENTBOX_QUOTA_PAUSE_AT;
  delete process.env.AGENTBOX_HOME;
  const before = quotaLedgerReads();
  try {
    assert.equal(quotaHoldError("MiniMax"), undefined);
    assert.equal(quotaLedgerReads(), before, "an unset line does not open the ledger");

    const root = mkdtempSync(join(tmpdir(), "quota-"));
    process.env.AGENTBOX_HOME = root;
    process.env.AGENTBOX_QUOTA_PAUSE_AT = "1";
    try {
      writeFileSync(join(root, "config.json"), JSON.stringify({ rates: STALE }));
      const log = new UsageLog(join(root, "usage.jsonl"));
      log.record({
        agentId: "ada",
        agentName: "Ada",
        provider: "MiniMax",
        model: "MiniMax-M3.1-Flash",
        round: 0,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      resetQuotaCache();
      const error = quotaHoldError("MiniMax");
      assert.ok(error instanceof QuotaHoldError);
      assert.match(error!.message, /quota_hold/);
      assert.match(error!.message, /No call was made/);
      assert.equal(quotaLedgerReads(), before + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    resetQuotaCache();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    if (previousPause === undefined) delete process.env.AGENTBOX_QUOTA_PAUSE_AT;
    else process.env.AGENTBOX_QUOTA_PAUSE_AT = previousPause;
  }
});
