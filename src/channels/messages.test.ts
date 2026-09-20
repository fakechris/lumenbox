/**
 * Tests for the message ledger.
 *
 * One property carries the file: it is a record, not a queue. Everything written is
 * still there after any number of writes, and a torn line hides only itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES_SCHEMA, Messages, messagesPath } from "./messages.ts";

function ledger(): { messages: Messages; path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-messages-"));
  const path = messagesPath(root);
  return { messages: new Messages(path), path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const record = (n: number) => ({
  id: `m-${n}`,
  channel: "feishu-personal",
  channelMessageId: `om_${n}`,
  chatKey: "feishu-personal:oc_room",
  identity: "feishu-personal:ou_person",
  senderLabel: "宋传胜",
  conversationKey: "feishu-personal:oc_room",
  receivedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, n)).toISOString(),
  text: `message ${n} `.repeat(10),
});

test("a message is written whole, with the schema and its own length, and read back the same", () => {
  const { messages, path, cleanup } = ledger();
  try {
    const long = "字".repeat(12_000);
    messages.admitted({ ...record(1), text: long, files: [{ name: "a.pdf", bytes: 1234 }] });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const stored = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(stored.schema, MESSAGES_SCHEMA);
    assert.equal(stored.id, "m-1");
    assert.equal(stored.channelMessageId, "om_1");
    assert.equal(stored.text, long, "not clamped");
    assert.equal(stored.textChars, 12_000);
    assert.deepEqual(stored.files, [{ name: "a.pdf", bytes: 1234 }]);
    assert.deepEqual(messages.list().map(entry => entry.id), ["m-1"]);
  } finally {
    cleanup();
  }
});

test("it is a record, not a queue: nothing written ever goes away", () => {
  const { messages, path, cleanup } = ledger();
  try {
    // Well past the point where the queue-shaped ledgers would have emptied themselves.
    for (let n = 0; n < 6_000; n++) messages.admitted(record(n));
    assert.equal(messages.list().length, 6_000);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 6_000);
  } finally {
    cleanup();
  }
});

test("a torn last line hides only itself", () => {
  const { messages, path, cleanup } = ledger();
  try {
    messages.admitted(record(1));
    messages.admitted(record(2));
    appendFileSync(path, '{"schema":"lumenbox.message/v1","id":"m-3","text":"cut off mid');
    assert.deepEqual(messages.list().map(entry => entry.id), ["m-1", "m-2"]);
    // And the next write lands on its own line, after the torn one.
    messages.admitted(record(4));
    assert.deepEqual(messages.list().map(entry => entry.id), ["m-1", "m-2", "m-4"]);
  } finally {
    cleanup();
  }
});

test("an empty or missing ledger lists nothing", () => {
  const { messages, cleanup } = ledger();
  try {
    assert.deepEqual(messages.list(), []);
  } finally {
    cleanup();
  }
});
