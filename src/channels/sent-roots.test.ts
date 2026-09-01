/**
 * The measured failure this ledger exists for: a person replied under the bot's own
 * weekly report and the agent read the follow-up in an empty conversation, because
 * the report's vendor-minted message id mapped to nothing (2026-09-01, t110).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SentRootsLedger, sentRootsPath } from "./sent-roots.ts";
import { conversationKeyFor } from "./feishu.ts";

function freshPath(): string {
  return sentRootsPath(mkdtempSync(join(tmpdir(), "sent-roots-")));
}

test("a reply under a bot-sent root continues the authoring conversation", () => {
  const ledger = new SentRootsLedger(freshPath());
  // The weekly report: composed in the chat-level conversation, sent top-level.
  ledger.record("om_report", "feishu:oc_room");

  const reply = { chat_id: "oc_room", root_id: "om_report", message_id: "om_reply" };
  const keyed = conversationKeyFor(reply, "feishu", id => ledger.chatKeyFor(id));
  assert.equal(keyed, "feishu:oc_room", "the reply lands where the report was written");

  // A root nobody sent keys exactly as before — human topics are untouched.
  const humanReply = { chat_id: "oc_room", root_id: "om_human", message_id: "om_r2" };
  assert.equal(
    conversationKeyFor(humanReply, "feishu", id => ledger.chatKeyFor(id)),
    "feishu:oc_room:om_human"
  );

  // A 1:1 stays one conversation even when the ledger knows the root: p2p wins first.
  const direct = { chat_id: "oc_dm", chat_type: "p2p", root_id: "om_report" };
  assert.equal(conversationKeyFor(direct, "feishu", id => ledger.chatKeyFor(id)), "feishu:oc_dm");
});

test("a degraded reply's loose post routes back to the topic that addressed it", () => {
  const ledger = new SentRootsLedger(freshPath());
  // sendToChat addressed a thread; the reply anchor was withdrawn and post degraded
  // to a top-level create — the recorded owner keeps the thread part.
  ledger.record("om_loose", "feishu:oc_room:om_topic");
  const reply = { chat_id: "oc_room", root_id: "om_loose" };
  assert.equal(
    conversationKeyFor(reply, "feishu", id => ledger.chatKeyFor(id)),
    "feishu:oc_room:om_topic"
  );
});

test("the ledger replays from disk and refuses a replaced incarnation", () => {
  const path = freshPath();
  let incarnation = 1;
  const warned: string[] = [];
  const first = new SentRootsLedger(path, {
    incarnationOf: () => incarnation,
    warn: line => warned.push(line),
  });
  first.record("om_a", "feishu:oc_x");

  // A restart replays the record.
  const second = new SentRootsLedger(path, {
    incarnationOf: () => incarnation,
    warn: line => warned.push(line),
  });
  assert.equal(second.chatKeyFor("om_a"), "feishu:oc_x");

  // The channel is replaced: the same chat id is a different room now.
  incarnation = 2;
  assert.equal(second.chatKeyFor("om_a"), undefined);
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /replaced channel/);

  // A torn last line is skipped, not fatal.
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.includes("om_a"));
});

test("re-recording is idempotent on disk and refreshes recency", () => {
  const path = freshPath();
  const ledger = new SentRootsLedger(path);
  ledger.record("om_a", "feishu:oc_x");
  ledger.record("om_a", "feishu:oc_x");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "an unchanged record is not appended twice");
});
