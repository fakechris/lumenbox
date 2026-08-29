/**
 * Tests for the people roster.
 *
 * The load-bearing claims: an unknown identity is a viewer (so a fresh install is safe
 * and works), one person's many identities resolve to one principal (so their history
 * and spend are one person's), and the file is private (it is the access-control list).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("legacy plain-string links read as incarnation 1 and are stamped on the next save", () => {
  const { path, cleanup } = tempFile();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        principals: [
          { id: "chris", name: "Chris", role: "admin", identities: ["feishu:ou_x"] },
        ],
      })
    );
    const principals = new Principals(path);
    assert.equal(principals.resolve("feishu:ou_x").id, "chris", "legacy link resolves");

    principals.save(principals.list());
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written.principals[0].identities, [
      { identity: "feishu:ou_x", incarnation: 1 },
    ]);
  } finally {
    cleanup();
  }
});

test("one identity belongs to one person: first claim wins, loudly", () => {
  const { path, cleanup } = tempFile();
  try {
    const warnings: string[] = [];
    writeFileSync(
      path,
      JSON.stringify({
        principals: [
          { id: "chris", name: "Chris", role: "admin", identities: ["feishu:ou_x"] },
          { id: "sam", name: "Sam", role: "driver", identities: ["feishu:ou_x", "telegram:2"] },
        ],
      })
    );
    const principals = new Principals(path, { warn: line => warnings.push(line) });
    // Not a coin toss over the access-control list: roster order decides.
    assert.equal(principals.resolve("feishu:ou_x").id, "chris");
    assert.equal(principals.resolve("telegram:2").id, "sam");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /claimed twice/);

    // save applies the same rule, so the file never stores the conflict.
    principals.save([
      { id: "a", name: "A", role: "driver", identities: ["feishu:ou_y"] },
      { id: "b", name: "B", role: "driver", identities: ["feishu:ou_y"] },
    ]);
    assert.equal(principals.resolve("feishu:ou_y").id, "a");
  } finally {
    cleanup();
  }
});

test("a link from a retired incarnation stops resolving but survives a save round-trip", () => {
  const { path, cleanup } = tempFile();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        principals: [
          {
            id: "chris",
            name: "Chris",
            role: "admin",
            identities: [
              { identity: "feishu:ou_old", incarnation: 1 },
              { identity: "telegram:1", incarnation: 1 },
            ],
          },
        ],
      })
    );
    // The feishu door has been replaced: its current incarnation is 2.
    const incarnationOf = (identity: string) => (identity.startsWith("feishu:") ? 2 : 1);
    const principals = new Principals(path, { incarnationOf });

    // The old app's subject is nobody until they bind again.
    assert.equal(principals.resolve("feishu:ou_old").role, "viewer");
    assert.ok(!principals.isKnown("feishu:ou_old"));
    // The person's other identities are untouched.
    assert.equal(principals.resolve("telegram:1").id, "chris");

    // A round-trip through the settings dialog neither resurrects nor destroys it.
    principals.save(principals.list());
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written.principals[0].identities, [
      { identity: "feishu:ou_old", incarnation: 1 },
      { identity: "telegram:1", incarnation: 1 },
    ]);
    // A genuinely new feishu link, by contrast, is stamped with the current world.
    principals.save([
      { id: "chris", name: "Chris", role: "admin", identities: ["feishu:ou_old", "telegram:1", "feishu:ou_new"] },
    ]);
    const restamped = JSON.parse(readFileSync(path, "utf8"));
    const fresh = restamped.principals[0].identities.find(
      (link: { identity: string }) => link.identity === "feishu:ou_new"
    );
    assert.equal(fresh.incarnation, 2);
    assert.equal(principals.resolve("feishu:ou_new").id, "chris");
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
