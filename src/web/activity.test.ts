/**
 * Tests for the activity history.
 *
 * The case that matters most is survival: an instance loading what a previous one
 * wrote. That is the bug these guard — the feed used to be emptied by a restart while
 * claiming to keep the last 400 events.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLog } from "./activity.ts";

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentbox-activity-")), "activity.jsonl");
}

/** Fixed clock: Date.now() in a test makes the assertions depend on the machine. */
function clock(start = 0): () => string {
  let tick = start;
  return () => new Date(Date.UTC(2026, 7, 18, 0, 0, tick++)).toISOString();
}

test("history survives a restart", () => {
  const path = logPath();
  const first = new ActivityLog({ path, limit: 400, now: clock() });
  first.add({ type: "turn_started", agentId: "a" });
  first.add({ type: "tool_start", agentId: "a", tool: "bash" });

  const second = new ActivityLog({ path, limit: 400, now: clock(10) });
  assert.deepEqual(
    second.list().map(event => event.type),
    ["turn_started", "tool_start"]
  );
  // And keeps appending to what it loaded, rather than starting over.
  second.add({ type: "turn_finished", agentId: "a" });
  assert.equal(new ActivityLog({ path, limit: 400 }).list().length, 3);
});

test("every event carries the time it happened", () => {
  const path = logPath();
  const log = new ActivityLog({ path, limit: 10, now: clock() });
  const stored = log.add({ type: "turn_started", agentId: "a" });

  assert.equal(stored.at, "2026-08-18T00:00:00.000Z");
  assert.equal(log.list()[0]!.at, stored.at);
});

test("only the limit is kept, and the oldest go first", () => {
  const path = logPath();
  const log = new ActivityLog({ path, limit: 3, now: clock() });
  for (const id of ["1", "2", "3", "4", "5"]) log.add({ type: "tool_start", tool: id });

  assert.deepEqual(log.list().map(event => event.tool), ["3", "4", "5"]);
  assert.deepEqual(
    new ActivityLog({ path, limit: 3 }).list().map(event => event.tool),
    ["3", "4", "5"]
  );
});

test("a lower limit than the file holds still loads the newest", () => {
  const path = logPath();
  const wide = new ActivityLog({ path, limit: 50, now: clock() });
  for (const id of ["1", "2", "3", "4", "5"]) wide.add({ type: "tool_start", tool: id });

  const narrow = new ActivityLog({ path, limit: 2 });
  assert.deepEqual(narrow.list().map(event => event.tool), ["4", "5"]);
});

test("the file is compacted once it grows past the limit", () => {
  const path = logPath();
  const log = new ActivityLog({ path, limit: 2, now: clock() });
  for (let i = 0; i < 20; i++) log.add({ type: "tool_start", tool: String(i) });

  const lines = readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== "");
  assert.ok(lines.length <= 2 * 3, `file grew to ${lines.length} lines`);
  assert.deepEqual(log.list().map(event => event.tool), ["18", "19"]);
  assert.ok(!existsSync(`${path}.${process.pid}.tmp`), "temp file left behind");
});

test("a partial last line costs one event, not the history", () => {
  // What a process killed mid-append leaves behind.
  const path = logPath();
  const warnings: string[] = [];
  writeFileSync(
    path,
    '{"type":"turn_started","at":"t1"}\n{"type":"tool_start","at":"t2"}\n{"type":"tool_',
    "utf8"
  );

  const log = new ActivityLog({ path, limit: 10, onWarn: line => warnings.push(line) });
  assert.deepEqual(log.list().map(event => event.type), ["turn_started", "tool_start"]);
  assert.match(warnings[0]!, /skipped 1 unreadable/);
});

test("an unwritable path does not break the feed", () => {
  const warnings: string[] = [];
  const log = new ActivityLog({
    path: "/nonexistent-directory-for-agentbox/activity.jsonl",
    limit: 10,
    onWarn: line => warnings.push(line),
  });

  log.add({ type: "turn_started", agentId: "a" });
  // Still usable in memory; the failure is reported, not thrown.
  assert.equal(log.list().length, 1);
  assert.match(warnings[0]!, /cannot write/);
});
