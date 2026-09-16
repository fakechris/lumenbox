/**
 * Tests for channel records (docs/22 §4, §7 item 2, first slice).
 *
 * Three properties worth pinning: the grandfathered rows exist with their type as
 * their immutable id, so every recorded chatKey and allow-list entry keeps
 * working; the file survives reloads without re-minting; and namespace
 * replacement is *refused*, not half-supported — an incarnation other than 1
 * fails the load, because bumping it before the identity-link migration exists
 * would let a colliding vendor subject inherit an old principal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANDFATHERED_TYPES, ensureChannelRecords, removeChannelRecord, roomDecision, upsertChannelRecord } from "./identity.ts";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-channel-identity-"));
  return { path: join(dir, "channels.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("first contact mints the grandfathered rows: id is the type, incarnation 1", () => {
  const { path, cleanup } = tempPath();
  try {
    const records = ensureChannelRecords(path, "box_test");
    assert.deepEqual(
      records.map(r => r.id).sort(),
      [...GRANDFATHERED_TYPES].sort()
    );
    for (const record of records) {
      assert.equal(record.id, record.type);
      assert.equal(record.incarnation, 1);
      assert.equal(record.boxId, "box_test");
    }

    const again = ensureChannelRecords(path, "box_test");
    assert.deepEqual(again, records, "a reload re-mints nothing");
  } finally {
    cleanup();
  }
});

test("a custom row survives reloads and missing grandfathered rows are re-added", () => {
  const { path, cleanup } = tempPath();
  try {
    const records = ensureChannelRecords(path, "box_test");
    const custom = {
      id: "feishu-work",
      type: "feishu" as const,
      name: "工作飞书",
      incarnation: 1,
      boxId: "box_test",
      createdAt: new Date().toISOString(),
    };
    // Operator adds a second door by hand (the supported path until a UI exists),
    // and accidentally drops a grandfathered row while editing.
    writeFileSync(
      path,
      `${JSON.stringify({ channels: [records[0], custom] }, null, 2)}\n`,
      "utf8"
    );
    const reloaded = ensureChannelRecords(path, "box_test");
    assert.ok(reloaded.some(r => r.id === "feishu-work"));
    for (const type of GRANDFATHERED_TYPES) {
      assert.ok(reloaded.some(r => r.id === type), `${type} row restored`);
    }
  } finally {
    cleanup();
  }
});

test("an incarnation other than 1 refuses to load — replacement is unbuilt", () => {
  const { path, cleanup } = tempPath();
  try {
    const records = ensureChannelRecords(path, "box_test");
    const bumped = records.map(r => (r.id === "feishu" ? { ...r, incarnation: 2 } : r));
    writeFileSync(path, `${JSON.stringify({ channels: bumped }, null, 2)}\n`, "utf8");
    assert.throws(() => ensureChannelRecords(path, "box_test"), /replacement/i);
  } finally {
    cleanup();
  }
});

test("a corrupt file throws instead of silently re-minting identities", () => {
  const { path, cleanup } = tempPath();
  try {
    writeFileSync(path, "{not json", "utf8");
    assert.throws(() => ensureChannelRecords(path, "box_test"), /channels\.json/);
  } finally {
    cleanup();
  }
});

test("upsert creates a feishu door and edits only what may change", () => {
  const { path, cleanup } = tempPath();
  try {
    const created = ensureUpsert(path, { id: "feishu-work", type: "feishu", name: "工作飞书", defaultAgent: "Bob" });
    const row = created.find(r => r.id === "feishu-work")!;
    assert.equal(row.name, "工作飞书");
    assert.equal(row.defaultAgent, "Bob");
    assert.equal(row.incarnation, 1);

    // name and defaultAgent change; clearing the default with "" removes it.
    const edited = ensureUpsert(path, { id: "feishu-work", type: "feishu", defaultAgent: "" });
    const after = edited.find(r => r.id === "feishu-work")!;
    assert.equal(after.name, "工作飞书", "an omitted name keeps its value");
    assert.equal(after.defaultAgent, undefined);

    // type is immutable, like id; telegram stays refused until parameterized.
    assert.throws(() => ensureUpsert(path, { id: "feishu-work", type: "dingtalk" }), /immutable/);
    assert.throws(() => ensureUpsert(path, { id: "tg-2", type: "telegram" }), /parameterized/);
    // dingtalk is parameterized now; a second door of it is ordinary.
    assert.ok(ensureUpsert(path, { id: "ding-2", type: "dingtalk" }).some(r => r.id === "ding-2"));
    // An id that is another adapter's namespace is refused outright.
    assert.throws(() => ensureUpsert(path, { id: "dingtalk", type: "feishu" }), /namespace/);
    assert.throws(() => ensureUpsert(path, { id: "Feishu Work", type: "feishu" }), /cannot be a channel id/);
  } finally {
    cleanup();
  }

  function ensureUpsert(p: string, input: Parameters<typeof upsertChannelRecord>[1]) {
    return upsertChannelRecord(p, input, "box_test");
  }
});

test("a custom door can be removed; the grandfathered ones cannot", () => {
  const { path, cleanup } = tempPath();
  try {
    upsertChannelRecord(path, { id: "feishu-work", type: "feishu" }, "box_test");
    const after = removeChannelRecord(path, "feishu-work", "box_test");
    assert.ok(!after.some(r => r.id === "feishu-work"));
    assert.throws(() => removeChannelRecord(path, "feishu", "box_test"), /grandfathered/);
  } finally {
    cleanup();
  }
});

test("a door answers in the rooms its rules name, and stays out of the rest (INV-429)", () => {
  // [Support] is auto-joined, [Internal] never, and a room nobody can name is refused
  // while an allowlist is in force — the case that decides whether an allowlist means
  // anything on the rooms it was written for.
  const rules = { allow: ["[Support]", "客服"], deny: ["[Internal]"] };
  assert.equal(roomDecision(rules, "[Support] billing"), "answer");
  assert.equal(roomDecision(rules, "客服 · 一线"), "answer");
  assert.equal(roomDecision(rules, "[support] lowercase is the same room"), "answer");
  assert.equal(roomDecision(rules, "[Internal] leadership"), "refuse");
  assert.equal(roomDecision(rules, "random chat"), "refuse", "an allowlist excludes what it does not name");
  assert.equal(roomDecision(rules, undefined), "unknown", "and a room we cannot name is not quietly admitted");

  // Deny wins over allow, because the list that says "never" was written about a mistake.
  assert.equal(roomDecision({ allow: ["[Internal] ok"], deny: ["[Internal]"] }, "[Internal] ok"), "refuse");

  // Deny only: everything else is answered, including rooms we cannot name.
  const denyOnly = { allow: [], deny: ["[Internal]"] };
  assert.equal(roomDecision(denyOnly, "[Internal] leadership"), "refuse");
  assert.equal(roomDecision(denyOnly, "anything else"), "answer");
  assert.equal(roomDecision(denyOnly, undefined), "answer");

  // No rules at all is what every door did before this existed.
  assert.equal(roomDecision(undefined, "[Internal] leadership"), "answer");
  assert.equal(roomDecision({ allow: [], deny: [] }, undefined), "answer");
  // Blank entries are typos, not rules: they must not match everything.
  assert.equal(roomDecision({ allow: ["  "], deny: [] }, "anything"), "refuse");
});
