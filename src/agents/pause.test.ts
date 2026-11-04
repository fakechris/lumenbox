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

const tick = () => new Promise(resolve => setImmediate(resolve));
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
      transcriptPath: () => transcript,
      interrupt: ids => { interrupted.push(ids); return ids; },
      box: () => ({ jobs: async () => ({ jobs: [{ job_id: "job-aaaaaaaaaaaaaaaa", running: true }, { job_id: "job-bbbbbbbbbbbbbbbb", running: false }, { job_id: "job-cccccccccccccccc", running: true }] }), killJob: async id => { killed.push(id); } }),
      tell: async (_id, text) => { told.push(text); },
      receipt: (subject, decision) => receipts.push(`${subject} ${decision}`),
      log: () => {},
      now: () => new Date("2026-11-04T00:10:00Z"),
    });
    const done = await pauses.pause("bob", "Chris", "probing the host");
    assert.deepEqual([done.turnStopped, done.jobsStopped], [true, ["job-aaaaaaaaaaaaaaaa"]], "its running job only — not an ended one, not someone else's");
    assert.deepEqual(killed, ["job-aaaaaaaaaaaaaaaa"]);
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
