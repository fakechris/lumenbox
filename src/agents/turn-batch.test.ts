/** A turn takes at most so many messages and so much text; the rest waits its turn, in order (INV-1572). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { AgentBus, type InboundMessage } from "./bus.ts";
import { batchLimitsFrom, boundBatch } from "./turn-batch.ts";

const msg = (text: string) => ({ text });

test("a batch stops at the item or the byte limit, and a message larger than the byte limit goes alone", () => {
  const limits = { items: 3, bytes: 10 };
  assert.deepEqual(boundBatch(["a", "b", "c", "d"].map(msg), limits).map(m => m.text), ["a", "b", "c"]);
  assert.deepEqual(boundBatch(["12345", "12345", "1"].map(msg), limits).map(m => m.text), ["12345", "12345"], "the third would pass 10 bytes");
  assert.deepEqual(boundBatch(["x".repeat(50), "y"].map(msg), limits).map(m => m.text), ["x".repeat(50)], "oversized: alone, not split, not refused");
  assert.deepEqual(boundBatch([], limits), []);
  assert.deepEqual(boundBatch(["你好世界".repeat(2)].map(msg), { items: 8, bytes: 1 }).length, 1, "bytes are UTF-8 bytes, and the first message always goes");
  assert.deepEqual(batchLimitsFrom((_name, fallback) => fallback), { items: 8, bytes: 24 * 1024 });
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test("scenario: 1,000 queued notices drain eight at a time, in order, none lost; a person's message mid-backlog goes next", async () => {
  const root = mkdtempSync(join(tmpdir(), "turn-batch-"));
  try {
    const registry = new AgentRegistry(root);
    const bob = registry.create({ name: "Bob" });
    const turns: { lane: string; texts: string[]; bytes: number }[] = [];
    let bus!: AgentBus;
    const runner = async (_agent: unknown, inbound: readonly InboundMessage[]) => {
      turns.push({ lane: inbound[0]?.fromId === "user" ? "person" : "notices", texts: inbound.map(m => m.text), bytes: inbound.reduce((n, m) => n + Buffer.byteLength(m.text), 0) });
      if (turns.length === 3) bus.sendFromUser(bob.id, "Chris: stop and summarise"); // arrives mid-backlog
      await tick();
    };
    bus = new AgentBus(registry, runner as never);
    for (let i = 0; i < 1000; i++) bus.deliverSystem(bob.id, `notice ${String(i).padStart(4, "0")}`);
    for (let i = 0; i < 2000 && bus.pendingCount(bob.id) > 0; i++) await tick();
    await bus.wake(bob.id);
    for (let i = 0; i < 2000 && bus.pendingCount(bob.id) > 0; i++) await tick();

    const notices = turns.filter(t => t.lane === "notices");
    assert.ok(notices.every(t => t.texts.length <= 8 && t.bytes <= 24 * 1024), "every turn within the limits");
    const seen = notices.flatMap(t => t.texts);
    assert.equal(seen.length, 1000, "none lost");
    assert.deepEqual(seen, Array.from({ length: 1000 }, (_, i) => `notice ${String(i).padStart(4, "0")}`), "none reordered");
    const personTurn = turns.findIndex(t => t.lane === "person");
    assert.equal(personTurn, 3, "the person's message is the very next turn after it arrived, ahead of the backlog");
    assert.deepEqual(turns[personTurn]!.texts, ["Chris: stop and summarise"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
