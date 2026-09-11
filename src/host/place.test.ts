/**
 * Instructions of a place: the installation's file and the box's bundles, rendered in
 * that order, and absent when neither says anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PLACE_INSTRUCTIONS_CHARS, readInstallationInstructions, renderPlace } from "./place.ts";

test("the installation's instructions are read when present, empty is nothing, long is cut", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-place-"));
  try {
    const path = join(dir, "instructions.md");
    assert.equal(readInstallationInstructions(path), undefined, "no file is nothing");
    writeFileSync(path, "   \n");
    assert.equal(readInstallationInstructions(path), undefined, "a blank file is nothing");
    writeFileSync(path, "Always say 客户, never 用户.\n");
    assert.equal(readInstallationInstructions(path), "Always say 客户, never 用户.");
    writeFileSync(path, "x".repeat(MAX_PLACE_INSTRUCTIONS_CHARS + 50));
    assert.match(readInstallationInstructions(path) ?? "", /cut here/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the place section reads installation first, then the box, and is absent when both are silent", () => {
  assert.equal(renderPlace(undefined), "");
  assert.equal(renderPlace({ box: [] }), "");
  assert.equal(renderPlace({ box: ["  "] }), "");
  const text = renderPlace({ installation: "Data is classified; never paste customer rows.", boxName: "vendor", box: ["Vendor code style: tabs.", "Deploy only on weekdays."] });
  assert.match(text, /^# House rules/);
  const org = text.indexOf("From this installation:");
  const box = text.indexOf("From the vendor box:");
  assert.ok(org > 0 && box > org, "installation before box");
  assert.match(text, /tabs\.\n\nDeploy only/);
  // A box with no name still gets a heading.
  assert.match(renderPlace({ box: ["one"] }), /From your box:/);
});
