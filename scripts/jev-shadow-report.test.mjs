/** The shadow report (INV-1415): agreement per point, failures counted apart, disagreements listed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { agreement, report } from "./jev-shadow-report.mjs";

test("agreement reads each point's summary the way the point recorded it", () => {
  assert.equal(agreement({ tool: "bash", call: "a1", verdict: "ALLOW" }, { tool: "bash", call: "a1", verdict: "BLOCK" }), 0);
  assert.equal(agreement("PASS@0.80", "PASS@0.99"), 1);
  assert.equal(agreement([1, 2], [2, 3]), 1 / 3);
  assert.equal(agreement(["fromContent=y0.90 narrowsRules=n0.80"], ["fromContent=y0.70 narrowsRules=y0.60"]), 0.5);
});

test("the report counts failures apart and lists disagreements", () => {
  const lines = [
    JSON.stringify({ at: "t1", point: "auto_review", own: { verdict: "ALLOW" }, jev: { verdict: "ALLOW" } }),
    JSON.stringify({ at: "t2", point: "auto_review", own: { verdict: "ALLOW" }, jev: { verdict: "BLOCK" } }),
    JSON.stringify({ at: "t3", point: "auto_review", own: { verdict: "BLOCK" }, error: "timeout" }),
    "not json",
  ];
  const [row] = report(lines);
  assert.equal(row.point, "auto_review");
  assert.equal(row.compared, 2);
  assert.equal(row.failed, 1);
  assert.equal(row.agreement, 0.5);
  assert.equal(row.disagreements[0].at, "t2");
});

test("the call report gives count, failures, time quantiles and tokens per point", async () => {
  const { callReport } = await import("./jev-shadow-report.mjs");
  const lines = [
    { point: "memory_select", ms: 200, inputTokens: 300 },
    { point: "memory_select", ms: 400, inputTokens: 500 },
    { point: "memory_select", ms: 900, error: "timeout" },
  ].map(entry => JSON.stringify(entry));
  const [row] = callReport(lines);
  assert.deepEqual(row, { point: "memory_select", calls: 3, failed: 1, p50: 400, p95: 900, tokens: 800 });
});
