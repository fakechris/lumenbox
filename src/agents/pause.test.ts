/** A paused agent stays paused (INV-1554): on the real bus, across a restart, and until a person resumes it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { AgentBus, type InboundMessage } from "./bus.ts";
import { clearPause, readPause, writePause } from "./pause.ts";
import { AgentPauses, jobsNamedIn } from "../host/agent-pause.ts";
import { stillRunningNote } from "../host/exec-format.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("resumed: the note comes with what people sent, teammates follow, and a chat thread's queue is woken too", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-pause-lanes-"));
  try {
    const registry = new AgentRegistry(root);
    const bob = registry.create({ name: "Bob" }), ada = registry.create({ name: "Ada" });
    const turns: { conversation: string; texts: string[] }[] = [];
    const bus = new AgentBus(registry, (async (_agent: unknown, inbound: readonly InboundMessage[], _signal: AbortSignal, conversation: string) => { turns.push({ conversation, texts: inbound.map(m => m.text) }); }) as never);
    const pauses = new AgentPauses({ dirFor: id => registry.dirFor(id), interrupt: () => [], box: () => undefined, receipt: () => {}, log: () => {},
      tell: async (id, text) => { bus.sendFromUser(id, text, { lane: "user" }); }, wake: id => { void bus.wake(id); } });
    await pauses.pause(bob.id, "Chris", "looking into it");
    bus.send({ fromId: ada.id, toId: bob.id, text: "from Ada" });
    bus.sendFromUser(bob.id, "from Chris");
    bus.sendFromUser(bob.id, "in a chat thread", { conversation: "feishu:chat-1" });
    await settle();
    assert.equal(turns.length, 0, "nothing while paused");
    await pauses.resume(bob.id, "Chris");
    await settle();
    const main = turns.filter(t => t.conversation !== "feishu:chat-1");
    assert.match(main[0]!.texts.join("\n"), /from Chris[\s\S]*Chris resumed you|Chris resumed you[\s\S]*from Chris/, "the first turn has the note and the person's message");
    assert.ok(main.slice(1).some(t => t.texts.includes("from Ada")), "the teammate's comes after");
    assert.ok(turns.some(t => t.conversation === "feishu:chat-1" && t.texts.includes("in a chat thread")), "the chat thread is woken too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
async function settle() { for (let i = 0; i < 50; i++) await tick(); }

type Turn = { agent: string; texts: string[] };

function world(): { registry: AgentRegistry; turns: Turn[]; bus: () => AgentBus; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-pause-"));
  const registry = new AgentRegistry(root);
  const turns: Turn[] = [];
  const runner = async (agent: { id: string }, inbound: readonly InboundMessage[]) => { turns.push({ agent: agent.id, texts: inbound.map(m => m.text) }); };
  return { registry, turns, bus: () => new AgentBus(registry, runner as never), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("while paused, nothing starts a turn — a person, a teammate, a wake — and every message waits", async () => {
  const w = world();
  try {
    const bob = w.registry.create({ name: "Bob" }), ada = w.registry.create({ name: "Ada" });
    writePause(w.registry.dirFor(bob.id), { by: "Chris", at: "2026-11-04T00:00:00Z", reason: "probing the host" });
    const bus = w.bus();
    bus.sendFromUser(bob.id, "first");
    const ack = bus.send({ fromId: ada.id, toId: bob.id, text: "second" });
    await bus.wake(bob.id);
    await settle();
    assert.equal(w.turns.length, 0, "no turn");
    assert.equal(bus.pendingCount(bob.id), 2, "both messages wait");
    assert.match(ack, /Bob is paused \(by Chris: probing the host\)\. Nothing will read it until a person resumes them/);

    const afterRestart = w.bus();
    assert.equal(afterRestart.pauseOf(bob.id)?.by, "Chris", "a restart does not lift it");

    clearPause(w.registry.dirFor(bob.id));
    await bus.wake(bob.id);
    await settle();
    // Resumed, the queue is handled exactly as if there had been no pause: same turns, same order.
    const base = world();
    try {
      const bob2 = base.registry.create({ name: "Bob" }), ada2 = base.registry.create({ name: "Ada" });
      const plain = base.bus();
      plain.sendFromUser(bob2.id, "first");
      plain.send({ fromId: ada2.id, toId: bob2.id, text: "second" });
      await plain.wake(bob2.id);
      await settle();
      assert.deepEqual(w.turns.map(t => t.texts), base.turns.map(t => t.texts));
      assert.deepEqual(w.turns.flatMap(t => t.texts), ["first", "second"], "nothing lost, nothing reordered");
    } finally {
      base.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test("pausing stops the turn in flight and only this agent's running background jobs, with a receipt; resuming tells it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-pause-svc-"));
  try {
    const transcript = join(root, "conversation.jsonl");
    writeFileSync(transcript, `{"text":"Started as job-aaaaaaaaaaaaaaaa (pid 1)."}\n{"text":"Started as job-bbbbbbbbbbbbbbbb (pid 2)."}\n`);
    assert.deepEqual(jobsNamedIn(transcript), ["job-aaaaaaaaaaaaaaaa", "job-bbbbbbbbbbbbbbbb"]);
    const killed: string[] = [], receipts: string[] = [], told: string[] = [], interrupted: string[][] = [];
    const pauses = new AgentPauses({
      dirFor: () => root,
      wake: () => {},
      interrupt: ids => { interrupted.push(ids); return ids; },
      box: () => ({ jobs: async () => ({ jobs: [{ job_id: "job-aaaaaaaaaaaaaaaa", running: true }, { job_id: "job-bbbbbbbbbbbbbbbb", running: false }, { job_id: "job-cccccccccccccccc", running: true }, { job_id: "job-dddddddd", running: true, owner: "agent:bob" }] }), killJob: async id => { killed.push(id); } }),
      tell: async (_id, text) => { told.push(text); },
      receipt: (subject, decision) => receipts.push(`${subject} ${decision}`),
      log: () => {},
      now: () => new Date("2026-11-04T00:10:00Z"),
    });
    const done = await pauses.pause("bob", "Chris", "probing the host");
    assert.deepEqual([done.turnStopped, done.jobsStopped], [true, ["job-aaaaaaaaaaaaaaaa", "job-dddddddd"]], "its running jobs only — named in its record or owned by it (INV-1557); not an ended one, not someone else's");
    assert.deepEqual(killed, ["job-aaaaaaaaaaaaaaaa", "job-dddddddd"]);
    assert.equal(readPause(root)?.reason, "probing the host");
    assert.equal(await pauses.resume("bob", "Chris"), true);
    assert.equal(readPause(root), undefined);
    assert.match(told[0] ?? "", /Chris resumed you.*Chris had paused you \(probing the host\)/);
    assert.deepEqual(receipts, ["agent:bob paused", "agent:bob resumed"]);
    assert.equal(await pauses.resume("bob", "Chris"), false, "resuming what is not paused does nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command that outlived its foreground time and went on as a job is one of the agent's jobs too (INV-1555)", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-pause-adopted-"));
  try {
    const transcript = join(root, "conversation.jsonl");
    const note = stillRunningNote({ job_id: "job-d96823f1", pid: 127761, log_path: "/home/box/work/.jobs/job-d96823f1.log" } as never, 120_000);
    writeFileSync(transcript, `${JSON.stringify({ text: note })}\n{"text":"Started as job-aaaaaaaaaaaaaaaa (pid 1)."}\n`);
    assert.deepEqual(jobsNamedIn(transcript).sort(), ["job-aaaaaaaaaaaaaaaa", "job-d96823f1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
