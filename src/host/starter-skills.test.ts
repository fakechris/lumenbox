/**
 * Tests for which starter skills a box is offered.
 *
 * The decision under test carried a real bug: seeding only into an empty directory
 * meant a starter added later — `study-a-corpus` — could never reach a box that already
 * had the original three. Written, tested, committed, absent at runtime (docs/14). The
 * decision is now a pure function precisely so these cases run without a box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { unseededStarters } from "./starter-skills.ts";

const starters = [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }];

test("a fresh box is offered everything", () => {
  assert.deepEqual(unseededStarters(undefined, [], starters), ["alpha", "beta", "gamma"]);
});

test("a starter added after the first seeding still arrives", () => {
  // The bug this replaces: alpha and beta on disk meant gamma never got offered.
  assert.deepEqual(unseededStarters("alpha\nbeta\n", ["alpha", "beta"], starters), ["gamma"]);
});

test("a deleted starter stays deleted", () => {
  // beta was offered once and is no longer on disk: that is a decision, not a gap.
  assert.deepEqual(unseededStarters("alpha\nbeta\ngamma\n", ["alpha", "gamma"], starters), []);
});

test("a pre-marker install is only offered what it has never had", () => {
  // No marker, but skills on disk: those were offered, whatever offered them.
  assert.deepEqual(unseededStarters(undefined, ["alpha", "beta"], starters), ["gamma"]);
});

test("a torn or padded marker still reads", () => {
  assert.deepEqual(unseededStarters("  alpha  \n\n\nbeta", ["other-skill"], starters), ["gamma"]);
});
