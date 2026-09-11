/**
 * The pixel arithmetic behind "did the click do anything".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMeasurement,
  effectOf,
  neighbourhoodOf,
  regionDiff,
  worstEffect,
} from "./effect.ts";

test("the neighbourhood is ±12% of the screen, clamped, even-sized and never tiny", () => {
  const mid = neighbourhoodOf({ x: 640, y: 400 }, { width: 1280, height: 800 });
  assert.deepEqual(mid, { x: 486, y: 304, width: 308, height: 192 });

  // A click in the corner: the region starts at the edge and does not go negative.
  const corner = neighbourhoodOf({ x: 2, y: 3 }, { width: 1280, height: 800 });
  assert.equal(corner.x, 0);
  assert.equal(corner.y, 0);
  assert.ok(corner.width % 2 === 0 && corner.height % 2 === 0);

  // The far edge: clamped to the screen, still a usable size.
  const edge = neighbourhoodOf({ x: 1279, y: 799 }, { width: 1280, height: 800 });
  assert.ok(edge.x + edge.width <= 1280);
  assert.ok(edge.y + edge.height <= 800);
  assert.ok(edge.width >= 8 && edge.height >= 8);
});

test("the diff counts pixels, not channels, and refuses frames of different sizes", () => {
  const before = Buffer.alloc(3 * 100, 0);
  const after = Buffer.from(before);
  // Ten pixels changed hard in one channel; five changed within the noise floor.
  for (let p = 0; p < 10; p++) after[p * 3] = 200;
  for (let p = 10; p < 15; p++) after[p * 3 + 1] = 10;
  assert.equal(regionDiff(before, after), 0.1);
  assert.equal(regionDiff(before, before), 0);
  assert.throws(() => regionDiff(before, Buffer.alloc(3 * 99)), /differ in size/);
});

test("the thresholds: a button repaint confirms, a caret is partial, nothing is a no-op", () => {
  assert.equal(effectOf(0.5), "confirmed");
  assert.equal(effectOf(0.02), "confirmed");
  assert.equal(effectOf(0.01), "partial");
  assert.equal(effectOf(0.002), "partial");
  assert.equal(effectOf(0.001), "suspected_noop");
  assert.equal(effectOf(0), "suspected_noop");
});

test("a batch is as good as its weakest write", () => {
  assert.equal(worstEffect([]), undefined);
  assert.equal(worstEffect(["confirmed", "confirmed"]), "confirmed");
  assert.equal(worstEffect(["confirmed", "partial"]), "partial");
  assert.equal(worstEffect(["confirmed", "suspected_noop", "partial"]), "suspected_noop");
  assert.equal(worstEffect(["suspected_noop", "unverifiable"]), "unverifiable");
});

test("a measurement reads as one short line", () => {
  assert.equal(describeMeasurement("click", { x: 400.4, y: 300 }, "confirmed", 0.081), "click@(400,300) confirmed 8.1%");
  assert.equal(describeMeasurement("key", undefined, "unverifiable"), "key unverifiable");
});
