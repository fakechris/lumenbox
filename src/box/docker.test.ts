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
import { SPOOL_DIR } from "../boxd/shell-service.ts";

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
