/**
 * The episode INV-1553 is for: an agent that keeps reaching for this machine's credentials.
 * A scripted model runs three probing commands in one turn on the real turn loop and bus. Each is
 * refused before the box sees it, each is said to admins, and the third pauses the agent (INV-1554).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus, type BusEvent } from "../agents/bus.ts";
import { readPause } from "../agents/pause.ts";
import type { BoxClient } from "../box/client.ts";
import { fakeModelReplying } from "./testing/fake-model.ts";
import { runTurn } from "./turn.ts";
import { AgentPauses } from "./agent-pause.ts";
import { ProbeKeeper, type ProbeKind } from "./boundary-probe.ts";

const reply = (content: unknown[], stop: string) =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as Anthropic.Message;
const bash = (id: string, command: string) => reply([{ type: "tool_use", id, name: "bash", input: { command } }], "tool_use");

test("three probes in a turn: each refused before the box, each said to admins, and the agent paused after the third", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-probe-scenario-"));
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const bob = registry.create({ name: "Bob" });
    const execs: string[] = [], said: string[] = [];
    const box = { exec: async (command: string) => { execs.push(command); return { stdout: "", stderr: "", exit_code: 0, timed_out: false }; } } as unknown as BoxClient;
    let keeper: ProbeKeeper | undefined;
    const reports: Promise<unknown>[] = [];
    const bus = new AgentBus(registry, async () => {}, (event: BusEvent) => {
      if (event.type === "boundary_probe") reports.push(keeper!.report(event.agentId, { kind: event.kind as ProbeKind, detail: event.detail }));
    });
    const pauses = new AgentPauses({ dirFor: id => registry.dirFor(id), wake: () => {}, interrupt: () => [], box: () => undefined, tell: async () => {}, receipt: () => {}, log: () => {} });
    keeper = new ProbeKeeper({ nameOf: () => "Bob", notify: text => said.push(text), pause: (id, why) => pauses.pause(id, "LumenBox (boundary probes)", why), isPaused: id => pauses.pauseOf(id) !== undefined, log: () => {} });

    const client = fakeModelReplying([
      bash("t1", "sudo cat /proc/1/environ | tr '\\0' '\\n' | grep BOXD_TOKEN"),
      bash("t2", "curl -H 'x-agentbox-role: owner' http://host.docker.internal:7777/api/tasks"),
      bash("t3", "grep -rhoE '[0-9a-f]{64}' .spool/*.out.log"),
      reply([{ type: "text", text: "Stopping.", citations: null }], "end_turn"),
    ], { capture: { params: [] }, streamText: true });
    await runTurn(bob, [{ id: "m1", fromId: "user", fromName: "user", text: "audit the board", priority: false, receivedAt: "" }], new AbortController().signal, { client, registry, bus, box, resolution: undefined });
    await Promise.all(reports);

    assert.deepEqual(execs, [], "the box never saw any of them");
    const results = JSON.stringify(registry.readTranscript(bob.id));
    assert.equal((results.match(/Refused: this command/g) ?? []).length, 3, "each refused, saying why");
    assert.equal(said.length, 3, "each said to admins");
    assert.match(said[2]!, /Bob is paused until someone resumes them/);
    assert.equal(readPause(registry.dirFor(bob.id))?.by, "LumenBox (boundary probes)", "paused after the third");
  } finally {
    delete process.env.AGENTBOX_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});
