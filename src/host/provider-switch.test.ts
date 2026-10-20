/**
 * Switching the default model without a restart (INV-1268).
 *
 * The property that matters: a turn is one model from its first round to its last. A swap that
 * lands while a turn is inside a tool call must not reach that turn's next round — the messages of
 * one turn written by two models is the bug the restart used to prevent — while the next turn,
 * and the housekeeping calls, take the new one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { resolveProvider } from "./provider.ts";
import { fakeModel } from "./testing/fake-model.ts";

const reply = (content: unknown[], stop: "end_turn" | "tool_use"): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as Anthropic.Message;

test("a running turn keeps the model it started with; the next turn and the housekeeping calls take the new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-switch-"));
  const saved = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = dir;
  try {
    const registry = new AgentRegistry(join(dir, "agents"));
    const ada = registry.create({ name: "Ada" });
    // A label no cheaper-model table knows, so the summary pair is the primary model itself.
    const old = { ...resolveProvider("anthropic"), label: "Fake", model: "model-old" };
    const fresh = { ...resolveProvider("anthropic"), label: "Fake", model: "model-new" };
    const capture = { params: [] as Anthropic.MessageCreateParams[] };
    let calls = 0;
    let orchestrator: Orchestrator;
    const client = fakeModel(
      () => {
        calls += 1;
        if (calls === 1) {
          // Mid-turn: the setting is saved while the model is between rounds.
          orchestrator.setDefaultProvider(fresh, client);
          return reply([{ type: "tool_use", id: "t1", name: "SetTodos", input: { todos: [{ text: "look", status: "doing" }] } }], "tool_use");
        }
        return reply([{ type: "text", text: "done", citations: null }], "end_turn");
      },
      { capture, create: ({ params }) => reply([{ type: "text", text: `asked ${params.model}`, citations: null }], "end_turn") }
    );
    orchestrator = new Orchestrator({ registry, provider: old, client, useBox: false, inbox: null, turns: null });

    await orchestrator.prompt(ada.id, "start");
    const models = capture.params.map(p => p.model);
    assert.deepEqual(models, ["model-old", "model-old"], "both rounds of the turn that saw the swap ran on the old model");
    assert.equal(orchestrator.provider.model, "model-new");

    await orchestrator.prompt(ada.id, "again");
    assert.equal(capture.params[capture.params.length - 1]?.model, "model-new", "the next turn runs on the new model");

    // The housekeeping path (steward / handoff) reads the default per call.
    const asked = await orchestrator.askBounded(ada.id, { system: "s", prompt: "p", maxTokens: 10, timeoutMs: 1000, kind: "steward" });
    assert.match(asked?.text ?? "", /asked model-new/);

    const rows = orchestrator.usage.since(0, 100);
    const sw = rows.find(row => row.kind === "switch");
    assert.ok(sw, "the swap is a row in the ledger");
    assert.equal(sw.model, "model-new");
    assert.match(sw.reason ?? "", /model-old/);
    assert.equal(sw.inputTokens + sw.outputTokens, 0);
    assert.ok(rows.some(row => row.kind === "turn" && row.model === "model-old"));
    assert.ok(rows.some(row => row.kind === "turn" && row.model === "model-new"));
  } finally {
    if (saved === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = saved;
  }
});
