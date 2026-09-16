/**
 * The spend ceiling the box cannot talk its way past (INV-580, docs/10 S-5).
 *
 * The cases here are the ones that decide whether this is a ceiling or a decoration: an
 * unpriced model, a restart, and a deployment that never asked for a limit at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SpendCeilings, ceilingFromQuota, type Ceiling } from "./ceiling.ts";
import type { RelayUsage } from "./server.ts";

const RATES = { "claude-opus-5": { inputPerM: 15, outputPerM: 75 } };

function usage(at: string, tokens: number, model = "claude-opus-5"): Omit<RelayUsage, "streamed"> {
  return {
    at,
    tenantId: "t1",
    boxId: "b1",
    provider: "anthropic",
    model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function ceilings(ceiling: Ceiling | undefined, now: string, onRefusal?: () => void) {
  return new SpendCeilings({
    ceilingFor: () => ceiling,
    rates: RATES,
    now: () => new Date(now),
    ...(onRefusal !== undefined ? { onRefusal } : {}),
  });
}

test("no ceiling configured is no ceiling: the default deployment is unchanged (A3)", () => {
  const meter = ceilings(undefined, "2026-09-16T12:00:00Z");
  for (let i = 0; i < 50; i += 1) meter.record(usage("2026-09-16T11:00:00Z", 10_000_000));
  assert.deepEqual(meter.check({ boxId: "b1", tenantId: "t1" }), { ok: true });
  // And an empty ceiling object is the same as none: a quota row with nothing in it must not
  // silently mean "zero allowed".
  assert.deepEqual(ceilings({}, "2026-09-16T12:00:00Z").check({ boxId: "b1", tenantId: "t1" }), { ok: true });
});

test("past the limit the relay refuses, and says what it is and when it lifts (A1, A2)", () => {
  let refusals = 0;
  const meter = ceilings({ limitUsd: 1, windowHours: 24 }, "2026-09-16T12:00:00Z", () => {
    refusals += 1;
  });
  // 60k input tokens at $15/M is $0.90 — under the dollar.
  meter.record(usage("2026-09-16T09:00:00Z", 60_000));
  assert.deepEqual(meter.check({ boxId: "b1", tenantId: "t1" }), { ok: true });

  meter.record(usage("2026-09-16T10:00:00Z", 20_000));
  const refused = meter.check({ boxId: "b1", tenantId: "t1" });
  assert.equal(refused.ok, false);
  assert.equal(refusals, 1, "and the refusal is handed out for the audit");
  const reason = refused.ok === false ? refused.refusal.reason : "";
  assert.match(reason, /spent \$1\.20 in the last 24 hours/);
  assert.match(reason, /which is its limit \(\$1\.00\)/);
  assert.match(reason, /allowance starts coming back after 2026-09-17T09:00/, "when — as the oldest request falls out, not a round number that would be a lie");
  assert.match(reason, /set by whoever runs this deployment, not by anything in the box/, "and who can change it");

  // A box that spent nothing is unaffected: the ceiling is per box, not per relay.
  assert.deepEqual(meter.check({ boxId: "b2", tenantId: "t1" }), { ok: true });
});

test("the window moves: yesterday's spend does not hold this box down forever", () => {
  const meter = ceilings({ limitUsd: 1, windowHours: 24 }, "2026-09-16T12:00:00Z");
  meter.record(usage("2026-09-14T12:00:00Z", 1_000_000));
  assert.deepEqual(meter.check({ boxId: "b1", tenantId: "t1" }), { ok: true }, "two days ago is outside a 24-hour window");
  assert.equal(meter.spent("b1").usd, 0);
});

test("a token ceiling needs no rates, and counts every kind of token", () => {
  const meter = new SpendCeilings({ ceilingFor: () => ({ limitTokens: 1000 }), now: () => new Date("2026-09-16T12:00:00Z") });
  meter.record({ ...usage("2026-09-16T11:00:00Z", 400), cacheReadTokens: 400, outputTokens: 100 });
  assert.deepEqual(meter.check({ boxId: "b1", tenantId: "t1" }), { ok: true }, "900 of 1000");

  meter.record(usage("2026-09-16T11:30:00Z", 200));
  const refused = meter.check({ boxId: "b1", tenantId: "t1" });
  assert.equal(refused.ok, false);
  const tokenReason = refused.ok === false ? refused.refusal.reason : "";
  assert.match(tokenReason, /used 1,100 tokens in the last 24 hours, which is its limit \(1,000\)/);
  assert.match(tokenReason, /allowance starts coming back after/);
});

test("a model with no rate fails the money ceiling closed, and names it", () => {
  // Otherwise an unpriced model is a hole straight through a money limit: the total reads
  // low because part of the spend could not be counted, which is the opposite of a ceiling.
  const meter = ceilings({ limitUsd: 100 }, "2026-09-16T12:00:00Z");
  meter.record(usage("2026-09-16T11:00:00Z", 10, "some-new-model"));
  const refused = meter.check({ boxId: "b1", tenantId: "t1" });
  assert.equal(refused.ok, false);
  const reason = refused.ok === false ? refused.refusal.reason : "";
  assert.match(reason, /usage from some-new-model cannot be priced/);
  assert.match(reason, /a limit that cannot be measured is not a limit/);
  assert.match(reason, /until a rate is configured or the limit is removed/, "and both ways out are named");

  // A token ceiling is unaffected by missing rates — it never needed them.
  const byTokens = new SpendCeilings({ ceilingFor: () => ({ limitTokens: 1000 }), now: () => new Date("2026-09-16T12:00:00Z") });
  byTokens.record(usage("2026-09-16T11:00:00Z", 10, "some-new-model"));
  assert.deepEqual(byTokens.check({ boxId: "b1", tenantId: "t1" }), { ok: true });
});

test("a ceiling is read out of a tenant's quota, and a quota with nothing in it is not a ceiling", () => {
  assert.deepEqual(ceilingFromQuota({ relay: { limitUsd: 25, windowHours: 168 } }), { limitUsd: 25, windowHours: 168 });
  assert.deepEqual(ceilingFromQuota({ relay: { limitTokens: 5_000_000 } }), { limitTokens: 5_000_000 });
  assert.equal(ceilingFromQuota(undefined), undefined);
  assert.equal(ceilingFromQuota({}), undefined);
  assert.equal(ceilingFromQuota({ relay: {} }), undefined);
  // Nonsense is refused rather than coerced: a limit of zero or -1 from a hand-edited quota
  // would stop every box, and "the deployment misconfigured itself" is not a budget decision.
  assert.equal(ceilingFromQuota({ relay: { limitUsd: 0 } }), undefined);
  assert.equal(ceilingFromQuota({ relay: { limitUsd: "lots" } }), undefined);
});
