/**
 * Tests for the multi-agent runtime.
 *
 * The bus semantics are the part worth pinning down: fire-and-forget delivery,
 * one turn per agent at a time, priority interrupting background work but not the
 * user's own turn, and a burst of messages collapsing into a single turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { STARTER_TEAM } from "../host/orchestrator.ts";
import { AgentBus, type InboundMessage } from "./bus.ts";

function tempRegistry(): { registry: AgentRegistry; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  return {
    registry: new AgentRegistry(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("registry round-trips an agent through disk", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({
      name: "Ada",
      description: "coordinates the team",
      title: "coordinator",
    });

    const loaded = registry.get(created.id);
    assert.equal(loaded.profile.name, "Ada");
    assert.equal(loaded.profile.description, "coordinates the team");
    assert.equal(loaded.profile.title, "coordinator");

    // The profile must be valid JSON on disk — the agent reads it with a shell.
    const raw = readFileSync(registry.profilePathFor(created.id), "utf8");
    assert.equal(JSON.parse(raw).name, "Ada");
  } finally {
    cleanup();
  }
});

test("registry clamps names to one line and enforces a non-empty name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({ name: "  Grace\n  Hopper  " });
    assert.equal(created.profile.name, "Grace Hopper");
    assert.throws(() => registry.create({ name: "   " }), /non-empty name/);
  } finally {
    cleanup();
  }
});

test("registry update merges and never blanks a name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({ name: "Ada", description: "original" });

    const renamed = registry.update(created.id, { name: "Ada Lovelace" });
    assert.equal(renamed.profile.name, "Ada Lovelace");
    assert.equal(renamed.profile.description, "original", "omitted fields survive");

    // An empty name is ignored rather than destroying the profile.
    const blanked = registry.update(created.id, { name: "  " });
    assert.equal(blanked.profile.name, "Ada Lovelace");
  } finally {
    cleanup();
  }
});

test("registry resolves by id or by unique name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    assert.equal(registry.resolve(ada.id).id, ada.id);
    assert.equal(registry.resolve("Ada").id, ada.id);
    assert.equal(registry.resolve("ada").id, ada.id, "name match is case-insensitive");

    registry.create({ name: "Ada" });
    assert.throws(() => registry.resolve("Ada"), /matches 2 agents/);
    assert.throws(() => registry.resolve("nobody"), /No agent found/);
  } finally {
    cleanup();
  }
});

test("registry memory and transcript persist across instances", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  try {
    const first = new AgentRegistry(root);
    const agent = first.create({ name: "Ada" });
    first.writeMemory(agent.id, "# Memory\n\n- prefers metric units\n");
    first.appendTranscript(agent.id, { role: "user", text: "hello" });
    first.appendTranscript(agent.id, { role: "assistant", text: "hi" });

    const second = new AgentRegistry(root);
    assert.match(second.readMemory(agent.id), /prefers metric units/);
    assert.equal(second.readTranscript(agent.id).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send returns an acknowledgement and queues for the recipient", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const seen: InboundMessage[][] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      seen.push([...inbound]);
    });

    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    const ack = bus.send({ fromId: ada.id, toId: bob.id, text: "please review" });
    assert.match(ack, /Sent to Bob/);
    assert.match(ack, /asynchronous/i, "the ack must tell the model not to wait");

    await bus.idle();
    assert.equal(seen.length, 1, "Bob ran exactly one turn");
    assert.equal(seen[0]![0]!.text, "please review");
    assert.equal(seen[0]![0]!.fromName, "Ada");
  } finally {
    cleanup();
  }
});

test("send refuses self-messaging and unknown targets without throwing", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const bus = new AgentBus(registry, async () => {});
    const ada = registry.create({ name: "Ada" });

    // These return text for the model rather than throwing: a bad tool call
    // should teach the model, not abort its turn.
    assert.match(
      bus.send({ fromId: ada.id, toId: ada.id, text: "hi" }),
      /can't message itself/
    );
    assert.match(
      bus.send({ fromId: ada.id, toId: "missing-id", text: "hi" }),
      /No agent found with id missing-id/
    );
    assert.match(bus.send({ fromId: ada.id, toId: ada.id, text: "   " }), /empty/);
  } finally {
    cleanup();
  }
});

test("a burst of messages collapses into one turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const turns: number[] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      turns.push(inbound.length);
    });

    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    // Three messages sent before Bob's turn starts should arrive together,
    // rather than waking him three times.
    bus.send({ fromId: ada.id, toId: bob.id, text: "one" });
    bus.send({ fromId: ada.id, toId: bob.id, text: "two" });
    bus.send({ fromId: ada.id, toId: bob.id, text: "three" });

    await bus.idle();
    assert.equal(turns.length, 1, "one turn, not three");
    assert.equal(turns[0], 3, "all three messages delivered to it");
  } finally {
    cleanup();
  }
});

test("turns for one agent are serialized, never concurrent", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    let inFlight = 0;
    let maxInFlight = 0;

    const bus = new AgentBus(registry, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight--;
    });

    const ada = registry.create({ name: "Ada" });

    // Three overlapping user turns for the same agent.
    bus.sendFromUser(ada.id, "first");
    const a = bus.runExclusive(ada.id, { userDriven: true });
    bus.sendFromUser(ada.id, "second");
    const b = bus.runExclusive(ada.id, { userDriven: true });
    bus.sendFromUser(ada.id, "third");
    const c = bus.runExclusive(ada.id, { userDriven: true });

    await Promise.all([a, b, c]);
    assert.equal(maxInFlight, 1, "an agent must only ever be inside one turn");
  } finally {
    cleanup();
  }
});

test("priority message interrupts a background turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    let bobAborted = false;
    let bobTurns = 0;

    const bus = new AgentBus(registry, async (agent, _inbound, signal) => {
      if (agent.id !== bob.id) return;
      bobTurns++;
      if (bobTurns === 1) {
        // Simulate a long background turn that watches for abort.
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) {
            bobAborted = true;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    });

    // Wake Bob with ordinary work, then interrupt with a priority message.
    bus.send({ fromId: ada.id, toId: bob.id, text: "background task" });
    await new Promise(resolve => setTimeout(resolve, 30));
    bus.send({ fromId: ada.id, toId: bob.id, text: "STOP", priority: true });

    await bus.idle();
    assert.equal(bobAborted, true, "the background turn saw the abort");
    assert.equal(bobTurns, 2, "a follow-up turn handled the priority message");
  } finally {
    cleanup();
  }
});

test("priority message does not interrupt the user's own turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    let adaAborted = false;

    const bus = new AgentBus(registry, async (agent, _inbound, signal) => {
      if (agent.id !== ada.id) return;
      for (let i = 0; i < 20; i++) {
        if (signal.aborted) {
          adaAborted = true;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });

    bus.sendFromUser(ada.id, "user is watching this");
    const userTurn = bus.runExclusive(ada.id, { userDriven: true });

    await new Promise(resolve => setTimeout(resolve, 20));
    bus.send({ fromId: bob.id, toId: ada.id, text: "STOP", priority: true });

    await userTurn;
    assert.equal(
      adaAborted,
      false,
      "the user's turn must finish; yanking it out from under them is worse"
    );

    await bus.idle();
  } finally {
    cleanup();
  }
});

test("a failing turn does not poison later turns for the same agent", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    let calls = 0;

    const bus = new AgentBus(registry, async () => {
      calls++;
      if (calls === 1) throw new Error("first turn explodes");
    });

    bus.sendFromUser(ada.id, "one");
    await assert.rejects(
      bus.runExclusive(ada.id, { userDriven: true }),
      /first turn explodes/
    );

    bus.sendFromUser(ada.id, "two");
    await bus.runExclusive(ada.id, { userDriven: true });
    assert.equal(calls, 2, "the second turn still ran");
  } finally {
    cleanup();
  }
});

test("agents can hand work back and forth without deadlocking", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const exchanges: string[] = [];

    // Bob replies once, then stays silent — the discipline the prompt asks for.
    const bus = new AgentBus(registry, async (agent, inbound) => {
      for (const message of inbound) {
        exchanges.push(`${message.fromName}->${agent.profile.name}: ${message.text}`);
      }
      if (agent.id === bob.id && inbound.some(m => m.text === "ping")) {
        bus.send({ fromId: bob.id, toId: ada.id, text: "pong" });
      }
    });

    bus.send({ fromId: ada.id, toId: bob.id, text: "ping" });
    await bus.idle();

    assert.deepEqual(exchanges, ["Ada->Bob: ping", "Bob->Ada: pong"]);
  } finally {
    cleanup();
  }
});

// ── the starter team ───────────────────────────────────────────────────────────────────

test("the starter team is small, distinct, and free of one-time instructions", () => {
  // Small because the roster is a cost: every agent appears in every other agent's system prompt,
  // and a team is also a set of desktops and a set of things a person reads before doing anything.
  assert.ok(STARTER_TEAM.length >= 2 && STARTER_TEAM.length <= 6, "a team, not a directory");

  const names = STARTER_TEAM.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, "names are distinct");
  assert.equal(STARTER_TEAM[0]?.title, "coordinator", "the first one is who a person talks to");

  for (const entry of STARTER_TEAM) {
    // A description is re-read into the system prompt on every turn, so a one-time instruction
    // parked here keeps asserting itself long after it stopped being true. This is the lesson that
    // cost someone else a bug: a "the disk is low" briefing in a profile insists on it forever.
    // Narrowed after a false positive on correct text: "they talk to you first" is standing
    // identity, not a moment in time. The guard is for words that can only describe *now* —
    // a heuristic that fires on good prose is a worse test than no heuristic.
    assert.doesNotMatch(
      entry.description,
      /\b(start by|begin by|right now|currently|today|at the moment|for now)\b/i,
      `${entry.name}'s description reads like a briefing rather than an identity`
    );
    // Tool names in a description freeze on the day it was written.
    assert.doesNotMatch(
      entry.description,
      /SendToAgent|SetTodos|SetPlan|RememberFact|CreateAgent/,
      `${entry.name}'s description names a tool, which will be wrong after the next rename`
    );
    assert.ok(entry.description.length > 120, `${entry.name} needs enough to be a role`);
    assert.ok(entry.description.length < 900, `${entry.name} is paid for on every turn`);
  }
});

test("the starter team differs in what it touches, not in adjectives", () => {
  // Five flavours of "helpful assistant" would be worse than one agent, because it implies a
  // structure that does not exist. Each of these should name concrete, different work.
  const byName = new Map(STARTER_TEAM.map(entry => [entry.name, entry.description]));
  assert.match(byName.get("Rex") ?? "", /browser/i);
  assert.match(byName.get("Ops") ?? "", /shell/i);
  assert.match(byName.get("Vera") ?? "", /transcript/i);
  assert.match(byName.get("Ada") ?? "", /coordinate/i);

  // And the reviewer's remit names the failure it exists for, since "review the work" is an
  // instruction nobody can act on.
  assert.match(byName.get("Vera") ?? "", /looked like it worked and did not/);
});
