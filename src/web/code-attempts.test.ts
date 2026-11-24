import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeAttempts } from "./code-attempts.ts";

test("wrong codes are bounded per source and for the whole installation, and the bound lifts when the window passes (INV-2078)", () => {
  let now = 0;
  const attempts = new CodeAttempts({ perSource: 3, overall: 5, windowMs: 60_000 }, () => now);
  assert.equal(attempts.waitFor("a"), undefined, "nobody has tried: anyone may");
  assert.equal(attempts.failed("a"), false);
  attempts.failed("a");
  assert.equal(attempts.failed("a"), true, "the attempt that reaches the limit says so, once, for the log");
  assert.equal(attempts.waitFor("a"), 60, "and the source is told how long to wait");
  assert.equal(attempts.waitFor("b"), undefined, "another source is not held for it");

  attempts.failed("b"); attempts.failed("c");
  assert.equal(attempts.waitFor("d"), 60, "spreading guesses over sources reaches the installation's ceiling");

  now = 30_000;
  assert.equal(attempts.waitFor("d"), 30, "the wait counts down");
  now = 60_001;
  assert.equal(attempts.waitFor("a"), undefined, "once the window has passed the attempts no longer count");
  assert.equal(attempts.waitFor("d"), undefined);
});
