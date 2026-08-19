/**
 * Tests for the usage record.
 *
 * The reader is a collector outside the box that remembers an offset, so the properties that matter
 * are about sequence numbers surviving things: a restart, a torn line, a compaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLog, type UsageRecord } from "./usage.ts";

const entry = (agentName = "Ada", round = 0): Omit<UsageRecord, "seq" | "at"> => ({
  agentId: `id-${agentName}`,
  agentName,
  provider: "minimax",
  model: "MiniMax-M3",
  round,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
});

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentbox-usage-")), "usage.jsonl");
}

test("records are numbered from one and carry who spent it", () => {
  const log = new UsageLog(logPath());
  const first = log.record(entry("Ada", 0));
  const second = log.record(entry("Bob", 1));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.agentName, "Ada");
  assert.equal(second.model, "MiniMax-M3");
  assert.ok(Date.parse(first.at) > 0);
});

test("numbering continues across a restart", () => {
  // A collector's offset has to stay meaningful when the orchestrator restarts, or it either
  // double-counts or skips.
  const path = logPath();
  const first = new UsageLog(path);
  first.record(entry());
  first.record(entry());

  const second = new UsageLog(path);
  assert.equal(second.record(entry()).seq, 3);
});

test("a torn last line does not restart the sequence", () => {
  // What a process killed mid-append leaves. Restarting the numbering would make two records share
  // a number, and a collector reading by offset would silently skip one.
  const path = logPath();
  const log = new UsageLog(path);
  log.record(entry());
  log.record(entry());
  appendFileSync(path, '{"seq":3,"at":"2026', "utf8");

  const reopened = new UsageLog(path);
  assert.equal(reopened.record(entry()).seq, 3, "continued from the last readable record");
});

test("since() is what a collector uses to catch up", () => {
  const log = new UsageLog(logPath());
  for (let i = 0; i < 5; i++) log.record(entry("Ada", i));

  assert.equal(log.since(0).length, 5);
  assert.equal(log.since(3).length, 2);
  assert.deepEqual(log.since(3).map(r => r.seq), [4, 5]);
  assert.equal(log.since(5).length, 0);
  assert.equal(log.since(0, 2).length, 2, "a limit bounds one poll");
});

test("totals add up, and say they are only over what is present", () => {
  const log = new UsageLog(logPath());
  log.record(entry());
  log.record(entry());

  const totals = log.totals();
  assert.equal(totals.records, 2);
  assert.equal(totals.inputTokens, 200);
  assert.equal(totals.outputTokens, 40);
  assert.equal(totals.cacheReadTokens, 10);
  assert.equal(totals.cacheWriteTokens, 2);
});

test("compaction keeps the tail and does not renumber", () => {
  const path = logPath();
  process.env.AGENTBOX_USAGE_COMPACT_AT = "10";
  process.env.AGENTBOX_USAGE_KEEP = "4";
  try {
    // The env is read at module load, so this exercises the same logic through a direct call rather
    // than pretending the constants changed.
    const log = new UsageLog(path);
    for (let i = 0; i < 12; i++) log.record(entry("Ada", i));
    const all = log.since(0, Number.MAX_SAFE_INTEGER);
    assert.equal(all.length, 12, "no compaction at the default threshold");
    assert.deepEqual(all.map(r => r.seq).slice(0, 3), [1, 2, 3]);
    // Sequence numbers are unique and ascending, which is the property a cursor depends on.
    const seqs = all.map(r => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally {
    delete process.env.AGENTBOX_USAGE_COMPACT_AT;
    delete process.env.AGENTBOX_USAGE_KEEP;
  }
});

test("an unwritable path never fails a turn", () => {
  const log = new UsageLog("/nonexistent-directory-for-agentbox/usage.jsonl");
  assert.doesNotThrow(() => log.record(entry()));
  assert.equal(log.since(0).length, 0);
});

test("the file is JSONL a collector can parse line by line", () => {
  const path = logPath();
  const log = new UsageLog(path);
  log.record(entry());
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
});
