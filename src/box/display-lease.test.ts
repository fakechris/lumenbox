/**
 * Tests for exclusive display access.
 *
 * The failure this prevents is silent — two agents' keystrokes interleaving into
 * one window, and each seeing the other's screen — so the invariant is worth
 * pinning down rather than trusting to review. And the failure the 2026-09-01 fix
 * removed was loud in the wrong place: a single global slot refused Ada her own
 * screen because Bob held his, so the exclusivity is per display, never across.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DisplayLease } from "./display-lease.ts";

test("the first claimant gets a display and its second claimant is refused", () => {
  const lease = new DisplayLease();

  assert.equal(lease.acquire(1, "ada"), true);
  assert.equal(lease.acquire(1, "bob"), false, "a second agent must not get the same screen");
  assert.equal(lease.heldBy(1), "ada");
});

test("agents on their own displays never contend — the 周报-day failure", () => {
  const lease = new DisplayLease();

  // Bob mid-task on his desktop must not cost Ada the browser on hers.
  assert.equal(lease.acquire(2, "bob"), true);
  assert.equal(lease.acquire(1, "ada"), true, "her own screen, no colleague can refuse it");
  assert.equal(lease.heldBy(1), "ada");
  assert.equal(lease.heldBy(2), "bob");
});

test("the holder can re-acquire, so a turn may use the computer repeatedly", () => {
  const lease = new DisplayLease();

  assert.equal(lease.acquire(1, "ada"), true);
  assert.equal(lease.acquire(1, "ada"), true);
  assert.equal(lease.heldBy(1), "ada");
});

test("releaseAll hands the display to the next claimant, and only the holder's own", () => {
  const lease = new DisplayLease();

  lease.acquire(1, "ada");
  assert.equal(lease.acquire(1, "bob"), false);

  // Bob was refused, so his turn's cleanup must not free Ada's lease.
  lease.releaseAll("bob");
  assert.equal(lease.heldBy(1), "ada", "ada still holds it");

  lease.releaseAll("ada");
  assert.equal(lease.heldBy(1), undefined);
  assert.equal(lease.acquire(1, "bob"), true, "bob can take it once ada is done");
});

test("releasing when nothing is held is harmless", () => {
  const lease = new DisplayLease();
  lease.releaseAll("nobody");
  assert.equal(lease.heldBy(1), undefined);
  assert.equal(lease.acquire(1, "ada"), true);
});

test("hold duration is reported for diagnostics and reset on release", async () => {
  const lease = new DisplayLease();
  assert.equal(lease.heldForMs(1), 0, "nothing held yet");

  lease.acquire(1, "ada");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(lease.heldForMs(1) >= 15, "elapsed time is tracked while held");

  lease.releaseAll("ada");
  assert.equal(lease.heldForMs(1), 0, "reset once free");
});
