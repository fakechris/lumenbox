/**
 * The change ledger's promise (INV-2213): a sequence that only rises, across a reopen and across
 * compaction; what is older than the window falls off; a `since` it can no longer answer is a reset,
 * never a silent gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeLedger, RETAIN_DAYS } from "./change-ledger.ts";

const DAY = 24 * 3_600_000;

test("the sequence survives a reopen and a torn last line; old lines fall off after the window, the newest stays; a gap past them is a reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  try {
    const path = join(dir, "changes.jsonl");
    let now = Date.parse("2026-10-01T00:00:00Z");
    const clock = () => new Date(now);
    const first = new ChangeLedger(path, () => {}, clock);
    assert.deepEqual(first.after(0), { reset: false, lines: [] }, "an empty ledger answers 0 with nothing");
    for (let n = 1; n <= 3; n += 1) first.append({ type: "work", id: `t${n}`, op: "upsert", requester: "dee" });
    appendFileSync(path, '{"seq":4,"at":"2026-10-01T00:0'); // a crash in the middle of a line

    const reopened = new ChangeLedger(path, () => {}, clock);
    assert.equal(reopened.latest, 3, "the torn line is not a change");
    assert.equal(reopened.append({ type: "agent", id: "a1", op: "upsert", boxId: "b" }).seq, 4, "and the sequence goes on from the last whole one");

    // Past the window everything but the newest line falls off on the next open; the sequence is kept.
    now += (RETAIN_DAYS + 1) * DAY;
    const later = new ChangeLedger(path, () => {}, clock);
    assert.equal(later.latest, 4);
    assert.equal(later.floor, 3, "only the newest is kept: a client at 3 or later is answered");
    assert.deepEqual(later.after(1), { reset: true }, "a client asleep since 1 is told to reload, not handed a gap");
    assert.deepEqual(later.after(3), { reset: false, lines: [later.lastOf("agent").get("a1")] });
    assert.deepEqual(later.after(9), { reset: true }, "a position this ledger never reached: another installation's");
    assert.equal(later.append({ type: "work", id: "t5", op: "upsert" }).seq, 5);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2, "the file holds what is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
