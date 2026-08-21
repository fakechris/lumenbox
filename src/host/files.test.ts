/**
 * Tests for noticing two agents writing one file.
 *
 * Every agent shares one work directory as one uid, so this is the ordinary lost update and not an
 * agent-shaped novelty: the second write wins, silently, and the first agent goes on believing its
 * work is there. What is on test is that the loss becomes a refusal, and that an agent working
 * alone never meets any of it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ABSENT, FileVersions, versionOf } from "./files.ts";

const REPORT = "/home/box/work/report.md";

test("an agent working alone never notices this exists", () => {
  const files = new FileVersions();
  // Creating a file: nothing to lose.
  assert.equal(files.check({ agentId: "ada", path: REPORT, current: ABSENT }).refusal, undefined);

  files.observed("ada", REPORT, versionOf("v1"));
  // Writing again over its own version.
  assert.equal(
    files.check({ agentId: "ada", path: REPORT, current: versionOf("v1") }).refusal,
    undefined
  );
});

test("a write over someone else's change is refused, and says whose", () => {
  const files = new FileVersions();
  files.observed("ada", REPORT, versionOf("v1"));
  files.observed("rex", REPORT, versionOf("v1"));
  // Rex writes. Ada, still holding v1, tries to write.
  files.observed("rex", REPORT, versionOf("v2"));

  const { refusal } = files.check({
    agentId: "ada",
    path: REPORT,
    current: versionOf("v2"),
    nameOf: id => (id === "rex" ? "Rex" : id),
  });
  assert.ok(refusal);
  assert.match(refusal, /has changed since you last read it/);
  assert.match(refusal, /Rex/, "the other agent is named, because an id is no use to a reader");
  assert.match(refusal, /lose the difference, silently/);
  // The way out is named, or a refusal is just an obstacle.
  assert.match(refusal, /Read it, decide what should survive/);
  assert.match(refusal, /overwrite: true/);
});

test("overwriting a file you never read is the same loss, whether or not you knew", () => {
  const files = new FileVersions();
  const { refusal } = files.check({ agentId: "ada", path: REPORT, current: versionOf("someone's work") });
  assert.ok(refusal);
  assert.match(refusal, /have not read .* and it already exists/);
  // Nobody else has seen it through the tools, so the honest answer is that it changed outside them.
  assert.match(refusal, /changed outside this tool/);
});

test("after its own write an agent may write again", () => {
  const files = new FileVersions();
  files.observed("ada", REPORT, versionOf("v1"));
  files.observed("ada", REPORT, versionOf("v2"));
  assert.equal(
    files.check({ agentId: "ada", path: REPORT, current: versionOf("v2") }).refusal,
    undefined
  );
});

test("an absent file and an empty file are different answers", () => {
  const files = new FileVersions();
  files.observed("ada", REPORT, ABSENT);
  // The file now exists and is empty. That is a change, not the absence Ada saw.
  assert.ok(files.check({ agentId: "ada", path: REPORT, current: versionOf("") }).refusal);
});

test("forgetting an agent forgets only that agent", () => {
  const files = new FileVersions();
  files.observed("ada", REPORT, versionOf("v1"));
  files.observed("rex", REPORT, versionOf("v1"));
  files.forget("ada");
  assert.equal(files.lastSeen("ada", REPORT), undefined);
  assert.equal(files.lastSeen("rex", REPORT), versionOf("v1"));
});
