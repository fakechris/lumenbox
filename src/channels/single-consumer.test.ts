/**
 * The single-consumer lock: the failure it prevents is silent traffic-splitting,
 * so the property that matters is that the second taker is *told*, and that a
 * dead holder does not block a successor forever.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { acquireConsumerLock, lockPathFor } from "./single-consumer.ts";

const APP = `test_${process.pid}_${Date.now()}`;

test("the second taker is refused with the holder's pid; release opens the door", () => {
  const release = acquireConsumerLock(APP);
  try {
    assert.throws(
      () => acquireConsumerLock(APP),
      new RegExp(`pid ${process.pid}.*splits the traffic`, "s")
    );
  } finally {
    release();
  }
  assert.equal(existsSync(lockPathFor(APP)), false, "released is gone");
  acquireConsumerLock(APP)();
});

test("a lock whose owner is dead is taken over, not honoured", () => {
  // A pid that certainly ran and certainly exited: a spawned `true`.
  const dead = spawnSync("true").pid ?? 0;
  writeFileSync(lockPathFor(APP), String(dead));
  const release = acquireConsumerLock(APP);
  release();
});

test("release is idempotent", () => {
  const release = acquireConsumerLock(APP);
  release();
  release();
});
