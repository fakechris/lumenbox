/**
 * Tests for snapshotting the state that cannot be rebuilt.
 *
 * The box is an image and `/home/box/work` is a volume; `~/.agentbox` is neither. The documented
 * backup was `box down` then `cp -a`, by hand — which requires stopping, so it does not happen, and
 * requires remembering, so it does not happen either. The day it matters is the day it has not been
 * done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupSchedule, KEEP_BACKUPS, backupNow } from "./backup.ts";

function state() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-state-"));
  mkdirSync(join(dir, "agents", "agent-1"), { recursive: true });
  writeFileSync(join(dir, "agents", "agent-1", "transcript.jsonl"), '{"role":"user","text":"hi"}\n');
  writeFileSync(join(dir, "usage.jsonl"), '{"seq":1}\n');
  const to = mkdtempSync(join(tmpdir(), "agentbox-backups-"));
  return { dir, to, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(to, { recursive: true, force: true }); } };
}

test("a snapshot copies the whole tree and says what it took", () => {
  const { dir, to, cleanup } = state();
  try {
    const result = backupNow({ stamp: "2026-08-20T10-00-00", from: dir, to });
    assert.equal(result.files, 2);
    assert.ok(result.bytes > 0);
    assert.equal(
      readFileSync(join(result.path, "agents", "agent-1", "transcript.jsonl"), "utf8"),
      '{"role":"user","text":"hi"}\n'
    );
  } finally {
    cleanup();
  }
});

test("a torn last line is copied as it is, because that is what readers already expect", () => {
  // The reason no stopping is needed. Every file here is append-only JSONL or an atomically
  // replaced document, and every reader in this codebase skips a torn line — because that is also
  // what a crash leaves behind. The old instruction to stop first solved a problem the formats had
  // already solved.
  const { dir, to, cleanup } = state();
  try {
    writeFileSync(join(dir, "usage.jsonl"), '{"seq":1}\n{"seq":2,"at":"2026');
    const result = backupNow({ stamp: "s1", from: dir, to });
    assert.match(readFileSync(join(result.path, "usage.jsonl"), "utf8"), /\{"seq":2,"at":"2026$/);
  } finally {
    cleanup();
  }
});

test("snapshots accumulate and the oldest are pruned by count", () => {
  const { dir, to, cleanup } = state();
  try {
    // Count rather than age: a machine that was off for a month still has its backups, where
    // "delete older than a week" would have thrown them all away on the first run after.
    for (let index = 0; index < KEEP_BACKUPS + 3; index++) {
      backupNow({ stamp: `2026-08-20T10-00-${String(index).padStart(2, "0")}`, from: dir, to });
    }
    const kept = readdirSync(to).sort();
    assert.equal(kept.length, KEEP_BACKUPS);
    assert.equal(kept.at(-1), `2026-08-20T10-00-0${KEEP_BACKUPS + 2}`);
  } finally {
    cleanup();
  }
});

test("a half-finished copy is never left under a snapshot's name", () => {
  const { dir, to, cleanup } = state();
  try {
    const result = backupNow({ stamp: "s1", from: dir, to });
    assert.ok(existsSync(result.path));
    assert.deepEqual(
      readdirSync(to).filter(name => name.endsWith(".partial")),
      [],
      "the staging directory is gone, so nothing half-copied carries a real name"
    );
  } finally {
    cleanup();
  }
});

test("a failing backup is reported and does not stop anything", () => {
  // A full disk must not take down the agents it exists to protect.
  const lines: string[] = [];
  const schedule = new BackupSchedule({
    intervalMs: 0,
    log: line => lines.push(line),
    run: () => {
      throw new Error("no space left on device");
    },
  });
  schedule.once();
  assert.ok(lines.some(line => /backup failed: no space left on device/.test(line)));
});

test("a scheduled backup names itself for the moment it was taken", () => {
  const lines: string[] = [];
  const taken: string[] = [];
  const schedule = new BackupSchedule({
    intervalMs: 0,
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    log: line => lines.push(line),
    run: stamp => {
      taken.push(stamp);
      return { path: `/backups/${stamp}`, bytes: 2048, files: 3, pruned: ["old"] };
    },
  });
  schedule.once();
  assert.deepEqual(taken, ["2026-08-20T10-00-00"]);
  assert.match(lines[0] ?? "", /backed up 3 files \(2KB\)/);
  assert.match(lines[0] ?? "", /pruned 1/);
});


test("a backup is not readable by anyone who happens to be on the machine", () => {
  // It is a second copy of everything, including the box token, the UI token and the control-plane
  // database. Files keep their own modes so the credentials stay 0600 — but transcripts do not, and
  // a transcript is where a secret an agent read ends up.
  const { dir, to, cleanup } = state();
  try {
    const result = backupNow({ stamp: "s1", from: dir, to });
    assert.equal(statSync(result.path).mode & 0o777, 0o700);
    assert.equal(statSync(to).mode & 0o777, 0o700);
  } finally {
    cleanup();
  }
});
