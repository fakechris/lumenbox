/** Sending under a receipt (INV-1460): retried on a blink, dropped on a verdict, in order per chat, resumed after a restart. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../host/outbox.ts";
import { OutboxSender } from "./outbox-sender.ts";

function harness(): { outbox: Outbox; sender: OutboxSender; waits: number[]; log: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-outbox-sender-"));
  const outbox = new Outbox(join(dir, "outbox.jsonl"));
  const waits: number[] = [];
  const log: string[] = [];
  const sender = new OutboxSender(outbox, line => log.push(line), async ms => { waits.push(ms); });
  return { outbox, sender, waits, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a blink is retried with backoff and the receipt settles as sent; the same message is not sent twice", async () => {
  const { outbox, sender, waits, cleanup } = harness();
  try {
    let calls = 0;
    const adapter = { sendToChat: async () => { calls += 1; if (calls < 3) throw new Error("ETIMEDOUT"); } };
    const purpose = { kind: "answer" as const, deliveryId: "d1" };
    assert.deepEqual(await sender.send({ adapter, chatKey: "feishu:oc_1", text: "late", purpose }), { delivered: true });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [5_000, 10_000]);
    assert.deepEqual(outbox.pending(), []);
    assert.deepEqual(await sender.send({ adapter, chatKey: "feishu:oc_1", text: "late", purpose }), { delivered: true, duplicate: true });
    assert.equal(calls, 3, "a duplicate id sends nothing");
  } finally { cleanup(); }
});

test("three failures leave the message pending for a person; a door's verdict drops it at once", async () => {
  const { outbox, sender, waits, cleanup } = harness();
  try {
    const down = { sendToChat: async () => { throw new Error("ECONNRESET"); } };
    const result = await sender.send({ adapter: down, chatKey: "telegram:1", text: "x", purpose: { kind: "notice", about: "digest" } });
    assert.equal(result.delivered, false);
    assert.deepEqual(waits, [5_000, 10_000]);
    assert.equal(outbox.problems().length, 1);
    const gone = { sendToChat: async () => { throw new Error("bot was removed from chat"); } };
    const dropped = await sender.send({ adapter: gone, chatKey: "telegram:2", text: "y", purpose: { kind: "notice", about: "digest" } });
    assert.equal(dropped.delivered, false);
    assert.equal(waits.length, 2, "no retry after a verdict");
    assert.deepEqual(outbox.pending().map(r => r.chatKey), ["telegram:1"]);
  } finally { cleanup(); }
});

test("messages to one chat go out in order, each waiting for the one before it", async () => {
  const { sender, cleanup } = harness();
  try {
    const sent: string[] = [];
    let first = true;
    const adapter = { sendToChat: async (_chat: string, text: string) => { if (first) { first = false; throw new Error("ETIMEDOUT"); } sent.push(text); } };
    const a = sender.send({ adapter, chatKey: "feishu:oc_1", text: "ack", purpose: { kind: "ack", messageId: "m1" } });
    const b = sender.send({ adapter, chatKey: "feishu:oc_1", text: "result", purpose: { kind: "result", taskId: "t1" } });
    await Promise.all([a, b]);
    assert.deepEqual(sent, ["ack", "result"]);
  } finally { cleanup(); }
});

test("after a restart, what was pending goes again through the door it was for", async () => {
  const { outbox, sender, cleanup } = harness();
  try {
    outbox.enqueue({ id: "r1", chatKey: "feishu:oc_1", purpose: "attention under t3", text: "which region?" });
    outbox.enqueue({ id: "r2", chatKey: "feishu:oc_1", purpose: "notice", text: "gave up" });
    for (let i = 0; i < 3; i += 1) outbox.failed("r2", "x");
    const sent: string[] = [];
    const resumed = await sender.resume(() => ({ sendToChat: async (_c: string, text: string) => { sent.push(text); } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resumed, 1, "the one past its attempts is a person's problem, not a retry");
    assert.deepEqual(sent, ["which region?"]);
    assert.deepEqual(outbox.pending().map(r => r.id), ["r2"]);
  } finally { cleanup(); }
});
