/**
 * The race catalog: every check-then-act across an await, both orders, on purpose.
 *
 * A race in this codebase has one shape: a decision reads state, an await passes, a
 * write commits the stale decision. Single-threaded JS means these exist only across
 * await boundaries — which is exactly where they hide from ordinary tests, because an
 * ordinary test never controls which side of the boundary runs first.
 *
 * Each test here names one race, states its two legal histories, and forces each with
 * a gate: the stub turn runner parks on a promise the test releases. If a third
 * history exists — a lost message, a double consumption, a zombie write — one of the
 * two forced orders exposes it. The catalog is the contract; a concurrency change that
 * breaks an order breaks a named test, not a user.
 *
 * Races that cannot happen are documented where they cannot happen: decisions made in
 * one synchronous block (approval grant/consume, usage seq, inbox admission) cannot
 * interleave and are deliberately absent here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { AgentBus, type BusEvent, type InboundMessage } from "./bus.ts";

function tempRegistry(): { registry: AgentRegistry; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-races-"));
  return {
    registry: new AgentRegistry(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A turn that parks until the test releases it, recording what it drained. */
function gatedRunner() {
  const turns: {
    conversation: string;
    texts: string[];
    release: () => void;
  }[] = [];
  const runner = async (
    _agent: unknown,
    inbound: readonly InboundMessage[],
    _signal: AbortSignal,
    conversation: string
  ) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    turns.push({ conversation, texts: inbound.map(m => m.text), release });
    await gate;
  };
  return { turns, runner };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Polls a condition across event-loop turns; the test names what it waited for. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

// ── R1: a message arrives while the same conversation's turn is in flight ─────────
//
// Histories: (a) before the drain — the running turn consumes it; (b) after the
// drain — a follow-up turn consumes it. Never: lost, or consumed twice.

test("R1a: a message landing before the drain is consumed by that turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "first");
    bus.sendFromUser(ada.id, "second"); // lands before any turn starts: same drain
    const done = bus.wake(ada.id);
    await tick();

    assert.equal(turns.length, 1, "one turn");
    assert.deepEqual(turns[0]!.texts, ["first", "second"], "both consumed by the one drain");
    turns[0]!.release();
    await done;
    assert.equal(bus.pendingCount(ada.id), 0);
  } finally {
    cleanup();
  }
});

test("R1b: a message landing after the drain gets its own follow-up turn, exactly once", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "first");
    const done = bus.wake(ada.id);
    await tick(); // turn 1 is parked, its drain already taken

    bus.sendFromUser(ada.id, "second"); // strictly after the drain
    assert.equal(turns.length, 1, "still inside turn 1");
    turns[0]!.release();
    // The wake loop parks the follow-up turn on its own gate; release it when it appears.
    await until(() => turns.length === 2, "the follow-up turn started");
    turns[1]!.release();
    await done;

    assert.equal(turns.length, 2, "exactly one follow-up turn ran");
    assert.deepEqual(turns[1]!.texts, ["second"], "consumed exactly once");
    assert.equal(bus.pendingCount(ada.id), 0, "nothing lost, nothing left");
  } finally {
    cleanup();
  }
});

// ── R2: a priority message vs the turn it wants to interrupt ──────────────────────
//
// Histories: (a) turn still running — background work is aborted, the message wakes a
// fresh turn; (b) turn already finished — no abort fires, the message simply wakes
// the next turn. Never: an abort that kills a *later* turn, or a lost message.

test("R2a: priority lands mid-turn — the background turn is aborted and the message still runs", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const seen: { texts: string[]; aborted: boolean }[] = [];
    const releases: (() => void)[] = [];
    const events: BusEvent[] = [];
    const bus = new AgentBus(
      registry,
      async (_agent, inbound, signal) => {
        const record = { texts: inbound.map(m => m.text), aborted: false };
        seen.push(record);
        await new Promise<void>(resolve => {
          releases.push(resolve);
          signal.addEventListener("abort", () => {
            record.aborted = true;
            resolve();
          });
        });
      },
      event => events.push(event)
    );

    bus.sendFromUser(ada.id, "slow background work");
    const done = bus.wake(ada.id);
    await tick(); // turn 1 parked, holding the signal

    bus.send({ fromId: registry.create({ name: "Bob" }).id, toId: ada.id, text: "urgent", priority: true });
    await tick();

    assert.equal(seen[0]!.aborted, true, "the running background turn was aborted");
    assert.ok(
      events.some(e => e.type === "turn_interrupted"),
      "and the interruption is an event, not a silence"
    );

    // The urgent message is not lost: it runs on the follow-up turn, which parks on
    // its own gate — release it when it appears.
    await until(() => releases.length === 2, "the follow-up turn started");
    releases[1]!();
    await done.catch(() => {});
    await bus.idle(5000);
    const later = seen.slice(1).flatMap(turn => turn.texts);
    assert.ok(later.some(text => text.includes("urgent")), `urgent ran later: ${JSON.stringify(seen)}`);
  } finally {
    cleanup();
  }
});

test("R2b: priority lands after the turn finished — no abort, consumed by the next turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const seen: string[][] = [];
    let interrupted = 0;
    const bus = new AgentBus(
      registry,
      async (_agent, inbound) => {
        seen.push(inbound.map(m => m.text));
      },
      event => {
        if (event.type === "turn_interrupted") interrupted += 1;
      }
    );

    bus.sendFromUser(ada.id, "quick work");
    await bus.wake(ada.id); // turn fully finished

    bus.send({ fromId: bob.id, toId: ada.id, text: "urgent", priority: true });
    await bus.idle(5000);

    assert.equal(interrupted, 0, "nothing was running, so nothing was interrupted");
    assert.ok(seen.some(texts => texts.some(t => t.includes("urgent"))), "consumed normally");
  } finally {
    cleanup();
  }
});

// ── R3: deleting an agent vs its queued-but-unstarted work ────────────────────────
//
// Histories: (a) the turn started first — deletion is refused by the route (that
// check is synchronous with the removal and cannot race in one process); (b) the
// removal lands before the turn starts — the wake must fail that turn loudly and
// must NOT resurrect the agent's directory by writing into it.

test("R3: removal before the turn starts fails the turn and leaves no zombie directory", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const dir = registry.dirFor(ada.id);
    const events: BusEvent[] = [];
    const { runner } = gatedRunner();
    const bus = new AgentBus(registry, runner, event => events.push(event));

    bus.sendFromUser(ada.id, "work that will never start");
    registry.remove(ada.id, { archive: false }); // lands before any wake
    assert.ok(!existsSync(dir), "removed");

    await bus.wake(ada.id); // must not throw out of the loop, must not recreate the dir
    assert.ok(
      events.some(e => e.type === "turn_failed"),
      `the missed work is a loud failure, not a silence: ${JSON.stringify(events.map(e => e.type))}`
    );
    assert.ok(!existsSync(dir), "no zombie directory was written back");
  } finally {
    cleanup();
  }
});

// ── R4: a peer message vs the recipient's active turn ─────────────────────────────
//
// Histories: (a) recipient idle — the send wakes it directly; (b) recipient mid-turn
// — the message waits and a follow-up turn consumes it. Never: delivered into the
// middle of the running turn's context, or dropped.

test("R4: a peer message during the recipient's turn arrives on the next turn, exactly once", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "long task");
    const done = bus.wake(ada.id);
    await tick(); // Ada's turn parked, drain taken

    bus.send({ fromId: bob.id, toId: ada.id, text: "psst" });
    assert.equal(turns.length, 1, "the running turn did not absorb it mid-flight");
    assert.deepEqual(turns[0]!.texts, ["long task"]);

    turns[0]!.release();
    await until(() => turns.length === 2, "the follow-up turn started");
    turns[1]!.release();
    await done;
    await bus.idle(5000);

    const followUps = turns.slice(1).flatMap(t => t.texts);
    assert.deepEqual(followUps, ["psst"], "delivered on its own turn, once");
  } finally {
    cleanup();
  }
});

// ── R5: two conversations of one agent, interleaved arrivals ──────────────────────
//
// Histories: any interleaving of the two lanes is legal; within one lane, arrival
// order holds. Never: a message consumed by the other lane's turn.

test("R5: interleaved arrivals never cross lanes, whatever the order", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "room-1");
    bus.sendFromUser(ada.id, "tg-1", { conversation: "telegram-9" });
    const done = bus.wake(ada.id);
    await tick(); // both lanes parked

    // Late arrivals for both lanes while both are mid-turn.
    bus.sendFromUser(ada.id, "tg-2", { conversation: "telegram-9" });
    bus.sendFromUser(ada.id, "room-2");

    // Release in reverse order of start, on purpose: order between lanes is free.
    for (const turn of [...turns].reverse()) turn.release();
    // Each lane's follow-up turn parks on its own gate; release them as they appear.
    await until(() => turns.length === 4, "both follow-up turns started");
    for (const turn of turns) turn.release();
    await done;
    await bus.idle(5000);

    const room = turns.filter(t => t.conversation === "main").flatMap(t => t.texts);
    const telegram = turns.filter(t => t.conversation === "telegram-9").flatMap(t => t.texts);
    assert.deepEqual(room, ["room-1", "room-2"], "room lane in order, room messages only");
    assert.deepEqual(telegram, ["tg-1", "tg-2"], "telegram lane in order, telegram messages only");
  } finally {
    cleanup();
  }
});

// ── R6: the user speaks while a turn runs — steering vs the queued follow-up ──────
//
// Histories: (a) the running turn takes it as steering at a round boundary — the
// queued runExclusive then drains empty and must NOT burn a turn; (b) the turn
// finishes first — the message runs as an ordinary next turn. Never: both.

test("R6a: a running turn steers; the queued follow-up drains empty and runs nothing", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "long task");
    const done = bus.wake(ada.id);
    await tick(); // turn 1 parked

    bus.sendFromUser(ada.id, "actually, also do X");
    const followUp = bus.runExclusive(ada.id, { userDriven: true }); // what prompt() does

    // The running turn takes it, as runTurn would at a round boundary.
    const steered = bus.takeSteering(ada.id);
    assert.deepEqual(steered.map(m => m.text), ["actually, also do X"]);

    turns[0]!.release();
    await done;
    await followUp; // resolves without running anything

    assert.equal(turns.length, 1, "no empty turn was burned for the consumed message");
    assert.equal(bus.pendingCount(ada.id), 0);
  } finally {
    cleanup();
  }
});

test("R6b: the turn finishes first; the message runs as an ordinary next turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.sendFromUser(ada.id, "quick task");
    const done = bus.wake(ada.id);
    await tick();
    turns[0]!.release();
    await done; // fully finished; nothing steered

    bus.sendFromUser(ada.id, "next thing");
    const followUp = bus.runExclusive(ada.id, { userDriven: true });
    await until(() => turns.length === 2, "the ordinary turn started");
    turns[1]!.release();
    await followUp;

    assert.deepEqual(turns[1]!.texts, ["next thing"], "consumed once, as its own turn");
  } finally {
    cleanup();
  }
});

test("R6c: steering never takes a peer message or a kickoff flagged steerable:false", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const { runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    bus.send({ fromId: bob.id, toId: ada.id, text: "peer note" });
    bus.sendFromUser(ada.id, "scheduled kickoff", { steerable: false });
    bus.sendFromUser(ada.id, "steer me", { conversation: "telegram-1" });

    assert.deepEqual(bus.takeSteering(ada.id), [], "main: the peer note and the kickoff stay queued");
    assert.deepEqual(
      bus.takeSteering(ada.id, "telegram-1").map(m => m.text),
      ["steer me"],
      "the other conversation's user message steers its own lane only"
    );
    assert.equal(bus.pendingCount(ada.id), 2, "the exempt messages still wait for their own turns");
  } finally {
    cleanup();
  }
});

// ── Queue status: what a channel acknowledgement reads ────────────────────────────
//
// Not a race — a read-only view — but it lives with the harness that can hold a turn
// open, because "while a turn is in flight" is the only state worth asserting.

test("queuedCount and isActive answer per conversation, while turns run", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { turns, runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    assert.equal(bus.isActive(ada.id, "chat-1"), false);
    assert.equal(bus.queuedCount(ada.id, "chat-1"), 0);

    bus.sendFromUser(ada.id, "task one", { conversation: "chat-1" });
    const done = bus.wake(ada.id);
    await tick(); // turn parked, drain taken

    assert.equal(bus.isActive(ada.id, "chat-1"), true);
    assert.equal(bus.queuedCount(ada.id, "chat-1"), 0, "in flight is not queued");
    assert.equal(bus.isActive(ada.id, "chat-2"), false, "another conversation is idle");

    bus.sendFromUser(ada.id, "task two", { conversation: "chat-1" });
    assert.equal(bus.queuedCount(ada.id, "chat-1"), 1, "waiting behind the running turn");
    assert.equal(bus.queuedCount(ada.id, "chat-2"), 0);

    turns[0]!.release();
    await until(() => turns.length === 2, "the queued turn started");
    turns[1]!.release();
    await done;

    assert.equal(bus.isActive(ada.id, "chat-1"), false, "nothing in flight after the drain");
    assert.equal(bus.queuedCount(ada.id, "chat-1"), 0);
  } finally {
    cleanup();
  }
});

// ── Lanes: what waits for what ────────────────────────────────────────────────────
//
// A person's question and a nightly digest are not the same urgency. The rule is
// strict priority with one exception, and both halves are load-bearing: without the
// priority a question queues behind a schedule, without the exception a busy room
// starves its own audits.

test("a turn takes one lane at a time, highest first, and never mixes them", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const { runner } = gatedRunner();
    const bus = new AgentBus(registry, runner);

    // Queued in the wrong order on purpose: background first, then a teammate, then
    // the person — arrival order must not decide this.
    bus.sendFromUser(ada.id, "nightly digest", { lane: "background" });
    bus.send({ fromId: registry.create({ name: "Bob" }).id, toId: ada.id, text: "peer note" });
    bus.sendFromUser(ada.id, "what is the status?");

    assert.deepEqual(
      bus.drain(ada.id).map(m => m.text),
      ["what is the status?"],
      "the person goes first, alone — not batched with the digest"
    );
    assert.deepEqual(bus.drain(ada.id).map(m => m.text), ["peer note"], "then the teammate");
    assert.deepEqual(bus.drain(ada.id).map(m => m.text), ["nightly digest"], "then the schedule");
    assert.deepEqual(bus.drain(ada.id), []);
  } finally {
    cleanup();
  }
});

test("a lane held down too long goes first anyway, and only while it is held down", async () => {
  const { chooseLane } = await import("./bus.ts");
  const at = (lane: "user" | "agent" | "background", secondsAgo: number) =>
    ({
      lane,
      fromId: lane === "user" ? "user" : "someone",
      fromName: "x",
      text: "x",
      priority: false,
      id: `${lane}-${secondsAgo}`,
      receivedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    }) as never;
  const now = Date.now();
  const window = 120_000;

  // The ordinary case: everything fresh, priority decides.
  assert.equal(chooseLane([at("background", 1), at("user", 1)], now, window), "user");

  // Starvation: a stream of *fresh* questions while an audit waits. The audit wins,
  // which is the whole point of the rule.
  assert.equal(chooseLane([at("background", 300), at("user", 1)], now, window), "background");

  // Not starvation, just a backlog: when the questions are old too, they are higher
  // and they go first. Nothing is being held down — the agent is simply behind.
  assert.equal(chooseLane([at("background", 300), at("user", 300)], now, window), "user");

  // And the promotion cannot repeat, because taking a lane empties it — asserted on
  // the bus rather than here, since that is where emptying happens.
  assert.equal(chooseLane([], now, window), undefined);
});
