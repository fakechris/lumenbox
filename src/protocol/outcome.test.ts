/**
 * The verdict a tool result opens with, and the derivation an older box needs.
 *
 * The rule under test is the one that matters: `unknown` is never rendered as success,
 * and a result with no picture of what happened is unknown, not ok.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computerOutcome, outcomeLine } from "./index.ts";

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
