import assert from "node:assert/strict";
import { test } from "node:test";
import { watchModelStream, waitForRetry } from "./model-stream.ts";
import { classifyFailure, FirstTokenStallError, StreamIdleStallError } from "./transient.ts";

test("deadlines distinguish silent streams from stalled content; bookkeeping cannot keep either alive", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outer = new AbortController(), control = new AbortController();
  const watch = watchModelStream(control, outer.signal, 100, 40);
  watch.event({ type: "message_start" });
  t.mock.timers.tick(99);
  assert.equal(control.signal.aborted, false);
  watch.event({ type: "content_block_start", content_block: { type: "text", text: "" } });
  t.mock.timers.tick(1);
  assert.ok(watch.failure instanceof FirstTokenStallError);
  watch.release();
  const second = new AbortController(), active = watchModelStream(second, outer.signal, 100, 40);
  for (const delta of [{ thinking: "reason" }, { partial_json: '{"id":' }, { text: "hello" }]) {
    active.event({ type: "content_block_delta", delta });
    t.mock.timers.tick(39);
    assert.equal(second.signal.aborted, false, "each kind of model content resets the idle deadline");
  }
  active.event({ type: "message_delta" });
  t.mock.timers.tick(1);
  assert.equal(second.signal.aborted, true);
  assert.ok(active.failure instanceof StreamIdleStallError);
  assert.equal(classifyFailure(active.failure), "transient");
  active.release();
});

test("cancel ends a retry-after wait immediately and released attempts have no deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outer = new AbortController(), control = new AbortController();
  const watch = watchModelStream(control, outer.signal, 100, 40);
  watch.release();
  t.mock.timers.tick(1000);
  assert.equal(control.signal.aborted, false);
  let finished = false;
  const wait = waitForRetry(30000, outer.signal).then(() => { finished = true; });
  outer.abort();
  await wait;
  assert.equal(finished, true);
});
