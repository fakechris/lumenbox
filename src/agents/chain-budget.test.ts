/**
 * The teammate chain budget (INV-1277): a send that is too many turns from a person is refused
 * with the reason, recorded for the attention panel, and cleared when a person-opened turn from
 * either side sends again. Checked at the bus so every sender is covered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { AgentBus, type BusEvent, teammateHopBudget } from "./bus.ts";

test("past the budget the bus refuses, records the pair, and a person-opened send clears it", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-chain-"));
  const saved = process.env.AGENTBOX_TEAMMATE_HOPS;
  try {
    delete process.env.AGENTBOX_TEAMMATE_HOPS;
    assert.equal(teammateHopBudget(), 3);
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const events: BusEvent[] = [];
    const bus = new AgentBus(registry, async () => {}, event => events.push(event));
    // Within the budget: sent, and the hop count rides the message.
    assert.match(bus.send({ fromId: ada.id, toId: bob.id, text: "one", hops: 3 }), /^Sent|^Delivered|Bob/);
    assert.equal(bus.pausedChains().length, 0);
    // One past it: refused with the reason, recorded, announced.
    const refused = bus.send({ fromId: ada.id, toId: bob.id, text: "two", hops: 4 });
    assert.match(refused, /^Not sent: this exchange has gone 4 turns between agents with no person/);
    assert.match(refused, /Stop here/);
    assert.deepEqual(bus.pausedChains().map(chain => [chain.fromName, chain.toName, chain.hops]), [["Ada", "Bob", 4]]);
    assert.ok(events.some(event => event.type === "chain_paused" && event.toName === "Bob"));
    // A person-opened turn (hops 0) from the other side brings the person back: cleared.
    bus.send({ fromId: bob.id, toId: ada.id, text: "the person says: go with A", hops: 0 });
    assert.equal(bus.pausedChains().length, 0);
    // The budget is per installation.
    process.env.AGENTBOX_TEAMMATE_HOPS = "1";
    assert.equal(teammateHopBudget(), 1);
    assert.match(bus.send({ fromId: ada.id, toId: bob.id, text: "three", hops: 2 }), /^Not sent/);
  } finally {
    if (saved === undefined) delete process.env.AGENTBOX_TEAMMATE_HOPS; else process.env.AGENTBOX_TEAMMATE_HOPS = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
