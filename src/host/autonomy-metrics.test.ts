import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, renderMetrics } from "./autonomy-metrics.ts";

const T0 = Date.parse("2026-09-06T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

test("duty cycle is the union of turn intervals, with both denominators", () => {
  const metrics = computeMetrics({
    turns: [
      JSON.stringify({ id: "a", event: "begin", at: at(0) }),
      JSON.stringify({ id: "a", event: "end", at: at(30), how: "done" }),
      // Overlapping with a: counted once.
      JSON.stringify({ id: "b", event: "begin", at: at(15) }),
      JSON.stringify({ id: "b", event: "end", at: at(45), how: "failed" }),
      // Never ended: busy to the window's end.
      JSON.stringify({ id: "c", event: "begin", at: at(100) }),
    ],
    usage: [
      JSON.stringify({ at: at(5), kind: "turn", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      JSON.stringify({ at: at(6), kind: "memory", inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ],
    schedules: [JSON.stringify({ slug: "digest", event: "finished", at: at(50), tokens: 300, ms: 12_000 })],
    tasks: [JSON.stringify({ id: "t1", history: [{ at: at(10), status: "open" }, { at: at(20), status: "blocked" }, { at: at(40), status: "review" }] })],
    log: [
      `${at(1)} [conduct] Ada: opened with a reply (1 tool calls, text 40 chars)`,
      `${at(2)} [conduct] Ada: interim line delivered (30 chars)`,
      `${at(3)} [conduct] Ada: guard verdict-without-check fired (1/2, 0 tool calls so far): "x"`,
      `${at(4)} [conduct] Ada: guard verdict-without-check complied (tool calls followed)`,
      `${at(-500)} [conduct] Ada: opened tool-first (2 tool calls, text 0 chars)`, // before the window
    ],
    fromMs: T0,
    toMs: T0 + 120 * 60_000,
  });
  assert.equal(metrics.turns.total, 3);
  assert.deepEqual(metrics.turns.byHow, { done: 1, failed: 1, open: 1 });
  // a∪b = 0..45 (45 min), c = 100..120 (20 min) → 65 min of 120.
  assert.equal(Math.round(metrics.dutyCycle.busyHours * 60), 65);
  assert.equal(metrics.dutyCycle.rawPercent.toFixed(1), "54.2");
  assert.equal(metrics.dutyCycle.activeHours, 2);
  assert.equal(metrics.tokens.total, 130);
  assert.deepEqual(metrics.tokens.byKind, { turn: 110, memory: 20 });
  assert.equal(metrics.routines.runs, 1);
  assert.equal(metrics.routines.tokens, 300);
  assert.equal(metrics.interruptions.blockedTasks, 1);
  assert.equal(metrics.interruptions.reviewWaits, 1);
  assert.equal(metrics.conduct.openedWithReply, 1);
  assert.equal(metrics.conduct.openedToolFirst, 0, "the line before the window is not counted");
  assert.equal(metrics.conduct.guardFired, 1);
  assert.equal(metrics.conduct.guardComplied, 1);
  const text = renderMetrics(metrics);
  assert.match(text, /Duty cycle: 54\.2% of the wall clock/);
  assert.match(text, /Interruptions: 1 blocked, 1 waiting for review/);
});

test("failed turns are partitioned by failure class", () => {
  const metrics = computeMetrics({
    turns: [
      JSON.stringify({ id: "a", event: "begin", at: at(0) }),
      JSON.stringify({ id: "a", event: "end", at: at(1), how: "failed", category: "rate_limit" }),
      JSON.stringify({ id: "b", event: "begin", at: at(2) }),
      JSON.stringify({ id: "b", event: "end", at: at(3), how: "failed" }),
    ],
    usage: [], schedules: [], tasks: [], log: [], fromMs: T0, toMs: T0 + 60 * 60_000,
  });
  assert.deepEqual(metrics.turns.failedBy, { rate_limit: 1, unknown: 1 });
  assert.match(renderMetrics(metrics), /failed by class: rate_limit 1, unknown 1/);
});
