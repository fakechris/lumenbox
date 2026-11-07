/**
 * Site learnings by box (INV-1728): a new note is read by its box's agents only, for a principal
 * who may enter the box; the historical installation-wide files are read as before, never written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearning } from "./learnings.ts";
import { boxLearningsDir, noteSiteLearning, readSiteLearnings, siteLearningsNote, type SiteLearningsContext } from "./site-learnings.ts";

const BOXES: Record<string, { id: string; members: "everyone" | string[] }> = {
  "box-a": { id: "box-a", members: "everyone" },
  "box-b": { id: "box-b", members: ["u-bea"] },
};

function contextFor(root: string, agentId: string, boxId: string, userId?: string): SiteLearningsContext {
  return {
    learningsDir: root,
    agent: { id: agentId, profile: { name: agentId } },
    ...(userId !== undefined ? { caller: { userId } } : {}),
    registry: { boxOf: () => ({ id: boxId }), boxById: id => BOXES[id] },
  };
}

test("a new note is seen by agents of its box and by no agent of another box", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-site-learnings-"));
  try {
    const line = noteSiteLearning("shop.test", { at: new Date("2026-11-07T00:00:00Z"), worked: false, text: "Export from the list view downloads nothing." }, contextFor(root, "ada", "box-a"));
    assert.equal(line, "- 2026-11-07 ❌ Export from the list view downloads nothing. (ada)");
    assert.ok(existsSync(join(boxLearningsDir(root, "box-a"), "shop.test.md")), "kept under boxes/<box id>/");
    assert.equal(existsSync(join(root, "shop.test.md")), false, "nothing is written to the installation-wide file");

    assert.deepEqual(readSiteLearnings("shop.test", contextFor(root, "kin", "box-a")).box, [line], "a teammate in the box reads it");
    assert.deepEqual(readSiteLearnings("shop.test", contextFor(root, "bea", "box-b", "u-bea")), { box: [], historical: [] }, "another box does not");
    assert.equal(siteLearningsNote("shop.test", contextFor(root, "bea", "box-b", "u-bea")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the box's notes are read only for a principal who may enter the box", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-site-learnings-"));
  try {
    noteSiteLearning("shop.test", { at: new Date(), worked: true, text: "Pick the country before the postcode." }, contextFor(root, "bea", "box-b", "u-bea"));
    assert.equal(readSiteLearnings("shop.test", contextFor(root, "bea", "box-b", "u-bea")).box.length, 1);
    assert.equal(readSiteLearnings("shop.test", contextFor(root, "bea", "box-b", "u-other")).box.length, 0, "a non-member's turn reads none");
    assert.equal(readSiteLearnings("shop.test", contextFor(root, "bea", "box-b")).box.length, 1, "the operator's own credential, as for memory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical installation-wide notes are untouched, read by every box, and labelled as such", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-site-learnings-"));
  try {
    const old = appendLearning("shop.test", { at: new Date("2026-09-01T00:00:00Z"), worked: true, text: "The coupon field is under Order summary.", by: "Ada" }, root);
    const before = readFileSync(join(root, "shop.test.md"), "utf8");
    const mine = noteSiteLearning("shop.test", { at: new Date("2026-11-07T00:00:00Z"), worked: true, text: "Search submits on Enter only." }, contextFor(root, "ada", "box-a"));
    assert.equal(readFileSync(join(root, "shop.test.md"), "utf8"), before, "the historical file is not rewritten or appended to");

    assert.deepEqual(readSiteLearnings("shop.test", contextFor(root, "bea", "box-b", "u-bea")), { box: [], historical: [old] }, "another box still reads the historical note");
    const shown = siteLearningsNote("shop.test", contextFor(root, "kin", "box-a")) ?? "";
    assert.match(shown, /learned on shop\.test before \(2 note\(s\)\)/);
    const label = shown.indexOf("Installation-wide, from before notes were kept per box (historical");
    assert.ok(shown.indexOf(mine) < label && label < shown.indexOf(old), shown);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a box id that cannot name a directory is refused rather than escaping the learnings root", () => {
  assert.throws(() => boxLearningsDir("/tmp/x", ".."), /cannot name a learnings directory/);
  assert.equal(boxLearningsDir("/tmp/x", "a/../b"), join("/tmp/x", "boxes", "a%2F..%2Fb"));
});
