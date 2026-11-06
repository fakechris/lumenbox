/**
 * The A / B / person episode on the real bus (INV-1625): what each arrival does to A's row.
 * The turn runner stands where the model would, and classifies each inbound message the way
 * the wiring will — by who wrote it — before telling the ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../agents/bus.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { activityOfInbound, ConversationState, rowMarker } from "./conversation-state.ts";

test("A messages the person → unread 1; A waits on an approval → blocked with the reason; the person opens A → unread 0, still blocked; the person refuses → clear; B messages A → nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-convstate-bus-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const state = new ConversationState(join(root, "conversation-state.jsonl"));
    const turns: string[] = [];
    const bus = new AgentBus(registry, async (agent, inbound, _signal, conversation) => {
      for (const message of inbound) {
        turns.push(`${agent.profile.name} <- ${message.fromName}`);
        state.note({ kind: activityOfInbound(message), agentId: agent.id, conversation });
      }
    });
    const row = () => { const facts = state.summary(ada.id, "main"); return { unread: facts.unreadCount, marker: rowMarker(facts, bus.isActive(ada.id, "main")), reason: facts.awaiting?.reason }; };

    // A says something to the person (the turn's reply lands): one unread.
    state.note({ kind: "agentSaid", agentId: ada.id, conversation: "main" });
    assert.deepEqual(row(), { unread: 1, marker: "unread", reason: undefined });

    // A's command waits for consent: the gate tells the ledger; blocked wins over unread.
    state.setAwaiting(ada.id, "main", { kind: "approval", reason: "run a command in the box", since: new Date().toISOString() });
    assert.deepEqual(row(), { unread: 1, marker: "blocked", reason: "run a command in the box" });

    // The person opens A's chat in a focused window: read, still blocked.
    state.viewed(ada.id, "main");
    assert.deepEqual(row(), { unread: 0, marker: "blocked", reason: "run a command in the box" });

    // Teammate B messages A: a turn runs, and A's row does not move.
    const before = state.summary(ada.id, "main");
    bus.send({ fromId: bob.id, toId: ada.id, text: "can you review t7?" });
    await bus.idle();
    assert.ok(turns.includes("Ada <- Bob"), "the turn ran");
    assert.deepEqual(state.summary(ada.id, "main"), before, "a teammate's message is not activity");

    // The host wakes A (a job ended): also not activity.
    bus.sendFromUser(ada.id, "[A command you started earlier finished with exit code 1]", { conversation: "main", lane: "background", synthetic: true, origin: "host:jobs" });
    await bus.runExclusive(ada.id, { userDriven: true, conversation: "main" });
    assert.deepEqual(state.summary(ada.id, "main"), before, "the host's own prompt is not activity");

    // The person refuses: the gate clears awaiting; nothing waits any more.
    state.setAwaiting(ada.id, "main", undefined);
    assert.deepEqual(row(), { unread: 0, marker: undefined, reason: undefined });

    // The person speaks to A from the page: the conversation moved, nothing unread, and any awaiting would clear.
    state.setAwaiting(ada.id, "main", { kind: "question", reason: "Which account?", since: new Date().toISOString() });
    bus.sendFromUser(ada.id, "the staging one", { conversation: "main" });
    await bus.runExclusive(ada.id, { userDriven: true, conversation: "main" });
    assert.ok(turns.includes("Ada <- user") || turns.some(t => t.startsWith("Ada <-")));
    const after = state.summary(ada.id, "main");
    assert.equal(after.unreadCount, 0);
    assert.equal(after.awaiting, undefined, "the person's answer in the chat clears what A waited on");
    assert.ok(after.lastActivityAt! > before.lastActivityAt!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
