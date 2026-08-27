/**
 * Tests for what a volume archive is allowed to carry out of the box.
 *
 * A backup exists so nothing unrebuildable is lost. The spool is the opposite of that: a
 * 24-hour buffer holding the *untruncated* output of every command an agent ran — the
 * text the transcript deliberately keeps only 2 KB of, and the likeliest place a
 * `cat .env` or a token-bearing build log survives in full. It was in every upgrade
 * archive, which turned an expiring buffer inside the container into a permanent copy
 * outside it, in a directory nobody reviews (docs/15).
 *
 * A unit test rather than an end-to-end one: the archive is built by `tar` inside a
 * container, so the thing worth pinning here is the exclude list itself and the fact that
 * the spool path it names is the path the box actually writes to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_EXCLUDES } from "./docker.ts";
import { SPILL_AT_BYTES, SPOOL_DIR } from "../boxd/shell-service.ts";
import { DURABLE_RESULT_CHARS } from "../protocol/index.ts";
import { readFileSync } from "node:fs";

test("the spool does not travel out of the box in a backup", () => {
  assert.ok(
    BACKUP_EXCLUDES.includes("./.spool"),
    `the spool must be excluded from volume archives; excludes are ${BACKUP_EXCLUDES.join(", ")}`
  );
});

test("the excluded path is the path the box actually spools to", () => {
  // The exclude is written relative to the volume root, because that is what `tar -C /src`
  // sees. If the daemon's SPOOL_DIR ever moves out from under /home/box/work, the exclude
  // silently stops matching and the leak comes back — which is exactly the shape of bug
  // this test exists to catch, so it is pinned to the constant rather than to a string.
  const WORK_ROOT = "/home/box/work";
  assert.ok(
    SPOOL_DIR.startsWith(`${WORK_ROOT}/`),
    `SPOOL_DIR (${SPOOL_DIR}) is expected to live under the work volume`
  );
  const relative = `.${SPOOL_DIR.slice(WORK_ROOT.length)}`;
  assert.ok(
    BACKUP_EXCLUDES.includes(relative),
    `the exclude list does not cover ${relative}; it has ${BACKUP_EXCLUDES.join(", ")}`
  );
});

test("the spool's location cannot be moved out from under the exclusion", () => {
  // The test above pins the exclusion to SPOOL_DIR's *value*, which was not enough: the
  // constant used to read `process.env.BOXD_SPOOL_DIR ?? …`, so a daemon started with
  // that variable set spooled somewhere the literal exclusion did not cover, and every
  // upgrade archive carried the output again. The adversarial review of docs/15 found it.
  // A test that reads the same environment as the code cannot catch that, so this asserts
  // the property that makes it impossible: the path is fixed.
  const source = readFileSync(new URL("../boxd/shell-service.ts", import.meta.url), "utf8");
  const declaration = /export const SPOOL_DIR\s*=\s*([^;]+);/.exec(source)?.[1] ?? "";
  assert.ok(
    !/process\.env/.test(declaration),
    `SPOOL_DIR must not be configurable, or the backup exclusion is a lie; got: ${declaration.trim()}`
  );
});

test("spilling happens before anything durable is truncated", () => {
  // Three thresholds existed and this one was measured against the wrong one: spilling
  // began at 16KB while the transcript kept 2KB, so a 2,500-character result was shown to
  // the model whole, stored as a head, and given no pointer to its tail.
  assert.ok(
    SPILL_AT_BYTES <= DURABLE_RESULT_CHARS,
    `output is spilled at ${SPILL_AT_BYTES} bytes but only ${DURABLE_RESULT_CHARS} ` +
      `characters survive durably, so results between the two lose their tail with no pointer`
  );
});
