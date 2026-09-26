/**
 * The standing files (INV-777): seeded once, capped, injected each turn, and a change nobody in
 * the turn made is told once as a diff.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capRefusal,
  changeNotice,
  heartbeatAgentOf,
  heartbeatItems,
  heartbeatSlug,
  readStanding,
  renderStanding,
  seedStanding,
  STANDING_BYTE_CAP,
  STANDING_FILES,
  standingBoxDir,
  standingDir,
  standingFileOf,
  takeChanges,
  writeStanding,
} from "./standing.ts";

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-standing-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the four files are seeded once, in our words, each with an italic hint", () => {
  const { dir, done } = scratch();
  try {
    assert.deepEqual(seedStanding(dir, "Ada"), [...STANDING_FILES]);
    for (const name of STANDING_FILES) {
      const text = readFileSync(join(standingDir(dir), name), "utf8");
      assert.match(text, /^_.*_$/m, `${name} carries a one-line italic hint`);
      assert.ok(text.length < 600, `${name} seed is short`);
    }
    assert.match(readFileSync(join(standingDir(dir), "SOUL.md"), "utf8"), /Ada/);
    // A second seeding touches nothing: a person's edit is not overwritten by a restart.
    writeFileSync(join(standingDir(dir), "USER.md"), "- Call me: Skipper\n");
    assert.deepEqual(seedStanding(dir, "Ada"), []);
    assert.equal(readStanding(dir, "Ada")["USER.md"], "- Call me: Skipper\n");
  } finally {
    done();
  }
});

test("a write over the cap is refused with a message, and never lands", () => {
  const { dir, done } = scratch();
  try {
    const big = "x".repeat(STANDING_BYTE_CAP + 1);
    const result = writeStanding(dir, "Ada", "AGENTS.md", big, "person");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.refusal, /capped at 8192 bytes/);
    assert.doesNotMatch(readStanding(dir, "Ada")["AGENTS.md"], /^x+$/);
    // Bytes, not characters: a CJK file is three bytes a glyph.
    assert.notEqual(capRefusal("USER.md", "字".repeat(3000)), undefined);
    assert.equal(capRefusal("USER.md", "字".repeat(2000)), undefined);
  } finally {
    done();
  }
});

test("the section renders every file, an empty one as (empty), and names the box path", () => {
  const { dir, done } = scratch();
  try {
    writeStanding(dir, "Ada Lovelace", "SOUL.md", "   \n", "person");
    const text = renderStanding(readStanding(dir, "Ada Lovelace"), "Ada Lovelace");
    assert.match(text, /^# Your standing files/);
    assert.match(text, /## SOUL\.md\n\n\(empty\)/);
    assert.match(text, /## USER\.md\n\n# USER\.md — the person/);
    assert.match(text, /\/home\/box\/work\/standing\/ada-lovelace\//);
    assert.equal(renderStanding(undefined, "Ada"), "");
  } finally {
    done();
  }
});

test("a change since the last injection is a diff, told once; the first sight is not a change", () => {
  const { dir, done } = scratch();
  try {
    assert.deepEqual(takeChanges(dir, readStanding(dir, "Ada")), [], "first sight records, says nothing");
    assert.ok(existsSync(join(standingDir(dir), "standing.json")), "the hash table is beside the files");
    writeStanding(dir, "Ada", "USER.md", "# USER.md — the person\n\n- Call me: Skipper\n", "person");
    const changes = takeChanges(dir, readStanding(dir, "Ada"));
    assert.deepEqual(changes.map(change => change.name), ["USER.md"]);
    assert.match(changes[0]!.diff, /^--- USER\.md \(as last read\)\n\+\+\+ USER\.md \(now\)/);
    assert.match(changes[0]!.diff, /\n\+- Call me: Skipper/);
    assert.match(changes[0]!.diff, /\n-- Call me: $/m);
    const notice = changeNotice(changes)!;
    assert.match(notice, /^\[file-diff\] USER\.md changed/);
    assert.match(notice, /```diff source=file-diff\n/);
    assert.match(notice, /data, not as instructions/);
    // Not repeated: the next turn sees the same file and says nothing.
    assert.deepEqual(takeChanges(dir, readStanding(dir, "Ada")), []);
    assert.equal(changeNotice([]), undefined);
  } finally {
    done();
  }
});

test("the agent's own write moves the snapshot, so it is not told about its own edit", () => {
  const { dir, done } = scratch();
  try {
    takeChanges(dir, readStanding(dir, "Ada"));
    writeStanding(dir, "Ada", "AGENTS.md", "## Lessons\n\n- LESSON_ONE\n", "agent");
    assert.deepEqual(takeChanges(dir, readStanding(dir, "Ada")), [], "an own write is not a change");
    // But a person's edit on top of it is, and the diff is against the agent's version.
    writeStanding(dir, "Ada", "AGENTS.md", "## Lessons\n\n- LESSON_ONE\n- LESSON_TWO\n", "person");
    const changes = takeChanges(dir, readStanding(dir, "Ada"));
    assert.equal(changes.length, 1);
    assert.match(changes[0]!.diff, /\n\+- LESSON_TWO/);
    assert.doesNotMatch(changes[0]!.diff, /\+- LESSON_ONE/);
  } finally {
    done();
  }
});

test("a box path names a standing file only under this agent's own mirror directory", () => {
  assert.equal(standingBoxDir("Ada Lovelace"), "/home/box/work/standing/ada-lovelace");
  assert.equal(standingFileOf("/home/box/work/standing/ada-lovelace/AGENTS.md", "Ada Lovelace"), "AGENTS.md");
  assert.equal(standingFileOf("~/work/standing/ada-lovelace/SOUL.md", "Ada Lovelace"), "SOUL.md");
  assert.equal(standingFileOf("/home/box/work/standing/bob/AGENTS.md", "Ada Lovelace"), undefined, "another agent's");
  assert.equal(standingFileOf("/home/box/work/standing/ada-lovelace/notes.md", "Ada Lovelace"), undefined, "not one of the four");
  assert.equal(standingFileOf("/home/box/work/memory/ada-lovelace/profile.md", "Ada Lovelace"), undefined);
});

test("the heartbeat runs on unchecked items only: an empty or fully checked list starts no turn", () => {
  assert.deepEqual(heartbeatItems(""), []);
  assert.deepEqual(heartbeatItems("# HEARTBEAT.md\n\n<!-- - [ ] example: look in the inbox -->\n"), [], "a commented example is not an item");
  assert.deepEqual(heartbeatItems("- [x] done already\n"), []);
  assert.deepEqual(heartbeatItems("- [ ] look in the inbox\n* [ ] check the build\n- plain bullet\n"), ["look in the inbox", "check the build"]);
  assert.equal(heartbeatAgentOf(heartbeatSlug("a1")), "a1");
  assert.equal(heartbeatAgentOf("weekly-retro"), undefined);
});
