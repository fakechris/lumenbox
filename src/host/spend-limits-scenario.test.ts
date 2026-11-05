/**
 * The 2026-11-04 shape, as an episode (INV-1615): an agent that spends the same each round and
 * never stops on its own. At its daily line the turn hands back, the agent is paused — the durable
 * pause the bus honours — the admins hear once, and the next local day it is resumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readPause, writePause, clearPause } from "../agents/pause.ts";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { runEpisode } from "./scenario.ts";
import { SpendLimits } from "./spend-limits.ts";

test("fixed spend per round: paused at the daily line with one admin notice, no turn starts meanwhile, resumed the next day", async () => {
  // The scripted model bills 10 input + 5 output tokens a round; at 100,000 per million input that is 1.00 a round.
  const rates = { scenario: { inputPerM: 100_000, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 } };
  const clock = { now: new Date(2026, 10, 4, 9, 0, 0) };
  let registry: AgentRegistry | undefined;
  let bus: AgentBus | undefined;
  const notices: string[] = [];
  const resumed: string[] = [];
  const limits = new SpendLimits({
    ledger: () => [],
    rates: () => rates,
    pause: async (id, reason) => { writePause(registry!.dirFor(id), { by: "LumenBox (spend limit)", at: clock.now.toISOString(), reason }); },
    // What AgentPauses.resume does: clear the record, then wake the queue.
    resume: async (id, by) => { clearPause(registry!.dirFor(id)); resumed.push(`${id} by ${by}`); void bus!.wake(id); },
    isPaused: id => readPause(registry!.dirFor(id)) !== undefined,
    notify: text => notices.push(text),
    nameOf: id => registry?.tryGet(id)?.profile.name ?? id,
    log: () => {},
    now: () => clock.now,
  });
  let calls = 0;
  const episode = await runEpisode({
    team: [{ name: "Vic" }],
    says: [],
    spendLimits: limits,
    // Named, so the usage row carries a model the rates can price; without a provider the row says "unknown".
    provider: { label: "test", model: "scenario", effort: false } as never,
    // A model that would run forever: every call is one more command.
    script: () => { calls += 1; return { call: "bash", input: { command: `echo step ${calls}` } }; },
    drive: async ({ bus: episodeBus, registry: reg, frontId, say }) => {
      registry = reg; bus = episodeBus;
      limits.setLimits(frontId, { perDay: 3, perWake: 100 });
      await say("audit everything, keep going");
      const afterFirst = calls;
      assert.ok(readPause(reg.dirFor(frontId)) !== undefined, "paused at the daily line");
      assert.match(readPause(reg.dirFor(frontId))!.reason, /spend limit: 3\.00 of 3\.00 reached on 2026-11-04/);
      // Paused: a second message queues and opens no turn.
      episodeBus.sendFromUser(frontId, "and this too");
      void episodeBus.wake(frontId);
      await new Promise(resolve => setTimeout(resolve, 200)); // idle() waits for an empty queue, and a paused agent's queue stays full on purpose
      assert.equal(episodeBus.pendingCount(frontId), 1, "the message waits in the queue");
      assert.equal(calls, afterFirst, "no model call while paused");
      // The next local day: the sweep resumes it and the queued message runs — until the line again.
      clock.now = new Date(2026, 10, 5, 0, 1, 0);
      assert.deepEqual(await limits.sweep(), [frontId]);
      await episodeBus.idle();
      assert.ok(calls > afterFirst, "woken after the resume");
    },
  });
  try {
    assert.equal(notices.length, 2, "one notice per day paused");
    assert.match(notices[0]!, /Vic reached its daily spend line \(3\.00 of 3\.00\) and is paused until tomorrow/);
    assert.equal(resumed.length, 1);
    assert.match(resumed[0]!, /LumenBox \(spend limit\): a new day/);
    const transcript = episode.registry.readTranscript(episode.registry.list()[0]!.id, "main") as { role: string; text?: string }[];
    const handBack = transcript.filter(entry => entry.role === "assistant" && /daily spend line/.test(entry.text ?? ""));
    assert.equal(handBack.length, 2, "the hand-back is said in the conversation before the pause, each day");
    // Three rounds a day: 1.00, 2.00 (reminded at 80%), 3.00 (the line).
    assert.equal(calls, 6);
  } finally {
    episode.cleanup();
  }
});
