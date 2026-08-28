/**
 * Tests for who pays for the note-taking.
 *
 * Memory extraction runs over a batch of exchanges, and in a team room a batch can span
 * two people. The rule under test is the one that keeps the bill honest: attribute only
 * when the whole batch agrees, because a bill nobody can check is worse than a visible gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { payerOf } from "./remember.ts";

test("a batch that is all one person's bills to that person", () => {
  assert.equal(payerOf(["chris", "chris", "chris"]), "chris");
  assert.equal(payerOf(["chris"]), "chris");
});

test("a mixed batch bills to nobody rather than to a guess", () => {
  // Two colleagues in one room, three exchanges, one extraction. Charging Chris for
  // Sam's half would be an unfalsifiable number in the one place people check costs.
  assert.equal(payerOf(["chris", "sam", "chris"]), undefined);
});

test("work nobody drove stays unattributed, and one unattributed exchange taints the batch", () => {
  // A wake or a scheduled run has no principal at all.
  assert.equal(payerOf([undefined, undefined]), undefined);
  assert.equal(payerOf([]), undefined);
  // Half a batch from a person and half from a timer is not that person's cost either.
  assert.equal(payerOf(["chris", undefined]), undefined);
  assert.equal(payerOf([undefined, "chris"]), undefined);
});
