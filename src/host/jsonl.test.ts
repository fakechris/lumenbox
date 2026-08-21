/**
 * Tests for safe append to an append-only JSONL file.
 *
 * The bug: every durable log here tolerates a torn final line on read, but the writers did not close
 * one before appending the next record, so a crash-torn line and the new record became a single
 * unparseable line — and the new record, which should have been written, was silently lost. This is
 * the same "append-only tolerates torn lines" claim, violated on the write side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine } from "./jsonl.ts";

function tmp(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-jsonl-"));
  return { path: join(dir, "log.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const parseable = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });

test("appending after a torn line does not swallow the new record", () => {
  const { path, cleanup } = tmp();
  try {
    // A valid record, then a torn one with no trailing newline — what a crash mid-append leaves.
    writeFileSync(path, '{"seq":1,"ok":true}\n{"seq":2,"torn":');
    appendLine(path, JSON.stringify({ seq: 3, ok: true }));

    const records = parseable(path);
    // The torn line is skipped (null); the intact ones are seq 1 and seq 3. The new record survived.
    assert.deepEqual(
      records.filter(Boolean).map(r => (r as { seq: number }).seq),
      [1, 3]
    );
    // And the torn fragment is on its own line, not fused to the new record.
    const lines = readFileSync(path, "utf8").split("\n").filter(l => l.trim() !== "");
    assert.ok(lines.some(l => l === '{"seq":2,"torn":'), "the torn line stands alone");
  } finally {
    cleanup();
  }
});

test("a normal append writes exactly one line and no leading blank", () => {
  const { path, cleanup } = tmp();
  try {
    appendLine(path, JSON.stringify({ a: 1 }));
    appendLine(path, JSON.stringify({ a: 2 }));
    assert.equal(readFileSync(path, "utf8"), '{"a":1}\n{"a":2}\n');
  } finally {
    cleanup();
  }
});

test("appending to a missing file creates it cleanly", () => {
  const { path, cleanup } = tmp();
  try {
    appendLine(path, JSON.stringify({ first: true }));
    assert.equal(readFileSync(path, "utf8"), '{"first":true}\n');
  } finally {
    cleanup();
  }
});
