/**
 * The verdict a tool result opens with, and the derivation an older box needs.
 *
 * The rule under test is the one that matters: `unknown` is never rendered as success,
 * and a result with no picture of what happened is unknown, not ok.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computerOutcome, effectLine, outcomeLine } from "./index.ts";

test("a computer result with nothing to show for itself is unknown, not ok", () => {
  // Ran, no error, no screenshot: the box could not capture what the actions left
  // behind. Before this it was "success: true" and the model moved on.
  assert.equal(computerOutcome({ success: true, screenshot: "" }), "unknown");
  assert.equal(computerOutcome({ success: true, screenshot: "UklGR" }), "ok");
  assert.equal(computerOutcome({ success: false, screenshot: "UklGR", error: "x" }), "failed");
  // An error with a recovery screenshot is still a failure, not an unknown.
  assert.equal(computerOutcome({ success: false, screenshot: "", error: "x" }), "failed");
});

test("a box that says what it concluded is believed over the derivation", () => {
  assert.equal(computerOutcome({ outcome: "refused", success: true, screenshot: "abc" }), "refused");
});

test("the verdict line says the one thing the model must do with it", () => {
  assert.equal(outcomeLine("ok"), "Outcome: ok.");
  assert.match(outcomeLine("failed", "no such window"), /^Outcome: failed — no such window\./);
  assert.match(outcomeLine("refused", "Rex is using this desktop"), /refused again/);
  const unknown = outcomeLine("unknown");
  assert.match(unknown, /^Outcome: unknown\./);
  assert.match(unknown, /may or may not have taken effect/);
  assert.match(unknown, /do not repeat a write/);
});

test("a batch whose effect could not be measured is unknown, and the effect line says what to do", () => {
  assert.equal(computerOutcome({ success: true, screenshot: "UklGR", effect: "unverifiable" }), "unknown");
  assert.equal(computerOutcome({ success: true, screenshot: "UklGR", effect: "suspected_noop" }), "unknown");
  assert.match(effectLine("suspected_noop", "click@(1,2) suspected_noop 0.0%"), /^Effect: suspected_noop \(click@\(1,2\) suspected_noop 0\.0%\) — nothing near the point changed/);
  assert.match(effectLine("suspected_noop"), /before clicking again/);
  assert.match(effectLine("confirmed"), /legacy change signal/);
  assert.match(effectLine("unverifiable"), /no evidence either way/);
});

test("dispatch, change and verification never collapse into task success", () => {
  const base = { outcome: "ok" as const, success: true, screenshot: "image", progress: { executed_count: 1, dispatch: "sent" as const } };
  for (const effect of ["confirmed", "observed_change", "partial", "suspected_noop", "unverifiable"] as const) {
    assert.equal(computerOutcome({ ...base, effect }), "unknown", `change-only ${effect}`);
  }
  const verification = { status: "satisfied" as const, source: "native" as const, detail: "checked state" };
  assert.equal(computerOutcome({ ...base, verification }), "ok");
  assert.equal(computerOutcome({ ...base, verification: { ...verification, status: "unsatisfied" } }), "failed");
  assert.equal(computerOutcome({ ...base, verification, progress: { executed_count: 1, failed_at: 1, dispatch: "partial" } }), "unknown");
  assert.equal(computerOutcome({ success: true, screenshot: "image" }, true), "unknown", "older daemon cannot verify writes by success=true");
});
