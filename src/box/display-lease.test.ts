/**
 * Tests for exclusive display access.
 *
 * The failure this prevents is silent — two agents' keystrokes interleaving into
 * one window, and each seeing the other's screen — so the invariant is worth
 * pinning down rather than trusting to review.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DisplayLease } from "./display-lease.ts";

test("the first claimant gets the display and the second is refused", () => {
  const lease = new DisplayLease();

  assert.equal(lease.acquire("ada"), true);
  assert.equal(lease.acquire("bob"), false, "a second agent must not get the screen");
  assert.equal(lease.heldBy(), "ada");
});

test("the holder can re-acquire, so a turn may use the computer repeatedly", () => {
  const lease = new DisplayLease();

  assert.equal(lease.acquire("ada"), true);
  assert.equal(lease.acquire("ada"), true);
  assert.equal(lease.acquire("ada"), true);
  assert.equal(lease.heldBy(), "ada");
});

test("release hands the display to the next claimant", () => {
  const lease = new DisplayLease();

  lease.acquire("ada");
  assert.equal(lease.acquire("bob"), false);

  lease.release("ada");
  assert.equal(lease.heldBy(), undefined);
  assert.equal(lease.acquire("bob"), true, "bob can take it once ada is done");
  assert.equal(lease.heldBy(), "bob");
});

test("a non-holder cannot release the display out from under the holder", () => {
  const lease = new DisplayLease();

  lease.acquire("ada");
  // Bob was refused, so his turn's cleanup must not free Ada's lease.
  lease.release("bob");

  assert.equal(lease.heldBy(), "ada", "ada still holds it");
  assert.equal(lease.acquire("bob"), false);
});

test("releasing an unheld display is harmless", () => {
  const lease = new DisplayLease();
  lease.release("nobody");
  assert.equal(lease.heldBy(), undefined);
  assert.equal(lease.acquire("ada"), true);
});

test("hold duration is reported for diagnostics and reset on release", async () => {
  const lease = new DisplayLease();
  assert.equal(lease.heldForMs(), 0, "nothing held yet");

  lease.acquire("ada");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(lease.heldForMs() >= 15, "elapsed time is tracked while held");

  lease.release("ada");
  assert.equal(lease.heldForMs(), 0, "reset once free");
});
