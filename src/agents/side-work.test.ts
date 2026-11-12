/**
 * A colleague's message never waits on a person who is not there, and never gets in a person's way
 * (docs/99 §5, INV-1824).
 *
 * Holding every unrelated message while a person's work was unfinished kept the agent's attention —
 * and left its colleagues unanswered for as long as the person took to reply to a question. These
 * are the three rules that replace the hold: side work runs only while the person's work is waiting;
 * it runs somewhere that is not the person's conversation; and the moment the person's work can
 * move, it has the agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus, type BusEvent } from "./bus.ts";
import type { InboundMessage } from "./admitted-message.ts";
import { AgentRegistry } from "./registry.ts";
import { WorkAttention } from "./work-attention.ts";

interface Ran { conversation: string; texts: string[]; aborted: boolean }

function world() {
  const dir = mkdtempSync(join(tmpdir(), "side-work-"));
  const registry = new AgentRegistry(join(dir, "agents"));
  const mia = registry.create({ name: "Mia" }), bob = registry.create({ name: "Bob" });
  const focus = new WorkAttention();
  const ran: Ran[] = [], events: BusEvent[] = [];
  /** Turns whose text matches a gate stay in flight until it is opened. */
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  const gate = (text: string) => {
    let open = () => {};
    const opened = new Promise<void>(resolve => { open = resolve; });
    gates.set(text, { opened, open });
    return open;
  };
  /** How the person's turn leaves its work: waiting on them, or answered. */
  let settleAs: "waiting" | "answered" = "waiting";
  const bus: AgentBus = new AgentBus(registry, async (_agent, inbound: readonly InboundMessage[], signal, conversation) => {
    const record: Ran = { conversation, texts: inbound.map(message => message.text), aborted: false };
    ran.push(record);
    const held = [...gates.entries()].find(([text]) => record.texts.some(row => row.includes(text)))?.[1];
    if (held) await Promise.race([held.opened, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve()))]);
    if (signal.aborted) { record.aborted = true; throw new Error("aborted"); }
    const work = inbound[0]?.work;
    if (work && work.owner === mia.id && inbound.some(message => message.fromId === "user")) focus.settle(work, settleAs, settleAs === "waiting" ? "waiting for confirmation" : undefined, "confirmation");
  }, event => events.push(event), undefined, false, undefined, focus);
  return { mia, bob, bus, focus, ran, events, gate, settle: (how: "waiting" | "answered") => { settleAs = how; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fromBob = (w: ReturnType<typeof world>, text: string) => w.bus.send({ fromId: w.bob.id, toId: w.mia.id, text });

test("while a person's work waits on them, a colleague's unrelated message is handled, somewhere else", async () => {
  const w = world();
  try {
    w.bus.sendFromUser(w.mia.id, "Migrate the billing database");
    await w.bus.wake(w.mia.id); await w.bus.idle();
    assert.equal(w.focus.get(w.mia.id, "main")!.status, "waiting");

    fromBob(w, "Is the staging build green?");
    await w.bus.wake(w.mia.id); await w.bus.idle();

    const side = w.ran.find(row => row.texts.some(text => text.includes("staging build")));
    assert.ok(side, "the colleague was answered without waiting for the person");
    assert.notEqual(side.conversation, "main", "and not in the person's conversation");
    assert.equal(w.focus.get(w.mia.id, "main")!.status, "waiting", "the person's work is untouched");
    assert.equal(w.bus.heldCount(w.mia.id, "main"), 0);
  } finally { w.cleanup(); }
});

test("while a person's turn is running, a colleague's message does not start", async () => {
  const w = world();
  try {
    const finish = w.gate("Migrate");
    w.bus.sendFromUser(w.mia.id, "Migrate the billing database");
    const running = w.bus.wake(w.mia.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    fromBob(w, "Is the staging build green?");
    await w.bus.wake(w.mia.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(w.ran.some(row => row.texts.some(text => text.includes("staging build"))), false, "nothing ran beside the person's turn");
    finish(); await running; await w.bus.idle();
    assert.ok(w.ran.some(row => row.texts.some(text => text.includes("staging build"))), "it ran once the person's work was waiting");
  } finally { w.cleanup(); }
});

test("when the person speaks, side work in flight is interrupted, the person goes first, and the colleague's message runs once more after", async () => {
  const w = world();
  try {
    w.bus.sendFromUser(w.mia.id, "Migrate the billing database");
    await w.bus.wake(w.mia.id); await w.bus.idle();

    const release = w.gate("staging build");
    fromBob(w, "Is the staging build green?");
    const side = w.bus.wake(w.mia.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(w.ran.at(-1)!.texts.some(text => text.includes("staging build")), true, "the side turn is in flight");

    w.settle("answered");
    w.bus.sendFromUser(w.mia.id, "Use Saturday night");
    const person = w.bus.wake(w.mia.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    release(); // the second attempt is not held
    await person; await side; await w.bus.idle();

    const order = w.ran.map(row => (row.texts.some(text => text.includes("staging build")) ? "bob" : "person") + (row.aborted ? ":interrupted" : ""));
    assert.deepEqual(order, ["person", "bob:interrupted", "person", "bob"]);
    assert.ok(w.events.some(event => event.type === "turn_interrupted" && event.reason === "user_work"));
    assert.equal(w.events.some(event => event.type === "turn_failed"), false, "an interruption for the person is not a failure, and the sender is not told it was");
  } finally { w.cleanup(); }
});

test("work that is about to move by itself has nothing started beside it; an errand without a work stamp gets a small budget", async () => {
  const { isSideWork, sideTurnBudget, SIDE_CALLS } = await import("./side-work.ts");
  const focus = new WorkAttention();
  const person: InboundMessage = { id: "m1", fromId: "user", fromName: "Chris", text: "Migrate", priority: false, receivedAt: "" };
  const stamp = focus.begin("mia", "main", [person])!;
  const errand: InboundMessage = { id: "m2", fromId: "bob", fromName: "Bob", text: "Is staging green?", priority: true, receivedAt: "" };
  focus.settle(stamp, "waiting", "turn_budget", "execution");
  assert.equal(isSideWork(focus, "mia", errand), false, "between two slices of the person's own work");
  focus.settle(stamp, "waiting", "waiting for confirmation", "confirmation");
  assert.equal(isSideWork(focus, "mia", errand), true, "while it waits for the person");
  assert.equal(isSideWork(focus, "mia", { ...errand, fromId: "system" }), false, "the host's own notices wait for the person's conversation");
  assert.equal(isSideWork(focus, "mia", { ...errand, informational: true }), false);
  assert.equal(sideTurnBudget([{ ...errand, side: true }], { calls: 60, repeats: 3 })!.calls, SIDE_CALLS);
  assert.equal(sideTurnBudget([{ ...errand, side: true, work: stamp }], { calls: 60, repeats: 3 })!.calls, 60, "stamped work for somebody is real work");
  assert.equal(sideTurnBudget([errand], { calls: 60, repeats: 3 })!.calls, 60);
});
