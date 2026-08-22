/**
 * Tests for the people roster.
 *
 * The load-bearing claims: an unknown identity is a viewer (so a fresh install is safe
 * and works), one person's many identities resolve to one principal (so their history
 * and spend are one person's), and the file is private (it is the access-control list).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Principals, roleAtLeast } from "./principals.ts";

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-principals-"));
  return { path: join(dir, "principals.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("role ordering: admin outranks driver outranks viewer", () => {
  assert.ok(roleAtLeast("admin", "driver"));
  assert.ok(roleAtLeast("driver", "driver"));
  assert.ok(!roleAtLeast("viewer", "driver"));
  assert.ok(!roleAtLeast(undefined, "viewer"));
});

test("an unknown identity is a viewer named after itself — safe default, still works", () => {
  const { path, cleanup } = tempFile();
  try {
    const principals = new Principals(path);
    const who = principals.resolve("telegram:999");
    assert.equal(who.role, "viewer");
    assert.equal(who.name, "telegram:999");
    assert.ok(!principals.isKnown("telegram:999"));
  } finally {
    cleanup();
  }
});

test("one person's many identities resolve to one principal", () => {
  const { path, cleanup } = tempFile();
  try {
    const principals = new Principals(path);
    principals.save([
      { id: "chris", name: "Chris", role: "admin", identities: ["telegram:1", "feishu:ou_x"] },
      { id: "sam", name: "Sam", role: "driver", identities: ["telegram:2"] },
    ]);

    // Home and work are the same person.
    assert.equal(principals.resolve("telegram:1").id, "chris");
    assert.equal(principals.resolve("feishu:ou_x").id, "chris");
    assert.equal(principals.roleOf("telegram:1"), "admin");
    assert.equal(principals.roleOf("telegram:2"), "driver");

    // The file is private, because it is the access-control list.
    assert.equal(statSync(path).mode & 0o777, 0o600);

    // A second instance reads the same roster — an edit needs no restart.
    const reloaded = new Principals(path);
    assert.equal(reloaded.resolve("feishu:ou_x").name, "Chris");
  } finally {
    cleanup();
  }
});

test("a broken file is an empty roster, not a broken server", () => {
  const { path, cleanup } = tempFile();
  try {
    writeFileSync(path, "{ not json");
    const principals = new Principals(path);
    // Everyone falls back to the viewer path; nothing throws.
    assert.equal(principals.roleOf("telegram:1"), "viewer");
    assert.deepEqual(principals.list(), []);
  } finally {
    cleanup();
  }
});
