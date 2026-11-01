/** Outbound receipts (INV-1460): one id per message, counted failures, a door's verdict, and what survives a restart. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationGone, Outbox, outboundId, retryDelayMs } from "./outbox.ts";

function temp(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-outbox-"));
  return { path: join(dir, "outbox.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the same message has the same id; a notice is a new message on another day", () => {
  assert.equal(outboundId("feishu:oc_1", "result for t1", "done"), outboundId("feishu:oc_1", "result for t1", "done"));
  assert.notEqual(outboundId("feishu:oc_1", "result for t1", "done"), outboundId("feishu:oc_2", "result for t1", "done"));
  assert.notEqual(outboundId("feishu:oc_1", "notice: digest", "x", "2026-11-01"), outboundId("feishu:oc_1", "notice: digest", "x", "2026-11-02"));
  assert.deepEqual([1, 2, 3, 10].map(retryDelayMs), [5_000, 10_000, 20_000, 300_000]);
  assert.equal(conversationGone(new Error("chat not found")), true);
  assert.equal(conversationGone(new Error("ETIMEDOUT")), false);
});

test("a receipt is queued once, counts its failures, settles as sent, and a dropped one is never pending again", () => {
  const { path, cleanup } = temp();
  try {
    const outbox = new Outbox(path);
    assert.equal(outbox.enqueue({ id: "a", chatKey: "feishu:oc_1", purpose: "answer owed as d1", text: "late answer" }), "queued");
    assert.equal(outbox.enqueue({ id: "a", chatKey: "feishu:oc_1", purpose: "answer owed as d1", text: "late answer" }), "duplicate");
    outbox.failed("a", "ETIMEDOUT");
    outbox.failed("a", "ECONNRESET");
    assert.deepEqual(outbox.pending().map(r => [r.id, r.attempts, r.lastError, r.text]), [["a", 2, "ECONNRESET", "late answer"]]);
    assert.equal(outbox.problems().length, 0);
    outbox.failed("a", "ETIMEDOUT");
    assert.equal(outbox.problems().length, 1, "three failures make it a person's problem");
    outbox.sent("a", "om_123");
    assert.deepEqual(outbox.pending(), []);
    assert.equal(outbox.enqueue({ id: "a", chatKey: "feishu:oc_1", purpose: "answer owed as d1", text: "late answer" }), "duplicate", "sent is final");

    assert.equal(outbox.enqueue({ id: "b", chatKey: "feishu:oc_2", purpose: "notice", text: "hi" }), "queued");
    outbox.dropped("b", "chat not found");
    assert.deepEqual(outbox.pending(), []);
    assert.equal(outbox.enqueue({ id: "b", chatKey: "feishu:oc_2", purpose: "notice", text: "hi" }), "duplicate", "dropped is a verdict");
  } finally { cleanup(); }
});

test("what was pending survives a restart with its text and its count", () => {
  const { path, cleanup } = temp();
  try {
    const first = new Outbox(path);
    first.enqueue({ id: "c", chatKey: "telegram:1", purpose: "attention under t3", text: "which region?" });
    first.failed("c", "ETIMEDOUT");
    const second = new Outbox(path);
    assert.deepEqual(second.pending().map(r => [r.id, r.text, r.attempts]), [["c", "which region?", 1]]);
  } finally { cleanup(); }
});
