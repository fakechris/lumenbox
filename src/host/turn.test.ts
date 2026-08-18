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
import { DisplayLease } from "../box/display-lease.ts";
import { runTurn, TurnAborted } from "./turn.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { buildTools, dispatchTool } from "./tools.ts";

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

    // Two blocks, split at the stability boundary, each with its own breakpoint:
    // writing a memory must not re-process the invariant prompt and the tools.
    const system = params.system as Anthropic.TextBlockParam[];
    assert.equal(system.length, 2, "stable and volatile tiers are separate blocks");
    assert.equal(system[0]!.cache_control?.type, "ephemeral");
    assert.equal(system[1]!.cache_control?.type, "ephemeral");
    assert.match(system[0]!.text, /Your name is Ada/, "identity is in the stable tier");
    assert.match(system[1]!.text, /memory/i, "memory is in the volatile tier");
    assert.doesNotMatch(
      system[0]!.text,
      /Teammates you can message|memory file is empty/,
      "nothing the agent rewrites belongs in the cached prefix"
    );

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

test("a second agent is refused the display while another holds it", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const display = new DisplayLease();

    // Ada is mid-task with the desktop.
    assert.equal(display.acquire(ada.id), true);

    const outcome = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: bob, registry, bus, box, display }
    );

    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /Ada is using the box's desktop/);
    assert.match(outcome.text, /bash/, "it points at work that does not need the screen");
    assert.equal(calls.length, 0, "the box must not be touched at all");
  } finally {
    cleanup();
  }
});

test("a turn releases the display even when it throws", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const display = new DisplayLease();
    const capture: Capture = { params: [] };

    // First round takes the display, then the stream fails on the next round.
    let call = 0;
    const client = {
      messages: {
        stream(params: Anthropic.MessageCreateParams) {
          capture.params.push({ ...params, messages: [...params.messages] });
          call++;
          return {
            on() {
              return this;
            },
            finalMessage: async () => {
              if (call === 1) {
                return message(
                  [toolUseBlock("computer", { actions: [{ action: "screenshot" }] })],
                  "tool_use"
                );
              }
              throw new Error("stream exploded");
            },
          };
        },
      },
    } as unknown as Anthropic;

    await assert.rejects(
      runTurn(
        ada,
        [{ fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box, display, resolution: undefined }
      ),
      /stream exploded/
    );

    assert.equal(
      display.heldBy(),
      undefined,
      "a leaked lease would lock every other agent out of the screen for good"
    );
  } finally {
    cleanup();
  }
});

test("the transcript records what tools a turn actually ran", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    const { client } = stubClient(
      [
        message(
          [toolUseBlock("bash", { command: "mkdir -p /home/box/work" })],
          "tool_use"
        ),
        message([textBlock("Done — created the directory.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "make a dir", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as any[];

    // The call must be stored as a real tool_use block, not as prose. Prose the
    // model can read is prose the model can forge: an earlier version recorded a
    // "[tools used this turn]" line and the model simply wrote one itself, with an
    // invented success message, and called nothing.
    const call = transcript.find(e => e.kind === "blocks");
    assert.ok(call, "the calling turn must be recorded as blocks");
    const toolUse = call.blocks.find((b: any) => b.type === "tool_use");
    assert.ok(toolUse, "a tool_use block must be present");
    assert.equal(toolUse.name, "bash");
    assert.equal(toolUse.input.command, "mkdir -p /home/box/work");

    // The result must immediately follow it, or the API rejects the pair.
    const resultIndex = transcript.indexOf(call) + 1;
    const results = transcript[resultIndex];
    assert.equal(results.kind, "results");
    assert.equal(results.role, "user");
    assert.equal(results.blocks[0].type, "tool_result");
    assert.equal(results.blocks[0].tool_use_id, toolUse.id);
    assert.match(results.blocks[0].content[0].text, /exit code: 0/);

    // And the work must precede the claim about it.
    const claimIndex = transcript.findIndex(e => /Done — created/.test(e.text ?? ""));
    assert.ok(transcript.indexOf(call) < claimIndex, "work comes before the claim");
  } finally {
    cleanup();
  }
});

test("a failed tool is recorded as an error, not as work done", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    // No box, so the computer tool is unavailable and dispatch reports an error.
    const { client } = stubClient(
      [
        message([toolUseBlock("computer", { actions: [{ action: "screenshot" }] })], "tool_use"),
        message([textBlock("I could not look.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as any[];
    const results = transcript.find(e => e.kind === "results");

    assert.ok(results, "the failed call must still be recorded");
    assert.equal(results.blocks[0].is_error, true, "a failure must not read as success");
    assert.match(results.blocks[0].content[0].text, /box is not running/);
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
