/**
 * Run now and a due window start a real turn, or say why not (INV-2036). The failure this exists for:
 * a routine whose agent had an earlier request waiting in the same chat showed "Done, 0 seconds,
 * 0 tokens" every minute while nothing ran, and its message sat queued for whenever the chat freed up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPause, writePause } from "../agents/pause.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { heartbeatSlug, standingDir } from "./standing.ts";
import { fakeModel } from "./testing/fake-model.ts";

const person = (id: string) => ({ id, fromId: "user", fromName: "Chris", principalId: "chris", text: "Install the package", priority: false, receivedAt: new Date().toISOString() });

async function finished(host: Orchestrator, slug: string) {
  for (let i = 0; i < 200 && host.scheduler.runs(slug)[0]?.outcome === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await host.settle();
  return host.scheduler.runs(slug)[0];
}

test("an auto routine's Run now is a real turn; with the chat held it is refused, skipped or failed with why, never a 0-second Done (INV-2036)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routine-start-")), previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = dir;
  try {
    const registry = new AgentRegistry(join(dir, "agents")), mia = registry.create({ name: "Mia" });
    mkdirSync(standingDir(registry.dirFor(mia.id)), { recursive: true });
    writeFileSync(join(standingDir(registry.dirFor(mia.id)), "HEARTBEAT.md"), "- [ ] Check the queue\n");
    let calls = 0;
    const host = new Orchestrator({
      registry, useBox: false, inbox: null, mcp: null, hooks: null, extensions: null,
      client: fakeModel(() => { calls++; return { id: "r", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "Queue checked." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 2 } } as never; }),
    });
    const slug = heartbeatSlug(mia.id);

    assert.deepEqual(await host.scheduler.runNow(slug), { ok: true });
    const ran = await finished(host, slug);
    assert.equal(calls, 1, "the click started a turn");
    assert.equal(ran?.outcome, "done");
    assert.equal(host.turns?.endedSince(mia.id, 0).length, 1, "and the turn is on the record the run's result is read from");

    // An earlier request of the person's is waiting in that chat: nothing else is let in until it is answered.
    const focus = host.bus.workAttention!, work = focus.begin(mia.id, "main", [person("request")])!;
    focus.settle(work, "waiting", "waiting for confirmation");
    const refused = await host.scheduler.runNow(slug);
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.reason : "", /did not run: Mia is waiting on an earlier request in this chat \(waiting for confirmation\)/);
    await host.scheduler.tick();
    assert.equal(host.scheduler.runs(slug)[0]?.outcome, "skipped", "a due window is skipped and says so");
    assert.match(host.scheduler.runs(slug)[0]?.reason ?? "", /waiting on an earlier request/);
    assert.ok(host.scheduler.runs(slug)[0]?.agent !== undefined, "and names whose chat, so the list shows it only to who may read that agent");
    assert.equal(host.scheduler.holds.holdOf(slug), undefined, "and is not held: the next window runs once the chat is free");

    // Slipped past the check (the chat is busy, not yet waiting): the message is not let in, so the run fails with why and is taken back.
    focus.settle(work, "running");
    assert.deepEqual(await host.scheduler.runNow(slug), { ok: true });
    const unstarted = await finished(host, slug);
    assert.equal(unstarted?.outcome, "failed");
    assert.match(unstarted?.reason ?? "", /its turn did not start: Mia did not take it up \(busy with other work in this chat\)/);
    focus.settle(work, "answered");
    writePause(registry.dirFor(mia.id), { by: "chris", at: new Date().toISOString(), reason: "on leave" });
    const paused = await host.scheduler.runNow(slug);
    assert.match(!paused.ok ? paused.reason : "", /did not run: Mia is paused; resume them/, "a paused member is refused at the click, not a run that waits for a resume");
    clearPause(registry.dirFor(mia.id));
    await host.prompt(mia.id, "thanks");
    assert.equal(calls, 2, "the person's next message is the only turn: the routine did not run late behind it");
    host.scheduler.stop();
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
