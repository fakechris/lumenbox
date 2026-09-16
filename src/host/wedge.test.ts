/**
 * A box that is alive and stuck (INV-135). The case this exists for is the one that used
 * to look like a busy box: the daemon is up, the socket is open, every call hangs, and
 * nothing told anybody until a person asked why their morning had not moved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOW_AFTER_MS, WEDGED_AFTER_MS, WedgeWatch } from "./wedge.ts";

const T0 = Date.parse("2026-09-16T02:00:00Z");

test("answering is ok, silence under the window is ok, and a long silence is wedged", () => {
  const watch = new WedgeWatch();
  watch.asked("b1", "agentbox-box", T0);
  watch.answered("b1", T0 + 40);
  assert.deepEqual(watch.assess(T0 + 60).map(v => [v.boxId, v.state]), [["b1", "ok"]]);

  // Asked again and nothing came back.
  watch.asked("b1", "agentbox-box", T0 + 1_000);
  assert.equal(watch.assess(T0 + 1_000 + 30_000)[0]?.state, "ok", "half a minute of silence is a slow call, not a verdict");
  assert.equal(watch.assess(T0 + 1_000 + SLOW_AFTER_MS)[0]?.state, "slow");

  const wedged = watch.assess(T0 + 1_000 + WEDGED_AFTER_MS)[0];
  assert.equal(wedged?.state, "wedged");
  assert.match(wedged!.detail, /up and stuck, not gone/);
  assert.match(wedged!.detail, /Restarting the box is what fixes this/);

  // And an answer clears it, however late.
  watch.answered("b1", T0 + 1_000 + WEDGED_AFTER_MS + 5_000);
  assert.equal(watch.assess(T0 + 1_000 + WEDGED_AFTER_MS + 6_000)[0]?.state, "ok");
});

test("a box nobody asks anything about is not a problem", () => {
  const watch = new WedgeWatch();
  // Never asked at all: no verdict exists.
  assert.deepEqual(watch.assess(T0), []);
  // Asked once, answered, then left alone for a day: still ok, because nothing is outstanding.
  watch.asked("b2", "grok", T0);
  watch.answered("b2", T0 + 10);
  assert.equal(watch.assess(T0 + 86_400_000)[0]?.state, "ok");
  watch.forget("b2");
  assert.deepEqual(watch.assess(T0), []);
});

test("a verdict is said when it changes, and not repeated every minute", () => {
  const watch = new WedgeWatch();
  const told = new Map<string, "ok" | "slow" | "wedged" | "quiet">();
  watch.asked("b1", "agentbox-box", T0);

  assert.deepEqual(watch.changed(told, T0 + 1_000), [], "nothing to say while it is merely slow to answer");
  const first = watch.changed(told, T0 + WEDGED_AFTER_MS);
  assert.deepEqual(first.map(v => v.state), ["wedged"], "said once, when it becomes true");
  assert.deepEqual(watch.changed(told, T0 + WEDGED_AFTER_MS + 60_000), [], "and not again a minute later");

  // Recovery is worth one line too, so somebody who was woken knows it is over.
  watch.answered("b1", T0 + WEDGED_AFTER_MS + 120_000);
  const recovered = watch.changed(told, T0 + WEDGED_AFTER_MS + 121_000);
  assert.deepEqual(recovered.map(v => v.state), ["ok"]);
  assert.deepEqual(watch.changed(told, T0 + WEDGED_AFTER_MS + 180_000), []);
});
