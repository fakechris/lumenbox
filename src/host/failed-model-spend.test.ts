import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderProfile } from "./provider.ts";
import type { UsageRecord } from "./usage.ts";
import { reserveFailedModelSpend } from "./failed-model-spend.ts";
import { SpendLimits } from "./spend-limits.ts";

test("failed usage stays unknown while its maximum input/cache rate and output allowance guard the budget", () => {
  const rows: Omit<UsageRecord, "seq" | "at">[] = [];
  const limits = new SpendLimits({ ledger: () => [], rates: () => ({ m: { inputPerM: 1, outputPerM: 3, cacheWritePerM: 2 } }), pause: async () => {}, resume: async () => {}, isPaused: () => false, notify: () => {}, nameOf: id => id, log: () => {} });
  limits.setLimits("a", { perWake: 0.5, perDay: 20 });
  const held = reserveFailedModelSpend({ label: "test", model: "m", contextWindow: 200000, maxTokens: 100000 } as ProviderProfile, { agentId: "a", agentName: "A", workId: "w", turnId: "t", conversation: "main", round: 0 }, limits, { record: row => { rows.push(row); return { ...row, seq: 1, at: new Date().toISOString() }; } });
  assert.equal(held.verdict?.kind, "hit_wake");
  assert.equal(held.goalCostBound, 650000, "Goal's bound uses the highest input/cache weight, not only fresh input");
  assert.equal(limits.today("a").reserved, 0.7, "highest input/cache rate plus maximum output");
  assert.equal(limits.today("a").spent, 0);
  assert.equal(rows[0]!.metering, "missing");
  assert.equal(rows[0]!.inputTokens, 0, "the reservation is not fabricated provider usage");
});
