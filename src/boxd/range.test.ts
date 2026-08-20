/**
 * Tests for Range parsing on recording downloads.
 *
 * The suffix form is the one that was wrong, and it is the one video clients actually use: an MP4's
 * moov atom is at the end, so a player's first request is often for the tail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRange } from "./range.ts";

const TOTAL = 10_000;

test("a suffix range means the last bytes, not the first", () => {
  // It used to answer 0-1024 and label it as such in Content-Range, so a player probing for
  // duration read the head of the file and concluded it was broken.
  assert.deepEqual(resolveRange("bytes=-1024", TOTAL), { start: 8_976, end: 9_999 });

  // Larger than the file: the whole thing, not a negative start.
  assert.deepEqual(resolveRange("bytes=-50000", TOTAL), { start: 0, end: 9_999 });
});

test("ordinary ranges are unchanged", () => {
  assert.deepEqual(resolveRange("bytes=0-99", TOTAL), { start: 0, end: 99 });
  assert.deepEqual(resolveRange("bytes=500-", TOTAL), { start: 500, end: 9_999 });
  // An end past the file is clamped rather than refused: it is what a client sends when it does not
  // know the length yet.
  assert.deepEqual(resolveRange("bytes=9990-99999", TOTAL), { start: 9_990, end: 9_999 });
});

test("nonsense is refused, and no header is not a range", () => {
  assert.equal(resolveRange("bytes=10000-", TOTAL), "unsatisfiable");
  assert.equal(resolveRange("bytes=500-100", TOTAL), "unsatisfiable");
  assert.equal(resolveRange("bytes=-", TOTAL), "unsatisfiable");
  assert.equal(resolveRange(undefined, TOTAL), undefined);
  assert.equal(resolveRange("items=1-2", TOTAL), undefined);
});
