/** An agent's spend lines (INV-1615): priced with the ledger's rates, reminded at 80%, the wake ends at its line, the day pauses and the next day resumes, an unpriced model counts in tokens and is named. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SPEND_LIMITS, dayOf, OPEN_WAKES, SpendLimits, type SpendLimitDeps, type SpendRow, todaysRows } from "./spend-limits.ts";

const RATES = { m: { inputPerM: 1_000, outputPerM: 2_000, cacheReadPerM: 100, cacheWritePerM: 100 } };
const row = (agentId: string, turnId: string, input: number, output = 0, model = "m", extra: Partial<SpendRow> = {}): SpendRow => ({ agentId, agentName: agentId, turnId, model, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra });

function harness(options: { ledger?: SpendRow[]; path?: string; clock?: { now: Date } } = {}) {
  const clock = options.clock ?? { now: new Date(2026, 10, 4, 9, 0, 0) };
  const paused = new Map<string, string>();
  const calls = { pause: [] as string[], resume: [] as string[], notify: [] as string[] };
  const deps: SpendLimitDeps = {
    ledger: () => options.ledger ?? [],
    rates: () => RATES,
    pause: async (id, reason) => { paused.set(id, reason); calls.pause.push(`${id}: ${reason}`); },
    resume: async (id, by) => { paused.delete(id); calls.resume.push(`${id} by ${by}`); },
    isPaused: id => paused.has(id),
    notify: text => calls.notify.push(text),
    nameOf: id => id.toUpperCase(),
    log: () => {},
    now: () => clock.now,
  };
  return { limits: new SpendLimits(deps, options.path), calls, paused, clock };
}

test("spend accumulates with the ledger's prices; the morning's rows are read once and not counted twice; a day's total is per agent", () => {
  // 1,000 input tokens at 1,000/M = 1.0; 500 output at 2,000/M = 1.0.
  const { limits } = harness({ ledger: [row("vic", "t0", 1_000), row("bob", "t0", 500, 500)] });
  assert.equal(limits.today("vic").spent, 1);
  assert.equal(limits.today("bob").spent, 1.5);
  assert.equal(limits.note(row("vic", "t1", 1_000)).kind, "ok");
  assert.equal(limits.today("vic").spent, 2);
  assert.equal(limits.today("bob").spent, 1.5);
  assert.deepEqual(limits.today("vic").limits, DEFAULT_SPEND_LIMITS);
});

test("at 80% of the wake line the next result carries one reminder; at the line the wake ends with a hand-back report; a new wake starts clean", () => {
  const { limits } = harness();
  limits.setLimits("vic", { perWake: 1, perDay: 100 });
  assert.equal(limits.note(row("vic", "t1", 500)).kind, "ok");
  const warned = limits.note(row("vic", "t1", 300));
  assert.equal(warned.kind, "warn");
  assert.match((warned as { text: string }).text, /this wake has spent 0\.80 of 1\.00; at the line the turn ends and hands back/);
  assert.equal(limits.note(row("vic", "t1", 100)).kind, "ok", "the reminder goes once");
  const hit = limits.note(row("vic", "t1", 100));
  assert.equal(hit.kind, "hit_wake");
  assert.match((hit as { report: string }).report, /reached my spend line for this wake \(1\.00 of 1\.00\)[\s\S]*Settings → Team → Agents/);
  assert.equal(limits.note(row("vic", "t2", 100)).kind, "ok", "the next wake starts from zero");
});

test("a member's turn and a guest's turn of one agent, charged in between each other, each keep their own wake total and reach their own line (INV-1735)", () => {
  const { limits } = harness();
  limits.setLimits("vic", { perWake: 1, perDay: 100 });
  // Member rows of 0.3, guest rows of 0.2, alternating: one current wake per agent reset each to zero every row.
  const member = (input: number) => limits.note(row("vic", "member-turn", input));
  const guest = (input: number) => limits.note(row("vic", "guest-turn", input));
  assert.equal(guest(200).kind, "ok");
  assert.equal(member(300).kind, "ok");
  assert.equal(guest(200).kind, "ok");
  assert.equal(member(300).kind, "ok");
  assert.equal(guest(200).kind, "ok");
  const memberWarn = member(300);
  assert.equal(memberWarn.kind, "warn", "the member's wake is at 0.9, its own total");
  assert.match((memberWarn as { text: string }).text, /this wake has spent 0\.90 of 1\.00/);
  const guestWarn = guest(200);
  assert.equal(guestWarn.kind, "warn", "the guest's wake warns on its own, not silenced by the member's reminder");
  assert.match((guestWarn as { text: string }).text, /this wake has spent 0\.80 of 1\.00/);
  const memberHit = member(300);
  assert.equal(memberHit.kind, "hit_wake");
  assert.match((memberHit as { report: string }).report, /\(1\.20 of 1\.00\)/);
  assert.equal(guest(100).kind, "ok", "the member reaching its line does not end the guest's wake");
  assert.equal(guest(100).kind, "hit_wake", "the guest's wake reaches its line at its own 1.00");
  assert.ok(Math.abs(limits.today("vic").spent - 2.2) < 1e-9, "the day counts every row of both turns once");
});

test("the wake totals are bounded: a turn charged recently is kept, the least recently charged beyond the bound is forgotten", () => {
  const { limits } = harness();
  limits.setLimits("vic", { perWake: 1, perDay: 1_000 });
  assert.equal(limits.note(row("vic", "long", 500)).kind, "ok");
  assert.equal(limits.note(row("vic", "stale", 500)).kind, "ok");
  for (let i = 0; i < OPEN_WAKES - 2; i++) limits.note(row("vic", `guest-${i}`, 1));
  assert.equal(limits.note(row("vic", "long", 300)).kind, "warn", "still within the bound, the long turn keeps its 0.5");
  for (let i = 0; i < OPEN_WAKES - 1; i++) limits.note(row("vic", `later-${i}`, 1));
  assert.equal(limits.note(row("vic", "long", 200)).kind, "hit_wake", "a turn that keeps being charged is never the one forgotten");
  assert.equal(limits.note(row("vic", "stale", 300)).kind, "ok", "the stale turn was forgotten and starts again from zero");
});

test("at the daily line the verdict carries the pause: the record first, then the durable pause with the reason, one admin notice; the next local day resumes it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "agentbox-spend-")), "spend-limits.jsonl");
  try {
    const { limits, calls, paused, clock } = harness({ path });
    limits.setLimits("vic", { perDay: 2, perWake: 100 });
    assert.equal(limits.note(row("vic", "t1", 1_000)).kind, "ok");
    const warned = limits.note(row("vic", "t1", 700));
    assert.equal(warned.kind, "warn");
    assert.match((warned as { text: string }).text, /today you have spent 1\.70 of 2\.00; at the line you are paused until tomorrow/);
    const hit = limits.note(row("vic", "t1", 300));
    assert.equal(hit.kind, "hit_day");
    assert.deepEqual(calls.pause, [], "not paused until the turn has said its hand-back");
    assert.match((hit as { report: string }).report, /VIC has reached its daily spend line \(2\.00 of 2\.00\) and is paused until tomorrow/);
    await (hit as { enforce: () => Promise<void> }).enforce();
    assert.deepEqual(calls.pause, ["vic: spend limit: 2.00 of 2.00 reached on 2026-11-04"]);
    assert.equal(calls.notify.length, 1);
    assert.match(calls.notify[0]!, /VIC reached its daily spend line/);
    assert.deepEqual(limits.pausedForSpend(), [{ agentId: "vic", day: "2026-11-04" }]);
    assert.equal(limits.today("vic").pausedAt, clock.now.toISOString());
    // More spend the same day (a person resumed it, say) does not pause again or notify again.
    assert.notEqual(limits.note(row("vic", "t2", 1_000)).kind, "hit_day");
    assert.equal(calls.notify.length, 1);
    // Still the same day: nothing to do.
    assert.deepEqual(await limits.sweep(), []);
    assert.ok(paused.has("vic"));
    // The settings and the pause survive a restart.
    const again = harness({ path, clock }).limits;
    assert.deepEqual(again.pausedForSpend(), [{ agentId: "vic", day: "2026-11-04" }]);
    assert.equal(again.limitsOf("vic").perDay, 2);
    // Next day: resumed, with the reason; the day's tally starts again.
    clock.now = new Date(2026, 10, 5, 0, 5, 0);
    assert.deepEqual(await limits.sweep(), ["vic"]);
    assert.deepEqual(calls.resume, ["vic by LumenBox (spend limit): a new day"]);
    assert.deepEqual(limits.pausedForSpend(), []);
    assert.equal(limits.today("vic").spent, 0);
    assert.equal(limits.today("vic").day, "2026-11-05");
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("a person who resumed the agent before midnight is not overridden by the sweep", async () => {
  const { limits, calls, paused, clock } = harness();
  limits.setLimits("vic", { perDay: 1 });
  const hit = limits.note(row("vic", "t1", 1_000));
  assert.equal(hit.kind, "hit_day");
  await (hit as { enforce: () => Promise<void> }).enforce();
  paused.delete("vic"); // the person's Resume
  clock.now = new Date(2026, 10, 5, 1, 0, 0);
  assert.deepEqual(await limits.sweep(), []);
  assert.deepEqual(calls.resume, []);
  assert.deepEqual(limits.pausedForSpend(), []);
});

test("a model without a rate counts in tokens toward its own line and is named in the reminder and the report; a rejected row counts nothing", () => {
  const { limits } = harness();
  limits.setLimits("vic", { perWakeTokens: 10_000, perDayTokens: 1_000_000 });
  assert.equal(limits.note(row("vic", "t1", 100, 0, "m", { rejection: "429" })).kind, "ok");
  assert.equal(limits.today("vic").spent, 0);
  assert.equal(limits.note(row("vic", "t1", 4_000, 0, "mystery-9")).kind, "ok");
  const warned = limits.note(row("vic", "t1", 4_000, 0, "mystery-9"));
  assert.equal(warned.kind, "warn");
  assert.match((warned as { text: string }).text, /8k tokens of 10k tokens unpriced[\s\S]*Unpriced model \(no rate in config.json, counted in tokens\): mystery-9/);
  const hit = limits.note(row("vic", "t1", 2_000, 0, "mystery-9"));
  assert.equal(hit.kind, "hit_wake");
  assert.match((hit as { report: string }).report, /mystery-9/);
  assert.deepEqual(limits.today("vic").unpricedModels, ["mystery-9"]);
  assert.equal(limits.today("vic").unpricedTokens, 10_000);
});

test("limits are validated and persisted; null returns to the defaults; today's rows are the local day's successful ones", () => {
  const path = join(mkdtempSync(join(tmpdir(), "agentbox-spend-")), "spend-limits.jsonl");
  try {
    const { limits, clock } = harness({ path });
    assert.throws(() => limits.setLimits("vic", { perDay: 0 }), /perDay must be a positive number/);
    assert.throws(() => limits.setLimits("vic", { nope: 1 } as never), /Unknown limit nope/);
    assert.equal(limits.setLimits("vic", { perDay: 50 }).perDay, 50);
    assert.equal(harness({ path, clock }).limits.limitsOf("vic").perDay, 50);
    assert.deepEqual(limits.setLimits("vic", null), DEFAULT_SPEND_LIMITS);
    assert.deepEqual(harness({ path, clock }).limits.limitsOf("vic"), DEFAULT_SPEND_LIMITS);
    const rows = todaysRows([
      { ...row("vic", "t", 1), at: new Date(2026, 10, 4, 1).toISOString() },
      { ...row("vic", "t", 1), at: new Date(2026, 10, 3, 23).toISOString() },
      { ...row("vic", "t", 1) },
    ], new Date(2026, 10, 4, 12));
    assert.equal(rows.length, 1);
    assert.equal(dayOf(new Date(2026, 0, 9)), "2026-01-09");
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("an unpriced cache read weighs a tenth: Ada's six rounds on 2026-11-05 no longer end the wake, and a runaway still does", () => {
  const { limits } = harness();
  // The rows that ended her turn under 0.3.19: ~90k of context per round, nearly all of it cache reads.
  const ada: [number, number, number][] = [[81_067, 186, 1_702], [83_599, 188, 501], [9_991, 83_787, 288], [4_102, 93_778, 651], [2_320, 97_880, 1_610], [2_545, 100_200, 738]];
  for (const [input, cacheRead, output] of ada) {
    assert.equal(limits.note(row("ada", "t1", input, output, "MiniMax-M3.1-Flash", { cacheReadTokens: cacheRead })).kind, "ok");
  }
  const counted = limits.today("ada").unpricedTokens;
  assert.ok(counted < 250_000, `counted ${counted}`);
  assert.equal(counted, ada.reduce((sum, [input, cacheRead, output]) => sum + input + output + Math.round(cacheRead * 0.1), 0));
  // A turn that keeps going still meets the line: 200 more rounds of the same shape crosses 2M.
  let verdict = "ok";
  for (let i = 0; i < 200 && verdict !== "hit_wake"; i++) verdict = limits.note(row("ada", "t1", 2_500, 700, "MiniMax-M3.1-Flash", { cacheReadTokens: 100_000 })).kind;
  assert.equal(verdict, "hit_wake");
});


test("unreported failed calls hold a conservative allowance across restart without becoming measured spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-reservation-")), path = join(dir, "limits.jsonl");
  try {
    const { limits, clock } = harness({ path });
    limits.setLimits("vic", { perWake: 1, perDay: 2 });
    const hit = limits.reserveUnreported(row("vic", "t1", 1000, 0, "m", { metering: "missing" }));
    assert.equal(hit.kind, "hit_wake");
    assert.equal(limits.today("vic").spent, 0, "a bound is not measured spend");
    assert.equal(limits.today("vic").reserved, 1);
    const restored = harness({ path, clock }).limits;
    assert.equal(restored.today("vic").reserved, 1);
    assert.equal(restored.note(row("vic", "t1", 1)).kind, "hit_wake", "same wake cannot refund a held request on restart");
    const dayHit = restored.reserveUnreported(row("vic", "t2", 1000));
    assert.equal(dayHit.kind, "hit_day");
    assert.match((dayHit as { report: string }).report, /reserved.*not measured spend/);
    clock.now = new Date(2026, 10, 5, 9);
    assert.equal(restored.today("vic").reserved, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
