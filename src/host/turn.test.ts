/**
 * Integration tests for the turn loop, with the model and the box stubbed.
 *
 * These cover the wiring that would otherwise only break at runtime against a
 * real API: that a tool_use block actually reaches `dispatchTool`, that a
 * screenshot comes back as an image content block the model can see, that
 * SendToAgent genuinely wakes the other agent, and that an abort mid-turn is
 * surfaced as TurnAborted rather than a half-written transcript.
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
import { runTurn, TurnAborted } from "./turn.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { buildTools } from "./tools.ts";

interface Capture {
  params: Anthropic.MessageCreateParams[];
}

/**
 * A stand-in for the SDK client that replays canned messages and records the
 * request it was given, so assertions can inspect the assembled prompt.
 */
function stubClient(
  replies: Anthropic.Message[],
  capture: Capture
): { client: Anthropic; capture: Capture } {
  let index = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        // Snapshot the messages array: the turn loop keeps appending to the same
        // array across rounds, so holding the reference would make every captured
        // request look identical to the last one.
        capture.params.push({ ...params, messages: [...params.messages] });
        const reply = replies[Math.min(index++, replies.length - 1)]!;
        return {
          on(event: string, handler: (delta: string) => void) {
            if (event === "text") {
              for (const block of reply.content) {
                if (block.type === "text") handler(block.text);
              }
            }
            return this;
          },
          finalMessage: async () => reply,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, capture };
}

function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"] = "end_turn"
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null } as Anthropic.ContentBlock;
}

function toolUseBlock(
  name: string,
  input: unknown,
  id = "toolu_1"
): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ContentBlock;
}

/** A box that records calls and returns a recognizable fake screenshot. */
function stubBox() {
  const calls: { kind: string; detail: unknown }[] = [];
  const box = {
    computer: async (actions: unknown) => {
      calls.push({ kind: "computer", detail: actions });
      return {
        success: true,
        screenshot: Buffer.from("fake-webp-bytes").toString("base64"),
        action_count: Array.isArray(actions) ? actions.length : 0,
        duration_ms: 42,
        cursor_position: { x: 12, y: 34 },
      };
    },
    exec: async (command: string) => {
      calls.push({ kind: "exec", detail: command });
      return { stdout: "hello from the box", stderr: "", exit_code: 0, timed_out: false };
    },
  } as unknown as BoxClient;
  return { box, calls };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-turn-"));
  const registry = new AgentRegistry(root);
  return { registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("system prompt carries the agent's identity and its teammates", () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada", description: "coordinates" });
    const bob = registry.create({ name: "Bob", description: "reviews releases" });

    const prompt = buildSystemPrompt({
      agent: ada,
      teammates: registry.list(),
      memory: "",
      resolution: { display: { width: 1920, height: 1200 }, api: { width: 1280, height: 800 } },
      agentsRoot: registry.root,
      hasBox: true,
    });

    assert.match(prompt, /Your name is Ada/);
    assert.match(prompt, new RegExp(`Bob \\(id: ${bob.id}\\)`), "teammate is listed by id");
    assert.match(prompt, /reviews releases/, "teammate description is included");
    assert.doesNotMatch(
      prompt,
      new RegExp(`Ada \\(id: ${ada.id}\\)`),
      "an agent must not be listed as its own teammate"
    );
    assert.match(prompt, /1280x800/, "the model is told its coordinate space");
  } finally {
    cleanup();
  }
});

test("system prompt says the box is unavailable when there is none", () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const prompt = buildSystemPrompt({
      agent: ada,
      teammates: [ada],
      memory: "",
      resolution: undefined,
      agentsRoot: registry.root,
      hasBox: false,
    });
    assert.match(prompt, /box is not running/);
    assert.match(prompt, /agentbox box up/, "the prompt tells it how to be fixed");
  } finally {
    cleanup();
  }
});

test("tool set shrinks to messaging-only without a box", () => {
  const withBox = buildTools(true).map(tool => tool.name);
  const withoutBox = buildTools(false).map(tool => tool.name);

  assert.ok(withBox.includes("computer"));
  assert.ok(withBox.includes("bash"));
  assert.ok(!withoutBox.includes("computer"), "no computer tool without a box");
  assert.ok(!withoutBox.includes("bash"), "no shell without a box");
  // Messaging never depends on the box.
  for (const name of ["SendToAgent", "CreateAgent", "UpdateAgent", "RememberFact"]) {
    assert.ok(withoutBox.includes(name), `${name} must still be available`);
  }
});

test("a turn caches the system prompt and sends the tool set", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("done")])], capture);

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const params = capture.params[0]!;
    assert.equal(params.model, "claude-opus-5");
    // One breakpoint at the end of the system prompt covers tools + system.
    const system = params.system as Anthropic.TextBlockParam[];
    assert.equal(system.at(-1)?.cache_control?.type, "ephemeral");
    assert.ok((params.tools?.length ?? 0) > 0, "tools are declared");
    assert.deepEqual(params.thinking, { type: "adaptive", display: "summarized" });
  } finally {
    cleanup();
  }
});

test("a computer tool_use reaches the box and returns a screenshot image block", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const capture: Capture = { params: [] };

    const { client } = stubClient(
      [
        message(
          [toolUseBlock("computer", { actions: [{ action: "screenshot" }] })],
          "tool_use"
        ),
        message([textBlock("I can see the screen.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box,
        resolution: {
          display: { width: 1280, height: 800 },
          api: { width: 1280, height: 800 },
        },
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, "computer");

    // The second request must carry the tool result, with the screenshot as an
    // image block — text alone would leave the model blind.
    const second = capture.params[1]!;
    const lastMessage = second.messages.at(-1)!;
    const blocks = lastMessage.content as Anthropic.ContentBlockParam[];
    const result = blocks[0] as Anthropic.ToolResultBlockParam;

    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "toolu_1");
    const parts = result.content as Anthropic.ContentBlockParam[];
    assert.equal(parts[0]!.type, "text");
    assert.equal(parts[1]!.type, "image", "the screenshot must ride back as an image");
    const image = parts[1] as Anthropic.ImageBlockParam;
    assert.equal((image.source as { media_type: string }).media_type, "image/webp");
  } finally {
    cleanup();
  }
});

test("SendToAgent from a turn actually wakes the other agent", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    const woken: string[] = [];
    const bus = new AgentBus(registry, async (agent, inbound) => {
      woken.push(`${agent.profile.name}:${inbound.map(m => m.text).join("|")}`);
    });

    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        message(
          [toolUseBlock("SendToAgent", { target_id: bob.id, message: "please review" })],
          "tool_use"
        ),
        message([textBlock("Asked Bob.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "get Bob on it", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    await bus.idle();
    assert.deepEqual(woken, ["Bob:please review"]);

    // The acknowledgement the model receives must tell it not to wait.
    const second = capture.params[1]!;
    const blocks = second.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    const result = blocks[0] as Anthropic.ToolResultBlockParam;
    const text = (result.content as Anthropic.TextBlockParam[])[0]!.text;
    assert.match(text, /Sent to Bob/);
    assert.match(text, /asynchronous/i);
  } finally {
    cleanup();
  }
});

test("a tool that throws is reported to the model, not the caller", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    // No box, so the computer tool is unavailable and dispatch throws.
    const { client } = stubClient(
      [
        message([toolUseBlock("computer", { actions: [{ action: "screenshot" }] })], "tool_use"),
        message([textBlock("Told the user.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const blocks = capture.params[1]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    const result = blocks[0] as Anthropic.ToolResultBlockParam;
    assert.equal(result.is_error, true);
    const text = (result.content as Anthropic.TextBlockParam[])[0]!.text;
    assert.match(text, /box is not running/);
  } finally {
    cleanup();
  }
});

test("an already-aborted signal stops the turn before calling the model", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("never sent")])], capture);

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runTurn(
        ada,
        [{ fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
        controller.signal,
        { client, registry, bus, box: undefined, resolution: undefined }
      ),
      (error: unknown) => error instanceof TurnAborted
    );
    assert.equal(capture.params.length, 0, "no request should have been made");
  } finally {
    cleanup();
  }
});

test("the turn records both sides in the transcript", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("Hello back.")])], capture);

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "Hello", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as { role: string; text: string }[];
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]!.role, "user");
    assert.match(transcript[0]!.text, /Hello/);
    assert.equal(transcript[1]!.role, "assistant");
    assert.equal(transcript[1]!.text, "Hello back.");
  } finally {
    cleanup();
  }
});

test("a peer wake is presented differently from a user message", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("ok")])], capture);

    await runTurn(
      ada,
      [
        {
          fromId: bob.id,
          fromName: "Bob",
          text: "the build is green",
          priority: true,
          receivedAt: "",
        },
      ],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const turnText = capture.params[0]!.messages.at(-1)!.content as string;
    assert.match(turnText, /\[agent\]/, "the wake cue marks it as a peer message");
    assert.match(turnText, /Bob/);
    assert.match(turnText, /priority/i);
    assert.match(turnText, /not the user typing/i);
  } finally {
    cleanup();
  }
});
