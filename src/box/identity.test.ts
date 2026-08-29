/**
 * Tests for the box identity record (docs/22 §4, §7 item 1).
 *
 * The property worth pinning: the id is minted exactly once and survives every
 * later load — a display name is a label, the id is the identity, and nothing
 * that reads the file can accidentally re-mint it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBoxRecord } from "./identity.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-box-identity-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ensureBoxRecord mints once and returns the same id forever after", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "box.json");
    const first = ensureBoxRecord(path, "agentbox-box");
    assert.match(first.id, /^box_/);
    assert.equal(first.name, "agentbox-box");
    assert.equal(first.members, "everyone");

    const second = ensureBoxRecord(path, "agentbox-box");
    assert.equal(second.id, first.id);

    // On disk as ordinary JSON — the record outlives any one process.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.id, first.id);
  } finally {
    cleanup();
  }
});

test("a later load with a different display name keeps the id — names are labels", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "box.json");
    const first = ensureBoxRecord(path, "agentbox-box");
    const renamed = ensureBoxRecord(path, "some-new-container-name");
    assert.equal(renamed.id, first.id);
  } finally {
    cleanup();
  }
});

test("a corrupt file fails loudly instead of silently minting a new identity", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "box.json");
    writeFileSync(path, "{not json", "utf8");
    // Re-minting here would be the boxName-reuse bug with extra steps: agents
    // already stamped with the old id would silently belong to nothing.
    assert.throws(() => ensureBoxRecord(path, "agentbox-box"), /box\.json/);
  } finally {
    cleanup();
  }
});
