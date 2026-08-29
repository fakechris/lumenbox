/**
 * Tests for the conversation → chat record.
 *
 * The property under test: the flattening that names a conversation's file is one-way,
 * and this record is the way back. `feishu:oc_x:om_y` becomes `feishu-oc_x-om_y` on
 * disk, and before this record existed, nothing in the system could answer "which chat
 * is this?" for a viewed conversation — so a console reply into a channel thread had
 * nowhere to deliver itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationDirectory, conversationsPath } from "./conversations.ts";

test("the flattened id finds its way back to the chat", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-conv-"));
  try {
    const directory = new ConversationDirectory(conversationsPath(home));
    directory.record("feishu-oc_room-om_topic", "feishu:oc_room:om_topic");
    assert.equal(directory.chatKeyFor("feishu-oc_room-om_topic"), "feishu:oc_room:om_topic");
    // Main and anything unrecorded have no chat, and say so rather than guessing.
    assert.equal(directory.chatKeyFor("main"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the record survives the process that wrote it", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-conv-"));
  try {
    const path = conversationsPath(home);
    new ConversationDirectory(path).record("feishu-oc_a-om_b", "feishu:oc_a:om_b");
    // A crash mid-append leaves a torn line, which costs nothing already recorded.
    appendFileSync(path, '{"conversation":"feishu-oc_c","chatK');
    const reread = new ConversationDirectory(path);
    assert.equal(reread.chatKeyFor("feishu-oc_a-om_b"), "feishu:oc_a:om_b");
    assert.equal(reread.chatKeyFor("feishu-oc_c"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("re-recording the same pair writes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-conv-"));
  try {
    const path = conversationsPath(home);
    const directory = new ConversationDirectory(path);
    // Every inbound message records; a busy thread must not grow the file per message.
    for (let index = 0; index < 100; index++) {
      directory.record("feishu-oc_busy-om_t", "feishu:oc_busy:om_t");
    }
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("many conversations stay one line each after compaction", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-conv-"));
  try {
    const path = conversationsPath(home);
    const directory = new ConversationDirectory(path);
    for (let index = 0; index < 600; index++) {
      // Same id re-pointed, as a chat key correction would be: last write must win.
      directory.record(`conv-${index % 300}`, `feishu:oc_${index}`);
    }
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    // 600 appends, compacted at 500 down to the 300 distinct ids, then appended again:
    // the bound is the compaction threshold, not the distinct count.
    assert.ok(lines <= 500, `expected compaction to bound the file, got ${lines} lines`);
    assert.equal(new ConversationDirectory(path).chatKeyFor("conv-0"), "feishu:oc_300");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an address recorded under a replaced channel stops resolving, loudly", () => {
  // docs/22 §4: the same vendor chat id under a new tenant is a different room with
  // different people. String equality must not route a reply there.
  const home = mkdtempSync(join(tmpdir(), "lumen-conv-"));
  try {
    const path = conversationsPath(home);
    new ConversationDirectory(path).record("feishu-oc_room", "feishu:oc_room");

    const warnings: string[] = [];
    const after = new ConversationDirectory(path, {
      incarnationOf: chatKey => (chatKey.startsWith("feishu:") ? 2 : 1),
      warn: line => warnings.push(line),
    });
    assert.equal(after.chatKeyFor("feishu-oc_room"), undefined);
    assert.match(warnings[0]!, /dead letter/);

    // Re-recorded from a live inbound message under the new world, it resolves again.
    after.record("feishu-oc_room", "feishu:oc_room");
    assert.equal(after.chatKeyFor("feishu-oc_room"), "feishu:oc_room");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
