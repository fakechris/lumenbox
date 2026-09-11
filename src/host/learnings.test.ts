/**
 * Site learnings: per host, dated, honest about failure, refusing credentials, marking
 * coordinates as perishable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearning, formatLearning, hostOf, readLearnings, renderLearnings, validateLearning } from "./learnings.ts";

test("a host is derived from a URL or a bare name, lower-case, without www or a port", () => {
  assert.equal(hostOf("https://www.Example.com:8443/path?q=1"), "example.com");
  assert.equal(hostOf("shop.test"), "shop.test");
  assert.equal(hostOf(""), undefined);
  assert.equal(hostOf("not a host"), undefined);
});

test("a note is one dated line, says whether it worked, and flags coordinates as perishable", () => {
  const at = new Date("2026-09-11T10:00:00.000Z");
  assert.equal(formatLearning({ at, worked: true, text: "The search box only submits on Enter, not on the button." }), "- 2026-09-11 ✅ The search box only submits on Enter, not on the button.");
  assert.equal(formatLearning({ at, worked: false, text: "Clicking Export from the list view downloads nothing.", by: "Ada" }), "- 2026-09-11 ❌ Clicking Export from the list view downloads nothing. (Ada)");
  assert.match(formatLearning({ at, worked: true, text: "The hidden menu is at (412, 88)." }), /# 核对 2026-09-11: coordinates go stale/);
});

test("a note refuses to be empty, multi-line, long, or a credential", () => {
  assert.match(validateLearning("  ") ?? "", /Say what you learned/);
  assert.match(validateLearning("one\ntwo") ?? "", /One note per line/);
  assert.match(validateLearning("x".repeat(401)) ?? "", /400 characters/);
  assert.match(validateLearning("Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to log in") ?? "", /looks like it holds a credential/);
  assert.equal(validateLearning("The login form needs the country picked first."), undefined);
});

test("notes append under their host and the most recent ones are read back and rendered", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-learnings-"));
  try {
    assert.deepEqual(readLearnings("shop.test", dir), []);
    assert.equal(renderLearnings("shop.test", []), undefined);
    const at = new Date("2026-09-11T10:00:00.000Z");
    appendLearning("shop.test", { at, worked: true, text: "Cart survives a reload." }, dir);
    appendLearning("shop.test", { at, worked: false, text: "The Pay button is disabled until the address is verified." }, dir);
    assert.throws(() => appendLearning("shop.test", { at, worked: true, text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 opens it" }, dir), /credential/);
    const file = readFileSync(join(dir, "shop.test.md"), "utf8");
    assert.match(file, /^# shop\.test\n/);
    const lines = readLearnings("shop.test", dir);
    assert.equal(lines.length, 2);
    const shown = renderLearnings("shop.test", lines) ?? "";
    assert.match(shown, /learned on shop\.test before \(2 note\(s\), 1 about what did not work\)/);
    assert.match(shown, /❌ The Pay button is disabled/);
    assert.match(shown, /NoteSiteLearning/);
    // Only the most recent are shown.
    for (let i = 0; i < 15; i++) appendLearning("shop.test", { at, worked: true, text: `note ${i}` }, dir);
    assert.equal(readLearnings("shop.test", dir).length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
