/**
 * This machine's web token never reaches the model or the transcript through a tool result (INV-1543).
 *
 * A box agent decrypted the box browser's cookie for the host UI and got the token; from then on
 * every command that printed it sent it to the model provider and into the record — 1,385 times in
 * one agent's transcript. The token is replaced by its name before either sees the result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import type { BoxClient } from "../box/client.ts";
import { fakeModelReplying } from "./testing/fake-model.ts";
import { runTurn } from "./turn.ts";

const TOKEN = "6c1d0e4f9a7b2c3d8e5f6a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d";

const reply = (content: unknown[], stop: string) =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as Anthropic.Message;

test("a tool result that prints the host UI token reaches the model and the record with the token named, not shown", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-host-token-"));
  process.env.AGENTBOX_HOME = root;
  process.env.AGENTBOX_UI_TOKEN = TOKEN;
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada" });
    const box = {
      exec: async () => ({ stdout: `cookie agentbox_ui=${TOKEN}\nurl http://host.docker.internal:7777/?token=${TOKEN}`, stderr: "", exit_code: 0, timed_out: false }),
    } as unknown as BoxClient;
    const capture = { params: [] as Anthropic.MessageCreateParams[] };
    const client = fakeModelReplying([
      reply([{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "python3 decrypt_cookies.py" } }], "tool_use"),
      reply([{ type: "text", text: "Read it.", citations: null }], "end_turn"),
    ], { capture, streamText: true });
    const events: unknown[] = [];
    await runTurn(ada, [{ id: "m1", fromId: "user", fromName: "user", text: "read the board", priority: false, receivedAt: "" }], new AbortController().signal, { client, registry, bus: new AgentBus(registry, async () => {}), box, resolution: undefined, onEvent: event => events.push(event) });
    assert.ok(!JSON.stringify(events).includes(TOKEN), "nor the stream: the tool's summary line printed it first");

    const sentAfterTool = JSON.stringify(capture.params[1]);
    assert.ok(sentAfterTool.includes("agentbox_ui="), "the result itself still reaches the model");
    assert.ok(!sentAfterTool.includes(TOKEN), "but not the token");
    assert.match(sentAfterTool, /\[vault:LUMENBOX_UI_TOKEN\]/, "it is named in its place");
    assert.ok(!JSON.stringify(registry.readTranscript(ada.id)).includes(TOKEN), "nor does the record keep it");
  } finally {
    delete process.env.AGENTBOX_UI_TOKEN;
    delete process.env.AGENTBOX_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a token the web was given by flag or generated at start is held like the file's", async () => {
  const { holdHostToken, hostTokens } = await import("../config.ts");
  const flagged = "flag-token-00112233445566778899aabbccddeeff";
  holdHostToken(flagged);
  assert.ok([...hostTokens({ AGENTBOX_TEST: "1" }).values()].includes(flagged));
});
