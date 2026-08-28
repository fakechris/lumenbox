/**
 * Tests for the durable card ledger.
 *
 * The claim that matters is survival: a record written by one process is readable by
 * the next, because the two lies this ledger removes — a restart orphaning cards at
 * 进行中, an acceptance that cannot turn its card green — are both process-boundary
 * failures. The rest is the house jsonl discipline: torn tails cost one line, closed
 * entries stay closed after compaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardLedger, type CardRecord } from "./card-ledger.ts";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-cards-"));
  return { path: join(dir, "cards.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function record(taskId: string, status: CardRecord["card"]["status"] = "working"): CardRecord {
  return {
    taskId,
    adapter: "feishu",
    handle: `om_${taskId}`,
    card: { title: "整理报表", agentName: "Ada", requesterLabel: "chris", status, taskId },
  };
}

test("a record written by one process is readable by the next", () => {
  const { path, cleanup } = tempPath();
  try {
    const first = new CardLedger(path);
    first.record(record("t7"));
    // A new instance over the same file is the restart.
    const second = new CardLedger(path);
    const found = second.get("t7");
    assert.equal(found?.handle, "om_t7");
    assert.equal(found?.card.status, "working");
    assert.equal(found?.adapter, "feishu");
  } finally {
    cleanup();
  }
});

test("closing is durable too: a green card stays gone after a restart", () => {
  const { path, cleanup } = tempPath();
  try {
    const first = new CardLedger(path);
    first.record(record("t7"));
    first.close("t7");
    assert.equal(first.get("t7"), undefined);
    const second = new CardLedger(path);
    assert.equal(second.get("t7"), undefined);
  } finally {
    cleanup();
  }
});

test("the latest record per task wins, and get hands out copies, not the ledger's own state", () => {
  const ledger = new CardLedger(null);
  ledger.record(record("t7", "working"));
  ledger.record(record("t7", "review"));
  const copy = ledger.get("t7")!;
  copy.card.status = "failed";
  assert.equal(ledger.get("t7")!.card.status, "review");
});

test("a torn last line costs one update, not the ledger", () => {
  const { path, cleanup } = tempPath();
  try {
    const first = new CardLedger(path);
    first.record(record("t7"));
    appendFileSync(path, '{"kind":"card","record":{"taskId":"t8"', "utf8");
    const second = new CardLedger(path);
    assert.equal(second.get("t7")?.handle, "om_t7");
    assert.equal(second.get("t8"), undefined);
  } finally {
    cleanup();
  }
});

test("compaction keeps every open card and lets closed ones go", () => {
  const { path, cleanup } = tempPath();
  try {
    process.env.AGENTBOX_CARDS_COMPACT_AT = "5";
    const ledger = new CardLedger(path);
    ledger.record(record("t1"));
    ledger.record(record("t2"));
    ledger.close("t1");
    for (let i = 0; i < 6; i++) ledger.record(record("t2", "review"));
    const raw = readFileSync(path, "utf8");
    assert.doesNotMatch(raw, /"t1"/, "the closed card's history is gone");
    const reread = new CardLedger(path);
    assert.equal(reread.get("t2")?.card.status, "review");
    assert.equal(reread.get("t1"), undefined);
  } finally {
    delete process.env.AGENTBOX_CARDS_COMPACT_AT;
    cleanup();
  }
});
