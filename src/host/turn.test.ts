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
import { TurnLedger } from "./resume.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { fakeModel, fakeModelReplying } from "./testing/fake-model.ts";
import { HookRunner } from "./hooks.ts";
import type { BoxClient } from "../box/client.ts";
import { DisplayLease } from "../box/display-lease.ts";
import {
  isTruncatedByContext,
  runTurn,
  storableResult,
  TurnAborted,
  type TranscriptEntry,
} from "./turn.ts";
import {
  compactionUrgency,
  DEFAULT_POLICY,
  estimateTokens,
  type HistoryEntry,
} from "./compaction.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PolicyGate, type PolicyLimits } from "./policy.ts";
import { UsageLog } from "./usage.ts";
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
  return { client: fakeModelReplying(replies, { capture, streamText: true }), capture };
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
    downloadFile: async (path: string) => {
      calls.push({ kind: "download", detail: path });
      return { path, base64: "ZmFrZS1wbmctYnl0ZXM=" };
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
      memory: [],
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
      memory: [],
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "get Bob on it", priority: false, receivedAt: "" }],
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
    assert.match(text, /queued for Bob/);
    assert.match(text, /You will hear again only if they reply/);
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
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
        [{ id: "m-test", fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "Hello", priority: false, receivedAt: "" }],
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

test("Recall reads both tiers, so a team-scoped write is findable without naming the tier", async () => {
  // The measured failure (2026-09-01): an agent wrote a fact with scope "team",
  // recalled without `shared: true`, found nothing in its own tier, concluded the
  // write was lost, and went hunting for memory files inside the box.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    registry.appendSharedMemory(ada.id, [
      { at: "2026-09-01T00:14:00.000Z", kind: "fact", text: "全部服务迁到了 Alwyzon,不是 Hetzner" } as never,
    ]);
    registry.appendMemoryRecords(ada.id, [
      { at: "2026-09-01T00:15:00.000Z", kind: "fact", text: "own-tier note about Alwyzon dns" } as never,
    ]);

    const both = await dispatchTool("Recall", { search: "Alwyzon" }, { agent: ada, registry, bus, box });
    assert.match(both.text, /\[team\].*迁到了 Alwyzon/, "the team-tier fact surfaces by default");
    assert.match(both.text, /\[yours\].*own-tier note/, "alongside the agent's own tier");

    const teamOnly = await dispatchTool(
      "Recall",
      { search: "Alwyzon", shared: true },
      { agent: ada, registry, bus, box }
    );
    assert.doesNotMatch(teamOnly.text, /own-tier note/, "shared: true still narrows to the team");
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

    // Ada is mid-task with the desktop both are pointed at (neither has a
    // displayIndex here, so both land on the fallback screen — the shared case).
    assert.equal(display.acquire(1, ada.id), true);

    const outcome = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: bob, registry, bus, box, display }
    );

    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /Ada is using this desktop/);
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
    const client = fakeModel(
      ({ index }) => {
        if (index === 0) {
          return message(
            [toolUseBlock("computer", { actions: [{ action: "screenshot" }] })],
            "tool_use"
          );
        }
        throw new Error("stream exploded");
      },
      { capture }
    );

    await assert.rejects(
      runTurn(
        ada,
        [{ id: "m-test", fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box, display, resolution: undefined }
      ),
      /stream exploded/
    );

    assert.equal(
      display.heldBy(1),
      undefined,
      "a leaked lease would lock this screen's next claimant out for good"
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "make a dir", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];

    // The call must be stored as a real tool_use block, not as prose. Prose the
    // model can read is prose the model can forge: an earlier version recorded a
    // "[tools used this turn]" line and the model simply wrote one itself, with an
    // invented success message, and called nothing.
    const call = transcript.find(entry => "kind" in entry && entry.kind === "blocks");
    assert.ok(call && "blocks" in call, "the calling turn must be recorded as blocks");
    const toolUse = call.blocks.find(block => block.type === "tool_use");
    assert.ok(toolUse, "a tool_use block must be present");
    assert.equal(toolUse.name, "bash");
    assert.equal((toolUse.input as { command: string }).command, "mkdir -p /home/box/work");

    // The result must immediately follow it, or the API rejects the pair.
    const resultIndex = transcript.indexOf(call) + 1;
    const results = transcript[resultIndex];
    assert.ok(results && "blocks" in results, "a results entry must follow the call");
    assert.equal(results.role, "user");
    const resultBlock = results.blocks[0] as Anthropic.ToolResultBlockParam;
    assert.equal(resultBlock.type, "tool_result");
    assert.equal(resultBlock.tool_use_id, toolUse.id);
    const resultParts = resultBlock.content as Anthropic.TextBlockParam[];
    assert.match(resultParts[0]!.text, /exit code: 0/);

    // And the work must precede the claim about it.
    const claimIndex = transcript.findIndex(
      entry => !("kind" in entry) && /Done — created/.test(entry.text)
    );
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
      [{ id: "m-test", fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const results = transcript.find(
      entry => "kind" in entry && entry.kind === "results"
    );

    assert.ok(results && "blocks" in results, "the failed call must still be recorded");
    const block = results.blocks[0] as Anthropic.ToolResultBlockParam;
    assert.equal(block.is_error, true, "a failure must not read as success");
    const parts = block.content as Anthropic.TextBlockParam[];
    assert.match(parts[0]!.text, /box is not running/);
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
          id: "m-test", fromId: bob.id,
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

/**
 * A client that also answers the tool-free `create` call compaction makes.
 *
 * `summariser` returns what the summarising round should reply, or throws to exercise the
 * fallback — which is the path that matters most, because it is the one that runs when the
 * context is already too big to summarise.
 */
function stubClientWithSummariser(
  replies: Anthropic.Message[],
  capture: Capture,
  summariser: (params: Anthropic.MessageCreateParams) => Anthropic.Message
): Anthropic {
  const { client } = stubClient(replies, capture);
  (client.messages as unknown as { create: unknown }).create = async (
    params: Anthropic.MessageCreateParams
  ) => summariser(params);
  return client;
}

/** A history long enough to trip the trigger, in whole call/result pairs. */
function bulkyHistory(pairs: number, charsEach: number): unknown[] {
  const entries: unknown[] = [];
  for (let at = 0; at < pairs; at++) {
    entries.push({
      role: "assistant",
      kind: "blocks",
      blocks: [
        { type: "text", text: `step ${at}` },
        { type: "tool_use", id: `toolu_${at}`, name: "bash", input: { command: `echo ${at}` } },
      ],
      at: new Date(2026, 0, 1, 0, at).toISOString(),
    });
    entries.push({
      role: "user",
      kind: "results",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${at}`,
          content: [{ type: "text", text: "x".repeat(charsEach) }],
        },
      ],
      at: new Date(2026, 0, 1, 0, at, 30).toISOString(),
    });
  }
  return entries;
}

test("an oversized history is summarised before the request, and the summary persists", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = process.env.AGENTBOX_COMPACT_AT_TOKENS;
  const previousKeep = process.env.AGENTBOX_COMPACT_KEEP_TOKENS;
  try {
    const ada = registry.create({ name: "Ada" });
    for (const entry of bulkyHistory(20, 2_000)) {
      registry.appendTranscript(ada.id, entry as never);
    }

    // Set on the module's own policy object: the defaults were read at import time, so setting
    // the environment here would change nothing and the test would pass for the wrong reason.
    DEFAULT_POLICY.triggerTokens = 5_000;
    DEFAULT_POLICY.keepTailTokens = 2_000;

    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const summaryCalls: Anthropic.MessageCreateParams[] = [];
    const client = stubClientWithSummariser(
      [message([textBlock("done")])],
      capture,
      params => {
        summaryCalls.push(params);
        return message([textBlock("**Threads** compaction fixture **Done** ran the steps **State** clean **Artifacts** none — wrote /home/box/work/out.txt.")]);
      }
    );

    const events: { type: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "carry on", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box: undefined,
        resolution: undefined,
        onEvent: event => events.push(event),
      }
    );

    assert.equal(summaryCalls.length, 1, "the summariser ran exactly once");
    assert.ok(
      summaryCalls[0]!.tools === undefined,
      "the summarising call declares no tools — it is not a turn"
    );

    // What was sent: the summary first, and much less than the raw history.
    const sent = capture.params[0]!.messages;
    const firstText =
      typeof sent[0]!.content === "string" ? sent[0]!.content : JSON.stringify(sent[0]!.content);
    assert.match(firstText, /Earlier in this conversation/, "the request opens with the summary");
    assert.ok(
      JSON.stringify(sent).length < 40_000,
      `the request should be far smaller than the ~80KB history, was ${JSON.stringify(sent).length}`
    );

    // What was stored: everything, plus the summary. The record is not what got trimmed.
    const stored = registry.readTranscript(ada.id) as { kind?: string }[];
    assert.ok(stored.length > 40, "no stored entry was destroyed");
    assert.equal(
      stored.filter(entry => entry.kind === "summary").length,
      1,
      "the summary is persisted, so the next turn pays nothing"
    );

    const compacted = events.find(event => event.type === "compacted") as
      | { covers: number; summarised: boolean }
      | undefined;
    assert.ok(compacted, "compaction is reported as its own event, not as agent prose");
    assert.equal(compacted.summarised, true);
    assert.ok(compacted.covers > 0);

    // The second turn must not summarise again: that is the whole point of persisting it.
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "again", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );
    assert.equal(summaryCalls.length, 1, "the persisted summary is reused");
  } finally {
    DEFAULT_POLICY.triggerTokens = Number(previousTrigger ?? 60_000);
    DEFAULT_POLICY.keepTailTokens = Number(previousKeep ?? 20_000);
    cleanup();
  }
});

test("a turn still runs when the summariser fails", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  const previousKeep = DEFAULT_POLICY.keepTailTokens;
  try {
    const ada = registry.create({ name: "Ada" });
    for (const entry of bulkyHistory(20, 2_000)) {
      registry.appendTranscript(ada.id, entry as never);
    }
    DEFAULT_POLICY.triggerTokens = 5_000;
    DEFAULT_POLICY.keepTailTokens = 2_000;

    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const client = stubClientWithSummariser([message([textBlock("done")])], capture, () => {
      throw new Error("overloaded");
    });

    const events: { type: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "carry on", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box: undefined,
        resolution: undefined,
        onEvent: event => events.push(event),
      }
    );

    // The turn ran. A failure to summarise must not become a failure to work.
    assert.equal(capture.params.length, 1, "the turn was still sent");

    const sent = capture.params[0]!.messages;
    const firstText =
      typeof sent[0]!.content === "string" ? sent[0]!.content : JSON.stringify(sent[0]!.content);
    assert.match(firstText, /could not be summarised/, "the model is told what it cannot see");

    const compacted = events.find(event => event.type === "compacted") as
      | { summarised: boolean; detail: string }
      | undefined;
    assert.ok(compacted, "the fallback is reported too — silent trimming is the failure mode");
    assert.equal(compacted.summarised, false);
    assert.match(compacted.detail, /overloaded/, "the reason survives into the feed");
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    DEFAULT_POLICY.keepTailTokens = previousKeep;
    cleanup();
  }
});

/**
 * A client whose stream rejects until the request gets small enough.
 *
 * `rejectWhile` decides, per request, whether the provider refuses it. That is the only honest way
 * to test the recovery path: the point is not that we call a prune function, it is that a turn which
 * would have died now finishes.
 */
function stubClientRejectingLargeRequests(
  replies: Anthropic.Message[],
  capture: Capture,
  rejectWhile: (params: Anthropic.MessageCreateParams) => string | undefined
): Anthropic {
  // `served` rather than the call index: a rejected request must not consume a reply,
  // because the turn retries it and the retry is meant to see the same one.
  let served = 0;
  return fakeModel(
    ({ params }) => {
      const refusal = rejectWhile(params);
      if (refusal !== undefined) throw new Error(refusal);
      return replies[Math.min(served++, replies.length - 1)]!;
    },
    { capture }
  );
}

/** Counts image blocks anywhere in a request, including nested in tool results. */
function imagesIn(params: Anthropic.MessageCreateParams): number {
  let count = 0;
  const walk = (block: unknown): void => {
    if (block === null || typeof block !== "object") return;
    const typed = block as { type?: string; content?: unknown };
    if (typed.type === "image") count++;
    if (Array.isArray(typed.content)) typed.content.forEach(walk);
  };
  for (const message of params.messages) {
    if (Array.isArray(message.content)) message.content.forEach(walk);
  }
  return count;
}

test("a turn that overflows mid-way sheds screenshots and finishes", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    // High, so the proactive guard does not fire and the *reactive* path is what is under test.
    DEFAULT_POLICY.triggerTokens = 10_000_000;

    // Six rounds of computer use, then done. The provider refuses any request carrying more than
    // two images — which is what an image-count limit looks like, and is unrelated to size.
    // Varied per round: six *identical* calls would be a loop by the definition in progress.ts, and
    // the loop detector would rightly end the turn before this test got to its point.
    const replies: Anthropic.Message[] = [
      ...Array.from({ length: 6 }, (_, index) =>
        message(
          [
            toolUseBlock(
              "computer",
              { actions: [{ action: "left_click", coordinate: [index * 10, index * 10] }] },
              `toolu_${index}`
            ),
          ],
          "tool_use"
        )
      ),
      message([textBlock("done")]),
    ];
    const client = stubClientRejectingLargeRequests(replies, capture, params =>
      imagesIn(params) > 2 ? "400 request contained too many images or documents" : undefined
    );

    const events: { type: string; detail?: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "drive the desktop", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box,
        resolution: undefined,
        displayIndex: 1,
        onEvent: event => events.push(event as { type: string }),
      }
    );

    // The turn completed. Before this existed it would have thrown on the round that crossed the
    // provider's limit, mid-task, with nothing the user could do.
    const texts = (registry.readTranscript(ada.id) as TranscriptEntry[]).filter(
      entry => !("kind" in entry)
    );
    assert.ok(
      JSON.stringify(texts).includes("done"),
      "the turn reached its own conclusion rather than dying"
    );

    // It recovered by shedding, and said so as its own event rather than as agent prose.
    const shed = events.filter(event => event.type === "compacted");
    assert.ok(shed.length > 0, "the recovery is reported");
    assert.ok(
      shed.some(event => (event.detail ?? "").includes("too-many-images")),
      `the reason survives: ${JSON.stringify(shed.map(event => event.detail))}`
    );

    // And every request that was actually accepted was within the provider's limit.
    const accepted = capture.params.filter(params => imagesIn(params) <= 2);
    assert.ok(accepted.length > 0);
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    cleanup();
  }
});

test("a request that cannot be made to fit fails with a usable message", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    DEFAULT_POLICY.triggerTokens = 10_000_000;

    // Refuses everything, and there are no images or long results to shed — so shedding cannot
    // help. Looping until the retry budget runs out would hide the real problem.
    const client = stubClientRejectingLargeRequests(
      [message([textBlock("never sent")])],
      capture,
      () => "400 prompt is too long"
    );

    await assert.rejects(
      runTurn(
        ada,
        [{ id: "m-test", fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box: undefined, resolution: undefined }
      ),
      /too large|nothing further can be dropped/
    );
    assert.ok(capture.params.length <= 2, "it did not retry blindly");
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    cleanup();
  }
});

test("a summary is prepared in the background and adopted without a wait", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  const previousKeep = DEFAULT_POLICY.keepTailTokens;
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});

    const entries = bulkyHistory(12, 400);
    for (const entry of entries) {
      registry.appendTranscript(ada.id, entry as never);
    }
    // The trigger is derived from what this history actually measures, so the test lands in the
    // background band (above 75% of the trigger, below the trigger) regardless of how estimation
    // changes later. Guessing a constant here is how a test starts passing for the wrong reason.
    const measured = estimateTokens(entries as HistoryEntry[]);
    DEFAULT_POLICY.triggerTokens = Math.ceil(measured / 0.85);
    DEFAULT_POLICY.keepTailTokens = Math.ceil(measured / 4);
    assert.equal(
      compactionUrgency(entries as HistoryEntry[], DEFAULT_POLICY),
      "background",
      "the fixture has to sit in the band this test is about"
    );

    const capture: Capture = { params: [] };
    let summaryCalls = 0;
    let released: (() => void) | undefined;
    const heldBack = new Promise<void>(resolve => {
      released = resolve;
    });

    // The summariser blocks until the test lets it go. If the turn awaited it, the turn would not
    // finish — which is precisely the 30-second pause this exists to remove.
    const client = stubClientWithSummariser([message([textBlock("ok")])], capture, () => {
      summaryCalls += 1;
      return message([textBlock("**Threads** compaction fixture **Done** ran the steps **State** clean **Artifacts** none")]);
    });
    (client.messages as unknown as { create: unknown }).create = async () => {
      summaryCalls += 1;
      await heldBack;
      return message([textBlock("**Threads** compaction fixture **Done** ran the steps **State** clean **Artifacts** none")]);
    };

    const deps = { client, registry, bus, box: undefined, resolution: undefined };
    const first = { id: "m-test", fromId: "user", fromName: "user", text: "one", priority: false, receivedAt: "" };

    // Turn one: in the background band. It must complete while the summariser is still blocked.
    await runTurn(ada, [first], new AbortController().signal, deps);
    assert.equal(capture.params.length, 1, "the turn went out");
    assert.equal(summaryCalls, 1, "and a summary was started");

    const stored = registry.readTranscript(ada.id) as TranscriptEntry[];
    assert.equal(
      stored.filter(entry => "kind" in entry && entry.kind === "summary").length,
      0,
      "nothing was adopted yet: there was still room, so the turn was not compacted"
    );

    // Now let it finish, and push the history over the trigger — by a *moderate* amount.
    // Four entries, not twelve: growth has to cross the trigger while leaving the
    // uncovered tail under it, because pendingIsUsable now token-validates the tail
    // (docs/24 v3 P0 #4) and doubling the history is precisely the case where reuse
    // would leave an unbounded request — that rejection has its own unit test.
    released?.();
    for (const entry of bulkyHistory(4, 400)) {
      registry.appendTranscript(ada.id, entry as never);
    }

    await runTurn(
      ada,
      [{ ...first, text: "two" }],
      new AbortController().signal,
      deps
    );

    // The second turn adopted the summary that was already sitting there rather than computing a
    // new one. That reuse is the whole point: the pause lands on nobody.
    assert.equal(summaryCalls, 1, "the prepared summary was reused, not recomputed");
    const after = registry.readTranscript(ada.id) as TranscriptEntry[];
    assert.equal(
      after.filter(entry => "kind" in entry && entry.kind === "summary").length,
      1,
      "and it was persisted"
    );
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    DEFAULT_POLICY.keepTailTokens = previousKeep;
    cleanup();
  }
});

/** A policy gate over a temporary file, for the integration tests below. */
function policyFixture(limits: Partial<PolicyLimits> = {}, spent = 0) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-turn-policy-"));
  const gate = new PolicyGate({
    path: join(dir, "policy.jsonl"),
    limits: {
      budgetWindowHours: 24,
      wakesPerWindow: 30,
      wakeWindowMinutes: 10,
      approvalRequiredTools: [],
      approvalRequiredCommands: [],
      ...limits,
    },
    spentSince: () => spent,
  });
  return { gate, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a stop ends a running turn at the next round, and says so in the transcript", async () => {
  const { registry, cleanup } = fixture();
  const policy = policyFixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    // The model keeps asking for another tool call, so without a stop this runs to MAX_ROUNDS.
    const client = fakeModel(
      ({ index }) => {
        const round = index + 1;
        // A person presses stop while the second round is in flight.
        if (round === 2) policy.gate.stop(ada.id, "alice");
        return message(
          [toolUseBlock("bash", { command: `echo ${round}` }, `toolu_${round}`)],
          "tool_use"
        );
      },
      { capture }
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "loop", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, displayIndex: 1, policy: policy.gate }
    );

    // Two requests went out, then the third round was refused. Not aborted mid-request: a call with
    // no result is a shape the next turn cannot replay.
    assert.equal(capture.params.length, 2, `expected two rounds, got ${capture.params.length}`);

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const last = transcript.at(-1);
    assert.ok(last && !("kind" in last), "the turn ends with prose, not a dangling call");
    assert.match(last.text, /stopped this turn/, "and the transcript says why it ended");
  } finally {
    policy.cleanup();
    cleanup();
  }
});

test("the next turn is not refused by the previous turn's stop", async () => {
  const { registry, cleanup } = fixture();
  const policy = policyFixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("done")])], capture);
    const deps = {
      client,
      registry,
      bus,
      box: undefined,
      resolution: undefined,
      policy: policy.gate,
    };

    policy.gate.stop(ada.id, "alice");
    // A stop belongs to the turn that was running. Left set, a person's next instruction would be
    // refused — which reads as the agent having broken rather than having been stopped.
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "again", priority: false, receivedAt: "" }],
      new AbortController().signal,
      deps
    );
    assert.equal(capture.params.length, 1, "the new turn ran");
    assert.equal(policy.gate.isStopped(ada.id), false);
  } finally {
    policy.cleanup();
    cleanup();
  }
});

test("an exhausted budget refuses the turn before it spends anything", async () => {
  const { registry, cleanup } = fixture();
  const policy = policyFixture({ budgetTokens: 100 }, 5_000);
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("should not be reached")])], capture);

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "work", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined, policy: policy.gate }
    );

    // Nothing was sent. A budget that only reports after the fact is not a budget.
    assert.equal(capture.params.length, 0, "no request was made");
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const last = transcript.at(-1);
    assert.ok(last && !("kind" in last));
    assert.match(last.text, /budget/, "the transcript explains why nothing happened");
  } finally {
    policy.cleanup();
    cleanup();
  }
});

test("a gated tool call comes back as a tool error, not as a crash", async () => {
  const { registry, cleanup } = fixture();
  const policy = policyFixture({ approvalRequiredCommands: ["rm "] });
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        message([toolUseBlock("bash", { command: "rm -rf /home/box/work" })], "tool_use"),
        message([textBlock("I cannot do that without approval.")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "clean up", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, displayIndex: 1, policy: policy.gate }
    );

    // The box never saw it. A refusal that still runs the command is not a refusal.
    assert.equal(
      calls.filter(call => call.kind === "exec").length,
      0,
      "the command did not reach the box"
    );

    // And the model was told, in a shape it already knows how to read.
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const results = transcript.find(entry => "kind" in entry && entry.kind === "results");
    assert.ok(results && "blocks" in results);
    const block = results.blocks[0] as Anthropic.ToolResultBlockParam;
    assert.equal(block.is_error, true);
    const parts = block.content as Anthropic.TextBlockParam[];
    assert.match(parts[0]!.text, /needs a person's approval/);

    // A person now has something to decide on, naming the exact command.
    assert.deepEqual(
      policy.gate.pending().map(entry => entry.description),
      ["Ada: bash — rm -rf /home/box/work"]
    );
  } finally {
    policy.cleanup();
    cleanup();
  }
});

test("the wake limit stops two agents from waking each other forever", async () => {
  const { registry, cleanup } = fixture();
  const policy = policyFixture({ wakesPerWindow: 1, wakeWindowMinutes: 10 });
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        message([toolUseBlock("SendToAgent", { target_id: bob.id, message: "one" })], "tool_use"),
        message([toolUseBlock("SendToAgent", { target_id: bob.id, message: "two" })], "tool_use"),
        message([textBlock("stopping")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "delegate", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined, policy: policy.gate }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const results = transcript.filter(
      entry => "kind" in entry && entry.kind === "results"
    ) as Extract<TranscriptEntry, { kind: "results" }>[];
    assert.equal(results.length, 2, "both sends were attempted");

    const second = results[1]!.blocks[0] as Anthropic.ToolResultBlockParam;
    assert.equal(second.is_error, true, "the second was refused");
    const parts = second.content as Anthropic.TextBlockParam[];
    assert.match(parts[0]!.text, /loop that/, "and the reason names the failure it prevents");
  } finally {
    policy.cleanup();
    cleanup();
  }
});

test("a dropped connection mid-turn is retried, and the turn finishes", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    // Two rounds fail with a wrapped ECONNRESET — the shape a real dropped connection has — then the
    // third succeeds. Before this, the first one ended the turn and the work with it.
    let attempts = 0;
    const client = fakeModel(
      ({ index }) => {
        attempts += 1;
        if (index < 2) {
          throw new Error("fetch failed", {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }
        return message([textBlock("finished anyway")]);
      },
      { capture }
    );

    const events: { type: string; discardPartial?: boolean; kind?: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "work", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box: undefined,
        resolution: undefined,
        onEvent: event => events.push(event as { type: string }),
      }
    );

    assert.equal(attempts, 3, "two failures, then a success");
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const last = transcript.at(-1);
    assert.ok(last && !("kind" in last));
    assert.match(last.text, /finished anyway/, "the turn reached its own conclusion");

    // Reported, so a watcher knows why there was a pause rather than assuming a hang.
    const retries = events.filter(event => event.type === "retrying");
    assert.equal(retries.length, 2);
    assert.equal(retries[0]?.kind, "transient");
    // Nothing had been shown, so there is no partial for the watcher to drop.
    assert.equal(retries[0]?.discardPartial, false);
  } finally {
    cleanup();
  }
});

test("a rejected request is not retried, and the error is not hidden behind delays", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    let attempts = 0;
    const client = fakeModel(
      () => {
        attempts += 1;
        throw Object.assign(new Error("invalid_request_error: model: unknown model"), {
          status: 400,
        });
      },
      { capture }
    );

    await assert.rejects(
      runTurn(
        ada,
        [{ id: "m-test", fromId: "user", fromName: "user", text: "work", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box: undefined, resolution: undefined }
      ),
      /unknown model/
    );
    // Once. Retrying a rejected request burns money and hides the real error behind a delay.
    assert.equal(attempts, 1);
  } finally {
    cleanup();
  }
});

test("a plan and todo list survive a compaction that replaces the conversation", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  const previousKeep = DEFAULT_POLICY.keepTailTokens;
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});

    // The agent has written a plan and a list, and then done enough work to force a summary.
    registry.writePlan(ada.id, "Ship the parser. Ruled out regexes: nested quotes.");
    registry.writeTodos(ada.id, [
      { text: "read the spec", status: "done" },
      { text: "write the tokeniser", status: "doing" },
    ]);
    for (const entry of bulkyHistory(20, 2_000)) {
      registry.appendTranscript(ada.id, entry as never);
    }
    DEFAULT_POLICY.triggerTokens = 5_000;
    DEFAULT_POLICY.keepTailTokens = 2_000;

    const capture: Capture = { params: [] };
    const client = stubClientWithSummariser([message([textBlock("done")])], capture, () =>
      // A summary that says nothing about the plan, deliberately: the point is that the plan does not
      // depend on the summariser having mentioned it.
      message([textBlock("Earlier: some shell commands were run.")])
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "carry on", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const params = capture.params[0]!;
    const system = (params.system as Anthropic.TextBlockParam[]).map(block => block.text).join("\n");

    // Compaction happened — the history was replaced by a summary that mentions neither.
    const sent = JSON.stringify(params.messages);
    assert.match(sent, /Earlier in this conversation/, "the conversation was compacted");
    assert.ok(!sent.includes("Ruled out regexes"), "and the summary did not carry the plan");

    // And the plan and list are still there, because they were never in the history to lose. This is
    // the whole claim: the survival comes from placement, not from a mechanism that could fail.
    assert.match(system, /Ruled out regexes: nested quotes/, "the plan is in the system prompt");
    assert.match(system, /- \[x\] read the spec/);
    assert.match(system, /- \[>\] write the tokeniser/);
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    DEFAULT_POLICY.keepTailTokens = previousKeep;
    cleanup();
  }
});

test("SetPlan and SetTodos round-trip through the tools", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        message([toolUseBlock("SetPlan", { plan: "Do the thing" }, "toolu_1")], "tool_use"),
        message(
          [
            toolUseBlock(
              "SetTodos",
              { todos: [{ text: "step one", status: "doing" }] },
              "toolu_2"
            ),
          ],
          "tool_use"
        ),
        message([textBlock("planned")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "plan it", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const state = registry.readDurableState(ada.id);
    assert.equal(state.plan, "Do the thing");
    assert.deepEqual(state.todos, [{ text: "step one", status: "doing" }]);

    // The tool result echoes the whole list, which is what makes a round-5 change visible at round
    // 300 given the system prompt is built once per turn.
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const results = transcript.filter(
      entry => "kind" in entry && entry.kind === "results"
    ) as Extract<TranscriptEntry, { kind: "results" }>[];
    const echoed = JSON.stringify(results.at(-1));
    assert.match(echoed, /0\/1 done/);
    assert.match(echoed, /step one/);
  } finally {
    cleanup();
  }
});

test("read_file on an image hands the model the image itself", async () => {
  // The road to "what is in this picture" used to be the desktop viewer plus a
  // screenshot — slow enough that agents answered "收到图片" without looking.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        message([toolUseBlock("read_file", { path: "/home/box/work/chats/c1/inbox/qr.png" })], "tool_use"),
        message([textBlock("一张二维码。")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "看看这张图", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    );

    assert.ok(calls.some(call => call.kind === "download"), "the bytes came from the box");
    // The second request carries the tool result; the image block is in it.
    const results = capture.params
      .at(-1)!
      .messages.flatMap(entry => (Array.isArray(entry.content) ? entry.content : []))
      .filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result");
    const imageBlock = results
      .flatMap(result => (Array.isArray(result.content) ? result.content : []))
      .find(block => block.type === "image") as { source?: { media_type?: string; data?: string } } | undefined;
    assert.ok(imageBlock !== undefined, "an image block rides in the tool result");
    assert.equal(imageBlock.source?.media_type, "image/png");
    assert.equal(imageBlock.source?.data, "ZmFrZS1wbmctYnl0ZXM=");
  } finally {
    cleanup();
  }
});

test("text followed only by bookkeeping calls is the answer, filed — it lands in the transcript as prose", async () => {
  // t51's shape, replayed. The agent wrote its whole analysis, then tidied up with
  // Tasks.update and RememberFact — and the tidying demoted the answer to narration:
  // the person's screen said "已记下,等你下一步" while the table sat in a folded step.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const analysis =
      "16GB 内存的结论:7B 量化模型可以流畅跑,13B 勉强可用,70B 完全放不下。" +
      "推荐从 qwen2.5:7b-instruct-q4 开始,备选 llama3.1:8b。原因和数据如下表。";
    const { client } = stubClient(
      [
        message(
          [
            textBlock(analysis),
            toolUseBlock("Tasks", { action: "update", id: "t1", status: "review" }, "toolu_a"),
            toolUseBlock("RememberFact", { fact: "the new mac has 16GB" }, "toolu_b"),
          ],
          "tool_use"
        ),
        message([textBlock("已记下。t1 进入 review,等你下一步。")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "which models fit?", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    // The reply a channel assembles is the plain assistant prose — both paragraphs.
    const prose = transcript
      .filter(entry => !("kind" in entry) && entry.role === "assistant")
      .map(entry => (entry as { text: string }).text);
    assert.equal(prose.length, 2, "the filed analysis and the closing line both land");
    assert.match(prose[0]!, /7B 量化模型/);
    assert.match(prose[1]!, /已记下/);
    // And the promoted text is not also replayed from the blocks entry — one copy.
    const blocks = transcript.find(entry => "kind" in entry && entry.kind === "blocks") as
      | Extract<TranscriptEntry, { kind: "blocks" }>
      | undefined;
    assert.ok(blocks !== undefined);
    assert.equal(
      blocks.blocks.some(block => (block as { type?: string }).type === "text"),
      false,
      "the filed text lives in the prose entry, not twice"
    );
  } finally {
    cleanup();
  }
});

test("the filed-answer rule leaves asides and provisional narration alone", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };
    const { client } = stubClient(
      [
        // A genuine one-line acknowledgement before the write-down it announces: below
        // the floor, not promoted — the named risk in the R32 plan.
        message([textBlock("我先把这个记下来。"), toolUseBlock("RememberFact", { fact: "x" }, "toolu_1")], "tool_use"),
        // Long text before an *investigative* call is genuinely provisional: the agent
        // has not seen what comes back yet.
        message(
          [
            textBlock(
              "先看一下内存有多大再下结论。如果是 16GB,后面的推荐会完全不同;如果是 32GB," +
                "可选的模型档位会宽很多。这一步的输出决定后面的整个建议。"
            ),
            toolUseBlock("bash", { command: "free -h" }, "toolu_2"),
          ],
          "tool_use"
        ),
        message([textBlock("查完了:16GB。")]),
      ],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "check", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    );

    const prose = (registry.readTranscript(ada.id) as TranscriptEntry[])
      .filter(entry => !("kind" in entry) && entry.role === "assistant")
      .map(entry => (entry as { text: string }).text);
    assert.deepEqual(prose, ["查完了:16GB。"], "only the final text is the reply");
  } finally {
    cleanup();
  }
});

test("a looping agent is stopped early, with the repeated call named", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    // The same call forever. Before this, four hundred rounds of it — and then a note saying the
    // agent was "probably" looping.
    const { client } = stubClient(
      [message([toolUseBlock("bash", { command: "ls /nowhere" })], "tool_use")],
      capture
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "look around", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, displayIndex: 1 }
    );

    // Four rounds, not four hundred. Every round after the second was already waste.
    assert.ok(capture.params.length <= 5, `expected to stop early, ran ${capture.params.length}`);

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const last = transcript.at(-1);
    assert.ok(last && !("kind" in last));
    // The call is quoted, which is worth more to whoever reads this than an adjective.
    assert.match(last.text, /same `bash` call with the same/);
    assert.match(last.text, /That is a loop rather than slow[\s\S]*progress/);
  } finally {
    cleanup();
  }
});

test("a turn that is still working continues instead of being abandoned", async () => {
  const { registry, cleanup } = fixture();
  const previousMax = process.env.AGENTBOX_MAX_ROUNDS;
  try {
    // A tiny budget, so the limit is reached in a test rather than in four hundred rounds. Read at
    // module load, so this test drives the loop directly rather than through runTurn.
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    // Varied calls and a todo list that moves: progress by any reading. The stub keeps working, so
    // the only thing that ends this is the round budget.
    // Never finishes on its own: the only thing that may end this turn is the round
    // budget, which is what the test is about.
    const client = fakeModel(
      ({ index }) =>
        message(
          [toolUseBlock("bash", { command: `echo ${index + 1}` }, `toolu_${index + 1}`)],
          "tool_use"
        ),
      { capture }
    );
    registry.writeTodos(ada.id, [{ text: "keep going", status: "doing" }]);

    await assert.rejects(
      runTurn(
        ada,
        [{ id: "m-test", fromId: "user", fromName: "user", text: "work", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box, resolution: undefined, displayIndex: 1 }
      ),
      /continuations/
    );

    // It continued rather than stopping at the first limit: more rounds ran than one budget allows.
    assert.ok(
      capture.params.length > 400,
      `expected continuations past one budget, ran ${capture.params.length}`
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const text = JSON.stringify(transcript);
    assert.match(text, /still making progress; continuing in a fresh turn/);
    assert.match(text, /this is a fresh turn rather than a failure/, "the agent was told why");
    // And it ends by saying it ran out of budget rather than claiming a conclusion.
    assert.match(text, /Stopped after 3 continuations/);
  } finally {
    if (previousMax === undefined) delete process.env.AGENTBOX_MAX_ROUNDS;
    else process.env.AGENTBOX_MAX_ROUNDS = previousMax;
    cleanup();
  }
});

test("a turn that ends with nothing to say says that, rather than ending silently", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    // A final message with no text: thinking blocks only, an empty content array, a model that
    // stopped without narrating it. From the person's side an unreported version of this is "I asked
    // and nothing happened" — indistinguishable from a hang, a crash, or being ignored.
    const { client } = stubClient([message([])], capture);

    const events: { type: string; delta?: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "do it", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box: undefined,
        resolution: undefined,
        onEvent: event => events.push(event as { type: string }),
      }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const last = transcript.at(-1);
    assert.ok(last && !("kind" in last), "something was recorded");
    assert.match(last.text, /ended without anything to report/);
    // And it says the distinction that matters: no answer is not the same as an empty answer.
    assert.match(last.text, /not an empty one/);
    // The watcher is told too, not just the file.
    assert.ok(events.some(event => event.type === "text" && /ended without/.test(event.delta ?? "")));
  } finally {
    cleanup();
  }
});


test("a round that streams only tool calls is not mistaken for a stalled one", async () => {
  // The first-token deadline used to be cleared only by a `text` event. A round that is entirely
  // tool calls — which is most of a computer-use turn — never produces one, nor does a long stretch
  // of thinking, so a model working perfectly well was aborted as stalled and retried, on exactly
  // the turns that take longest.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    const toolRound = message([toolUseBlock("RememberFact", { text: "x" }, "t1")], "tool_use");
    const finalRound = message([textBlock("done")]);
    let progressFromRawEvents = false;

    const client = fakeModel(({ index: at }) => (at === 0 ? toolRound : finalRound), {
      capture,
      streamText: true,
      events: ({ index: at }) => {
        if (at !== 0) return [];
        progressFromRawEvents = true;
        // message_start alone is what an opened-but-silent stream sends, so it must not
        // count; the block start is real progress.
        return [{ type: "message_start" }, { type: "content_block_start", index: 0 }];
      },
    });

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "remember this", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    assert.ok(progressFromRawEvents, "the tool-only round reported progress through raw events");
    assert.equal(capture.params.length, 2, "two rounds, neither abandoned as a stall");
  } finally {
    cleanup();
  }
});


test("a stop pressed while the history is being compacted is not cleared by the turn starting", async () => {
  // One flag meant both "stop the turn that was running" and "stop the turn that is starting", and
  // the clearing happened *after* compaction. Compaction waits on a summariser for seconds, so a
  // stop pressed during that wait was thrown away moments later and the turn ran on: the Stop
  // button did nothing, silently.
  const { registry, cleanup } = fixture();
  const policy = policyFixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  const previousKeep = DEFAULT_POLICY.keepTailTokens;
  try {
    // Both, because policyForModel ignores DEFAULT_POLICY once a context window has been learned
    // for this model — which an earlier test in this file may have done.
    process.env.AGENTBOX_COMPACT_AT_TOKENS = "50";
    DEFAULT_POLICY.triggerTokens = 50;
    // The tail has to be small too, or the whole window counts as tail and no cut is named.
    DEFAULT_POLICY.keepTailTokens = 20;
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    for (const entry of bulkyHistory(12, 400)) registry.appendTranscript(ada.id, entry as never);

    const capture: Capture = { params: [] };
    let calls = 0;
    const client = fakeModel(
      () => {
        calls++;
        return message([textBlock("the turn ran anyway")]);
      },
      {
        capture,
        // The summariser goes through `create`, not `stream`. The person presses Stop
        // while it is in flight — which is the window the bug lived in.
        create: () => {
          calls++;
          policy.gate.stop(ada.id, "alice");
          return message([
            textBlock(
              "**Threads** compaction fixture **Done** ran the steps **State** clean **Artifacts** none"
            ),
          ]);
        },
      }
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "go", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box: undefined,
        resolution: undefined,
        policy: policy.gate,
      }
    );

    assert.equal(policy.gate.isStopped(ada.id), true, "the stop survived the turn starting");
    assert.equal(calls, 1, "and no round ran after it: only the summariser was called");
    assert.equal(capture.params.length, 0, "the model was never asked to take a turn");
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    assert.match(
      JSON.stringify(transcript.slice(-3)),
      /stopped/i,
      "and the transcript says it was stopped rather than ending blank"
    );
  } finally {
    delete process.env.AGENTBOX_COMPACT_AT_TOKENS;
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    DEFAULT_POLICY.keepTailTokens = previousKeep;
    policy.cleanup();
    cleanup();
  }
});


test("a continuation reassembles its request instead of growing the old one", async () => {
  // A continuation used to push one more message onto the array the previous four hundred rounds
  // had built, so the turn that most needs room — one still working after four hundred rounds — was
  // the only one that never got any. Proactive compaction had already run, once, before round one.
  const { registry, cleanup } = fixture();
  const previousRounds = process.env.AGENTBOX_MAX_ROUNDS;
  try {
    // Two rounds per pass, so the limit is reached quickly and a continuation happens.
    process.env.AGENTBOX_MAX_ROUNDS = "2";
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };

    // Always asks for another tool call, so every pass exhausts its rounds while making progress.
    const client = fakeModel(
      ({ index }) =>
        message([toolUseBlock("bash", { command: `echo t${index}` }, `t${index}`)], "tool_use"),
      { capture, create: () => message([textBlock("a summary")]) }
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "keep going", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    ).catch(() => {
      // It ends at the continuation budget; the assertion below is about the requests it made.
    });

    // The first request of a continuation must not simply be the previous one plus a line. It is
    // rebuilt from the transcript, so its first message is the start of the window rather than the
    // original prompt object carried forward.
    const sizes = capture.params.map(params => params.messages.length);
    assert.ok(sizes.length > 2, `expected several rounds, got ${sizes.length}`);
    const shrinks = sizes.some((size, index) => index > 0 && size < sizes[index - 1]!);
    assert.ok(
      shrinks,
      `a continuation should rebuild rather than only ever grow; sizes were ${JSON.stringify(sizes)}`
    );
  } finally {
    if (previousRounds === undefined) delete process.env.AGENTBOX_MAX_ROUNDS;
    else process.env.AGENTBOX_MAX_ROUNDS = previousRounds;
    cleanup();
  }
});


test("a turn killed mid-flight leaves a record that it was interrupted", async () => {
  // The claim the whole feature rests on: after the process dies, a *fact* is on disk saying a turn
  // was in progress. Before this, an agent four hundred rounds into a task simply stopped — no
  // error, no report, and nothing that would ever run again.
  const { registry, cleanup } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "agentbox-turns-"));
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const ledger = new TurnLedger(join(dir, "turns.jsonl"));
    const capture: Capture = { params: [] };

    // A turn that never returns, standing in for a process that dies inside one.
    const wedged = fakeModel(() => new Promise<never>(() => {}), { capture });

    void runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "deploy the release", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client: wedged, registry, bus, box: undefined, resolution: undefined, turns: ledger }
    );
    // Let it reach the model call, which is where it will sit forever.
    await new Promise(resolve => setImmediate(resolve));

    // What a fresh process sees.
    const outstanding = new TurnLedger(join(dir, "turns.jsonl")).interrupted();
    assert.equal(outstanding.length, 1, "the interrupted turn is on disk");
    assert.equal(outstanding[0]?.agentId, ada.id);
    assert.match(outstanding[0]?.about ?? "", /deploy the release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("a turn that finishes leaves nothing to resume", async () => {
  const { registry, cleanup } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "agentbox-turns-"));
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const ledger = new TurnLedger(join(dir, "turns.jsonl"));
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("done")])], capture);

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined, turns: ledger }
    );

    assert.deepEqual(new TurnLedger(join(dir, "turns.jsonl")).interrupted(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("a turn that throws is closed too, not left looking interrupted", async () => {
  // A failure and an abort are ends. Leaving them open would have the next startup resume something
  // that already reported itself, which reads as the agent repeating itself for no reason.
  const { registry, cleanup } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "agentbox-turns-"));
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const ledger = new TurnLedger(join(dir, "turns.jsonl"));
    const exploding = fakeModel(() => {
      throw new Error("400 model does not exist");
    });

    await assert.rejects(
      runTurn(
        ada,
        [{ id: "m-test", fromId: "user", fromName: "user", text: "hi", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client: exploding, registry, bus, box: undefined, resolution: undefined, turns: ledger }
      )
    );
    assert.deepEqual(new TurnLedger(join(dir, "turns.jsonl")).interrupted(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});


test("the call that was in flight survives into the resumed turn, marked unknown", async () => {
  // The evidence a resumed turn most needs is the action that was running when the process died.
  // Request assembly used to pop a trailing call with no results — correct once, because a request
  // ending in an unpaired tool_use is rejected, and wrong since pairing started being repaired: the
  // agent was told to check what it might have been part-way through, while the record of what that
  // was had been deleted from its own history.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    const { client } = stubClient([message([textBlock("checked, it had gone through")])], capture);

    registry.appendTranscript(ada.id, {
      role: "user",
      text: "deploy the release",
      at: new Date().toISOString(),
    });
    registry.appendTranscript(ada.id, {
      role: "assistant",
      kind: "blocks",
      at: new Date().toISOString(),
      blocks: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "./deploy.sh" } }],
    } as never);
    // No results entry: the crash landed between the call and its result.

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "[resumed] carry on", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const sent = JSON.stringify(capture.params[0]?.messages);
    assert.match(sent, /deploy\.sh/, "the agent can see what it was doing");
    assert.match(sent, /outcome is unknown/, "and that it does not know whether it worked");
    assert.doesNotMatch(sent, /"is_error":true/, "not reported as a failure it can undo");
  } finally {
    cleanup();
  }
});

test("a max_tokens stop is truncation only when output sits well below the intended cap", () => {
  const at = (output: number, stop: string | null = "max_tokens") => ({
    stop_reason: stop,
    usage: { output_tokens: output },
  });
  assert.ok(isTruncatedByContext(at(5), 32_000), "an empty response claiming max_tokens is a squeeze");
  assert.ok(isTruncatedByContext(at(31_000), 32_000), "well below the cap: squeezed");
  assert.ok(!isTruncatedByContext(at(32_000), 32_000), "at the cap: a genuine limit stop");
  assert.ok(!isTruncatedByContext(at(31_990), 32_000), "a few tokens short of the cap still counts as reaching it");
  assert.ok(!isTruncatedByContext(at(5, "end_turn"), 32_000), "only max_tokens is ambiguous");
  assert.ok(!isTruncatedByContext(at(5), 0), "no intended cap, no classification");
});

test("a context-squeezed response is discarded, billed, and the round retried", async () => {
  const { registry, cleanup } = fixture();
  const previousTrigger = DEFAULT_POLICY.triggerTokens;
  const usagePath = join(mkdtempSync(join(tmpdir(), "agentbox-truncusage-")), "usage.jsonl");
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };
    DEFAULT_POLICY.triggerTokens = 10_000_000; // keep proactive compaction out of the way

    // Two computer rounds put two screenshots into the request, so the shed path has
    // something to drop. Then the provider returns a response squeezed by context —
    // stop max_tokens with 5 output tokens against a 32k intent — then a real answer.
    const truncated = message([textBlock("TRUNCATED-GARBAGE")], "max_tokens");
    const replies: Anthropic.Message[] = [
      message([toolUseBlock("computer", { actions: [{ action: "left_click", coordinate: [10, 10] }] }, "toolu_a")], "tool_use"),
      message([toolUseBlock("computer", { actions: [{ action: "left_click", coordinate: [20, 20] }] }, "toolu_b")], "tool_use"),
      truncated,
      message([textBlock("done properly")]),
    ];
    const { client } = stubClient(replies, capture);

    const usage = new UsageLog(usagePath);
    const events: { type: string; kind?: string; detail?: string }[] = [];
    await runTurn(
      ada,
      [{ id: "m-trunc", fromId: "user", fromName: "user", text: "drive", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box,
        usage,
        resolution: undefined,
        displayIndex: 1,
        provider: {
          label: "test",
          model: "test-model",
          maxTokens: 32_000,
          vision: true,
          adaptiveThinking: false,
          effort: false,
          promptCaching: false,
          auth: "bearer",
          keyEnv: "TEST_KEY",
        },
        onEvent: event => events.push(event as { type: string }),
      }
    );

    // The garbage never reached the transcript; the retried round's answer did.
    const transcript = JSON.stringify(registry.readTranscript(ada.id));
    assert.ok(!transcript.includes("TRUNCATED-GARBAGE"), "the squeezed response was discarded");
    assert.ok(transcript.includes("done properly"), "the retry produced the real answer");

    // The retry consumed no extra round: four requests for three rounds of work.
    assert.equal(capture.params.length, 4);

    // The watcher was told to drop what it had rendered, the same way a connection
    // retry says it.
    assert.ok(
      events.some(event => event.type === "retrying" && event.kind === "truncated"),
      `a truncation retry event exists: ${JSON.stringify(events.filter(e => e.type === "retrying"))}`
    );

    // And the discarded response is on the bill: every request settled, every request
    // recorded — spend must not vanish with a response we chose to throw away.
    assert.equal(usage.totals().records, 4, "all four requests billed, the discarded one included");
  } finally {
    DEFAULT_POLICY.triggerTokens = previousTrigger;
    cleanup();
    rmSync(join(usagePath, ".."), { recursive: true, force: true });
  }
});

test("a user message during a running turn steers the next round instead of waiting", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const capture: Capture = { params: [] };
    // Round 1 calls bash; while the tool runs, the user speaks. Round 2 must see it.
    const replies: Anthropic.Message[] = [
      message([toolUseBlock("bash", { command: "sleep-ish" }, "toolu_steer")], "tool_use"),
      message([textBlock("did both things")]),
    ];
    const { client } = stubClient(replies, capture);

    // The bus is real; the box's exec is the mid-turn moment the user types.
    const bus = new AgentBus(registry, async () => {});
    const box = {
      exec: async () => {
        bus.sendFromUser(ada.id, "actually, also change the title");
        return { stdout: "ok", stderr: "", exit_code: 0, timed_out: false };
      },
    } as unknown as BoxClient;

    await runTurn(
      ada,
      [{ id: "m-steer", fromId: "user", fromName: "user", text: "do the task", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, displayIndex: 1 }
    );

    // The steer reached the model in the same turn: round 2's request carries it.
    const secondRequest = JSON.stringify(capture.params[1]?.messages ?? []);
    assert.ok(
      secondRequest.includes("also change the title"),
      "the next round's request contains the mid-turn message"
    );
    // It is on the record as a user entry in this conversation, causally linked.
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const steerEntry = transcript.find(
      entry =>
        "role" in entry &&
        entry.role === "user" &&
        "text" in entry &&
        entry.text.includes("also change the title")
    );
    assert.ok(steerEntry, "the steering is a transcript entry, not a ghost");
    // And nothing is left queued: consumed exactly once, by this turn.
    assert.equal(bus.pendingCount(ada.id), 0);
  } finally {
    cleanup();
  }
});

test("a resumed turn re-runs the safe half of an interrupted batch and leaves the rest unknown", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };

    // What a crash leaves behind: an assistant entry calling read_file and bash,
    // with no results entry — the process died mid-batch.
    registry.appendTranscript(ada.id, {
      role: "user",
      text: "check the config and restart the service",
      at: new Date().toISOString(),
    });
    registry.appendTranscript(ada.id, {
      role: "assistant",
      kind: "blocks",
      blocks: [
        { type: "tool_use", id: "toolu_read", name: "read_file", input: { path: "/home/box/work/config.txt" } },
        { type: "tool_use", id: "toolu_bash", name: "bash", input: { command: "systemctl restart svc" } },
      ],
      at: new Date().toISOString(),
    });

    const box = {
      readFile: async (path: string) => ({
        path,
        content: "port=8080",
        total_lines: 1,
        truncated: false,
      }),
      exec: async () => {
        throw new Error("bash must not be replayed on resume");
      },
    } as unknown as BoxClient;

    const { client } = stubClient([message([textBlock("resumed and done")])], capture);
    await runTurn(
      ada,
      [{ id: "m-resume", fromId: "user", fromName: "user", text: "[resumed] pick up where you left off", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box,
        resolution: undefined,
        displayIndex: 1,
        resumeOf: { id: "turn-before-crash", attempt: 2 },
      }
    );

    const request = JSON.stringify(capture.params[0]?.messages ?? []);
    assert.ok(request.includes("port=8080"), "the read-only call was answered fresh, not guessed");
    assert.ok(request.includes("Re-run on resume"), "and says it was re-run");
    assert.ok(
      request.includes("never recorded"),
      "the bash call keeps the honest unknown treatment"
    );

    // The replayed results are on the record, so a second resume would not re-run them.
    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const resultsEntries = transcript.filter(entry => "kind" in entry && entry.kind === "results");
    assert.ok(resultsEntries.length >= 1, "the replay is a transcript entry");
  } finally {
    cleanup();
  }
});

test("an ordinary (non-resumed) turn never replays a trailing batch", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: Capture = { params: [] };
    let reads = 0;

    registry.appendTranscript(ada.id, {
      role: "assistant",
      kind: "blocks",
      blocks: [{ type: "tool_use", id: "toolu_r", name: "read_file", input: { path: "/x" } }],
      at: new Date().toISOString(),
    });

    const box = {
      readFile: async () => {
        reads += 1;
        return { path: "/x", content: "data", total_lines: 1, truncated: false };
      },
    } as unknown as BoxClient;

    const { client } = stubClient([message([textBlock("ok")])], capture);
    await runTurn(
      ada,
      [{ id: "m-plain", fromId: "user", fromName: "user", text: "hello", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, displayIndex: 1 }
    );

    assert.equal(reads, 0, "replay is a resume-only behaviour");
    assert.ok(
      JSON.stringify(capture.params[0]?.messages ?? []).includes("never recorded"),
      "the trailing batch still gets the honest unknown at assembly"
    );
  } finally {
    cleanup();
  }
});

test("the transcript records when a tool batch started and when its results were in", async () => {
  // Both entries used to share one timestamp taken after the tools ran, so every duration
  // on disk derived to zero -- and a defect that succeeds slowly (a click that took
  // fifteen seconds to land) was invisible to any reading of the transcript.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const slowBox = {
      computer: async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return {
          success: true,
          screenshot: Buffer.from("fake-webp-bytes").toString("base64"),
          action_count: 1,
          duration_ms: 25,
          cursor_position: { x: 1, y: 2 },
        };
      },
    } as unknown as BoxClient;

    const { client } = stubClient(
      [
        message([toolUseBlock("computer", { actions: [{ action: "screenshot" }] })], "tool_use"),
        message([textBlock("Done.")]),
      ],
      { params: [] }
    );

    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "look", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box: slowBox, resolution: undefined }
    );

    const transcript = registry.readTranscript(ada.id) as TranscriptEntry[];
    const blocks = transcript.find(entry => "kind" in entry && entry.kind === "blocks");
    const results = transcript.find(entry => "kind" in entry && entry.kind === "results");
    assert.ok(blocks && results, "the exchange must be persisted");
    const elapsed = Date.parse(results.at!) - Date.parse(blocks.at!);
    assert.ok(
      elapsed >= 20,
      `results.at - blocks.at should cover the tool's ~25ms run, got ${elapsed}ms`
    );
  } finally {
    cleanup();
  }
});

test("output from a command given a credential is not kept in the transcript", () => {
  // The one place the harness *knows* a result may hold a secret, because the caller named
  // the secrets it wanted (docs/15). Not containment from the model, which nothing
  // achieves -- containment from the record, which is what R7 is about.
  const shown = "ghp_realtokenvalue0123456789\n\nexit code: 0";
  const block: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: "call-1",
    content: [{ type: "text", text: shown }],
  };
  const record = "$ gh auth status\n\nran on the host with GITHUB_TOKEN in its environment.";

  const stored = storableResult(block, record);
  const text = (stored.content as Anthropic.TextBlockParam[])[0]!.text;
  assert.equal(text, record);
  assert.ok(!text.includes("ghp_realtokenvalue0123456789"), "the value must not be stored");
  assert.equal(stored.tool_use_id, "call-1", "the record still ties to the call it answers");

  // And without a substitute, nothing changes: every other tool stores what it showed.
  const plain = storableResult(block);
  assert.match((plain.content as Anthropic.TextBlockParam[])[0]!.text, /ghp_realtokenvalue/);
});

test("a resumed turn's usage rows carry the work id of the turn it picked up", async () => {
  const { registry, cleanup } = fixture();
  const root = mkdtempSync(join(tmpdir(), "agentbox-workid-"));
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const turns = new TurnLedger(join(root, "turns.jsonl"));
    const usage = new UsageLog(join(root, "usage.jsonl"));
    const { client } = stubClient([message([textBlock("done")])], { params: [] });
    const run = (resumeOf?: { id: string; attempt: number; workId?: string }) =>
      runTurn(
        ada,
        [{ id: "m", fromId: "user", fromName: "user", text: "the long one", priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box: undefined, resolution: undefined, turns, usage, ...(resumeOf ? { resumeOf } : {}) }
      );

    await run();
    const first = turns.interrupted();
    // The first turn ended, so nothing is outstanding; the work id has to come off the record
    // the ledger wrote rather than out of the runTurn call, which is the whole handoff.
    assert.deepEqual(first, [], "a completed turn is not outstanding");
    const rowsAfterFirst = usage.since(0, 1000);
    const workId = rowsAfterFirst[0]?.workId;
    assert.ok(workId, "a usage row carries the work it belongs to");

    // Now the crash-and-resume: the orchestrator hands the previous work id across.
    await run({ id: "t-earlier", attempt: 2, workId });

    const rows = usage.since(0, 1000);
    assert.ok(rows.length >= 2, "both turns billed");
    const distinct = new Set(rows.map(row => row.workId));
    assert.equal(
      distinct.size,
      1,
      "two attempts at one piece of work bill to one work id — this is the entire point of the field"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("a turn that is not a resumption starts its own work", async () => {
  const { registry, cleanup } = fixture();
  const root = mkdtempSync(join(tmpdir(), "agentbox-workid2-"));
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const usage = new UsageLog(join(root, "usage.jsonl"));
    const { client } = stubClient([message([textBlock("done")])], { params: [] });
    for (const text of ["first thing", "unrelated second thing"]) {
      await runTurn(
        ada,
        [{ id: "m", fromId: "user", fromName: "user", text, priority: false, receivedAt: "" }],
        new AbortController().signal,
        { client, registry, bus, box: undefined, resolution: undefined, usage }
      );
    }
    // The failure this guards against is the mirror of the one above: an id so stable it
    // groups everything, which reports as one enormous piece of work that never ends.
    const distinct = new Set(usage.since(0, 1000).map(row => row.workId));
    assert.equal(distinct.size, 2, "two separate asks are two pieces of work");
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("a continuation keeps the memory selection made for the request", async () => {
  // Audit 2026-09-01 #6: the initial assembly asked the selector which memories bear on the
  // request, and a continuation rebuilt the volatile block with a plain score-based recall,
  // discarding the answer. The selector's choice is against *this* request; it holds for the
  // request's continuation.
  const { registry, cleanup } = fixture();
  const previousRounds = process.env.AGENTBOX_MAX_ROUNDS;
  try {
    process.env.AGENTBOX_MAX_ROUNDS = "2";
    const ada = registry.create({ name: "Ada" });
    // Well over the 4,000-character budget, so something must be dropped and the selector is asked.
    // FACT-1 is the oldest, so the score-based order drops it first.
    registry.appendMemoryRecords(
      ada.id,
      Array.from({ length: 12 }, (_, index) => ({
        at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        kind: "fact" as const,
        text: `FACT-${index + 1} ${"detail ".repeat(60)}`,
      }))
    );
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        message([toolUseBlock("bash", { command: `echo t${index}` }, `t${index}`)], "tool_use"),
      { capture, create: () => message([textBlock("a summary")]) }
    );
    let asked = 0;
    await runTurn(
      ada,
      [{ id: "m-test", fromId: "user", fromName: "user", text: "keep going", priority: false, receivedAt: "" }],
      new AbortController().signal,
      {
        client,
        registry,
        bus,
        box,
        resolution: undefined,
        selectMemory: async prompt => {
          asked += 1;
          const line = prompt.split("\n").find(candidate => candidate.includes("FACT-1 "));
          const number = /^(\d+)\./.exec(line ?? "")?.[1];
          return `{"selected": [${number}]}`;
        },
      }
    ).catch(() => {
      // Ends at the continuation budget; the assertions are about the requests.
    });

    assert.equal(asked, 1, "the selector is consulted once, at turn start");
    const sizes = capture.params.map(params => params.messages.length);
    assert.ok(sizes.some((size, index) => index > 0 && size < sizes[index - 1]!), "a continuation ran");
    const systemText = (params: (typeof capture.params)[number]) =>
      (Array.isArray(params.system) ? params.system : [{ text: params.system ?? "" }])
        .map(block => (block as { text: string }).text)
        .join("\n");
    for (const [index, params] of capture.params.entries()) {
      assert.ok(systemText(params).includes("FACT-1 "), `request ${index} carries the selected memory`);
    }
  } finally {
    if (previousRounds === undefined) delete process.env.AGENTBOX_MAX_ROUNDS;
    else process.env.AGENTBOX_MAX_ROUNDS = previousRounds;
    cleanup();
  }
});

test("auto-review in shadow mode records a verdict and changes nothing; enforce hands BLOCK to the model", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const reviewed: { tool: string; trusted: readonly string[]; untrusted: readonly string[] }[] = [];
    const reviewer = (mode: "shadow" | "enforce") => ({
      mode: () => mode,
      review: async (input: { tool: string; trusted: readonly string[]; untrusted: readonly string[] }) => {
        reviewed.push(input);
        return { verdict: "BLOCK" as const, reason: "nobody asked for a push" };
      },
    });
    const run = (mode: "shadow" | "enforce", capture: Capture) =>
      runTurn(
        ada,
        [{ id: `m-${mode}`, fromId: "user", fromName: "user", text: "tidy the repo", priority: false, receivedAt: "" }],
        new AbortController().signal,
        {
          client: fakeModel(
            ({ index }) =>
              index === 0
                ? message(
                    [textBlock("Pushing now."), toolUseBlock("bash", { command: "git push origin main" }, "t1")],
                    "tool_use"
                  )
                : message([textBlock("done")]),
            { capture }
          ),
          registry,
          bus,
          box,
          resolution: undefined,
          autoReview: reviewer(mode),
        }
      );

    const shadow: Capture = { params: [] };
    await run("shadow", shadow);
    assert.equal(reviewed.length, 1);
    assert.deepEqual(reviewed[0]?.trusted, ["tidy the repo"]);
    assert.deepEqual(reviewed[0]?.untrusted, ["Pushing now."], "the agent's own words are untrusted");
    const pushed = calls.filter(call => call.kind === "exec" && String(call.detail).includes("git push"));
    assert.equal(pushed.length, 1, "shadow mode still ran the command");

    const enforce: Capture = { params: [] };
    await run("enforce", enforce);
    assert.equal(reviewed.length, 2);
    assert.equal(
      calls.filter(call => call.kind === "exec" && String(call.detail).includes("git push")).length,
      1,
      "enforce mode did not run it"
    );
    const second = enforce.params[1]?.messages.at(-1)?.content;
    const result = Array.isArray(second) ? (second[0] as { content?: string; is_error?: boolean }) : undefined;
    assert.equal(result?.is_error, true);
    assert.match(JSON.stringify(result?.content), /Auto-review refused this call: nobody asked for a push/);
  } finally {
    cleanup();
  }
});

test("hooks in Claude Code's dialect: PreToolUse blocks a call, Stop sends the model back once", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box, calls } = stubBox();
    const hooks = new HookRunner({
      path: null,
      config: {
        PreToolUse: [
          {
            matcher: "bash",
            hooks: [{ type: "command", command: `input=$(cat); case "$input" in *"rm -rf"*) echo "not on my watch" >&2; exit 2;; esac; exit 0` }],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `input=$(cat); case "$input" in *'"stop_hook_active":true'*) exit 0;; esac; echo '{"decision":"block","reason":"also say goodbye"}'`,
              },
            ],
          },
        ],
      },
    });
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        index === 0
          ? message([toolUseBlock("bash", { command: "rm -rf /tmp/scratch" }, "t1"), toolUseBlock("bash", { command: "ls" }, "t2")], "tool_use")
          : index === 1
            ? message([textBlock("done")])
            : message([textBlock("goodbye")]),
      { capture }
    );
    await runTurn(
      ada,
      [{ id: "m-hooks", fromId: "user", fromName: "user", text: "clean up", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, hooks }
    );

    const ran = calls.filter(call => call.kind === "exec").map(call => String(call.detail));
    assert.deepEqual(ran, ["ls"], "the blocked command never reached the box; the other ran");
    const results = capture.params[1]?.messages.at(-1)?.content;
    assert.match(JSON.stringify(results), /Blocked by a PreToolUse hook: not on my watch/);

    // The Stop hook sent the model back once with its reason as the next message, then let it stop.
    assert.equal(capture.params.length, 3);
    assert.match(JSON.stringify(capture.params[2]?.messages.at(-1)?.content), /\[Stop hook\] also say goodbye/);
    const said = (registry.readTranscript(ada.id) as { role: string; text?: string }[])
      .filter(entry => entry.role === "assistant" && typeof entry.text === "string")
      .map(entry => entry.text);
    assert.deepEqual(said.slice(-2), ["done", "goodbye"]);
  } finally {
    cleanup();
  }
});

test("steering is left queued while the model is finishing: a Stop hook's send-back does not absorb it (R8)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const hooks = new HookRunner({
      path: null,
      config: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                // Sends the model back once, and while doing so the user speaks.
                command: `input=$(cat); case "$input" in *'"stop_hook_active":true'*) exit 0;; esac; echo '{"decision":"block","reason":"also say goodbye"}'`,
              },
            ],
          },
        ],
      },
    });
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) => {
        if (index === 0) {
          // The user's follow-up lands while the model is producing its final text.
          bus.sendFromUser(ada.id, "one more thing: rename it");
          return message([textBlock("done")]);
        }
        return message([textBlock("goodbye")]);
      },
      { capture }
    );
    await runTurn(
      ada,
      [{ id: "m-fin", fromId: "user", fromName: "user", text: "wrap up", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, hooks }
    );

    // Round 2 carried the hook's note and nothing else: the follow-up was not injected on a
    // loop that was stopping.
    assert.equal(capture.params.length, 2);
    const second = JSON.stringify(capture.params[1]?.messages ?? []);
    assert.match(second, /\[Stop hook\] also say goodbye/);
    assert.doesNotMatch(second, /rename it/);
    // It is still queued, and opens the next turn instead.
    assert.equal(bus.pendingCount(ada.id), 1);
  } finally {
    cleanup();
  }
});

// ── docs/31 layer 1: the engine minds the person ───────────────────────────────────────

test("reads asked for together run together; a shell call between them runs alone; results keep the model's order (docs/31 1c)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const timeline: { name: string; at: number }[] = [];
    const t0 = Date.now();
    const box = {
      readFile: async (path: string) => {
        timeline.push({ name: `read ${path}`, at: Date.now() - t0 });
        await new Promise(resolve => setTimeout(resolve, 80));
        return { content: `contents of ${path}` };
      },
      exec: async (command: string) => {
        timeline.push({ name: `exec ${command}`, at: Date.now() - t0 });
        await new Promise(resolve => setTimeout(resolve, 20));
        return { stdout: "ran", stderr: "", exit_code: 0, timed_out: false };
      },
    } as unknown as BoxClient;
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        index === 0
          ? message(
              [
                toolUseBlock("read_file", { path: "/a" }, "r1"),
                toolUseBlock("read_file", { path: "/b" }, "r2"),
                toolUseBlock("read_file", { path: "/c" }, "r3"),
                toolUseBlock("bash", { command: "touch x" }, "s1"),
                toolUseBlock("read_file", { path: "/d" }, "r4"),
              ],
              "tool_use"
            )
          : message([textBlock("read them all")]),
      { capture }
    );
    const started = Date.now();
    await runTurn(
      ada,
      [{ id: "m-par", fromId: "user", fromName: "user", text: "read a, b, c, then d", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined }
    );
    const elapsed = Date.now() - started;
    // Three reads in parallel (~80ms), then the shell (~20ms), then one read (~80ms): well
    // under the ~340ms a serial loop would take.
    assert.ok(elapsed < 300, `took ${elapsed}ms; a serial loop would take ~340ms`);
    // The shell ran only after the first three reads had all *started*, and /d only after
    // the shell finished.
    const startOf = (name: string) => timeline.find(entry => entry.name === name)!.at;
    assert.ok(startOf("exec touch x") >= Math.max(startOf("read /a"), startOf("read /b"), startOf("read /c")));
    assert.ok(startOf("read /d") >= startOf("exec touch x") + 20);
    // Results come back in the order the model asked, regardless of finish order.
    const results = capture.params[1]?.messages.at(-1)?.content as { tool_use_id: string }[];
    assert.deepEqual(results.map(block => block.tool_use_id), ["r1", "r2", "r3", "s1", "r4"]);
  } finally {
    cleanup();
  }
});

test("the opening line beside the first tool calls is handed to the chat once, and stays out of the reply (docs/31 1a)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const events: { type: string; text?: string }[] = [];
    const client = fakeModel(({ index }) =>
      index === 0
        ? message([textBlock("你说得对，我先查一下。"), toolUseBlock("bash", { command: "ls" }, "t1")], "tool_use")
        : index === 1
          ? message([textBlock("还在查。"), toolUseBlock("bash", { command: "ls -a" }, "t2")], "tool_use")
          : message([textBlock("查到了：两个都在 8 月 14 日发布。")])
    );
    await runTurn(
      ada,
      [{ id: "m-int", fromId: "user", fromName: "user", text: "GLM-5.3 和 Qwen3.8-27B 是新发布的吧", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, onEvent: event => events.push(event as { type: string; text?: string }) }
    );
    const interim = events.filter(event => event.type === "interim");
    assert.deepEqual(interim.map(event => event.text), ["你说得对，我先查一下。"], "once, and only the opening line");
    // The final reply is the last plain entry only; the opening line is not repeated in it.
    const said = (registry.readTranscript(ada.id) as { role: string; kind?: string; text?: string }[])
      .filter(entry => entry.role === "assistant" && entry.kind === undefined)
      .map(entry => entry.text);
    assert.deepEqual(said, ["查到了：两个都在 8 月 14 日发布。"]);
  } finally {
    cleanup();
  }
});

test("a hidden wake gets no interim line: nobody is waiting on a scheduled run (docs/31 1a)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const events: { type: string }[] = [];
    const client = fakeModel(({ index }) =>
      index === 0
        ? message([textBlock("looking"), toolUseBlock("bash", { command: "ls" }, "t1")], "tool_use")
        : message([textBlock("done")])
    );
    await runTurn(
      ada,
      [{ id: "m-peer", fromId: bob.id, fromName: "Bob", text: "please check the build", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, onEvent: event => events.push(event) }
    );
    assert.equal(events.filter(event => event.type === "interim").length, 0);
  } finally {
    cleanup();
  }
});

const MINIMAX_PROFILE = {
  label: "test-minimax",
  model: "MiniMax-M3",
  maxTokens: 32_000,
  vision: true,
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer" as const,
  keyEnv: "TEST_KEY",
};

test("a verdict from memory on a turn with no tool call is sent back once with a forced tool call; the verdict is not the reply (docs/31 1e)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        index === 0
          ? message([textBlock("Qwen 没有 27B，GLM 目前公开到 4.x，没有 5.3-flash。")])
          : index === 1
            ? message([textBlock("我先查一下。"), toolUseBlock("bash", { command: "curl example" }, "t1")], "tool_use")
            : message([textBlock("查到了：两个都在 2026 年 8 月 14 日发布。")]),
      { capture }
    );
    await runTurn(
      ada,
      [{ id: "m-guard", fromId: "user", fromName: "user", text: "qwen-27B 或 glm-5.3-flash 为基座，详细介绍一下", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, provider: MINIMAX_PROFILE }
    );
    // Round 1 carried the nudge and demanded a tool call; the nudge itself is not on the record.
    const second = capture.params[1]!;
    assert.deepEqual(second.tool_choice, { type: "any" });
    assert.match(JSON.stringify(second.messages.at(-1)?.content), /\[harness\].*先用工具/);
    assert.equal(capture.params[2]?.tool_choice, undefined, "the demand is spent after one round");
    const transcript = registry.readTranscript(ada.id) as { role: string; kind?: string; text?: string }[];
    assert.ok(!JSON.stringify(transcript).includes("[harness]"), "the nudge is not in the durable record");
    // The verdict is on the record as blocks, not as a reply; the reply is the checked answer only.
    const replies = transcript.filter(entry => entry.role === "assistant" && entry.kind === undefined).map(entry => entry.text);
    assert.deepEqual(replies, ["查到了：两个都在 2026 年 8 月 14 日发布。"]);
    assert.ok(transcript.some(entry => entry.role === "assistant" && entry.kind === "blocks" && JSON.stringify(entry).includes("没有 27B")));
    // And the person's message carried the reminder for this model family, in Chinese.
    const opening = JSON.stringify(capture.params[0]?.messages.at(-1)?.content);
    assert.match(opening, /<system_reminder>/);
    assert.match(opening, /先查再说/);
  } finally {
    cleanup();
  }
});

test("a ruling after a tool ran is the model's to make; the guards are bounded and switchable (docs/31 1e)", async () => {
  const { registry, cleanup } = fixture();
  const previous = process.env.AGENTBOX_GUARDS;
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    // After a search, "does not exist" is a finding, not a guess.
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        index === 0
          ? message([toolUseBlock("bash", { command: "search" }, "t1")], "tool_use")
          : message([textBlock("查过了：这个型号不存在，官方页面没有。")]),
      { capture }
    );
    await runTurn(
      ada,
      [{ id: "m-after", fromId: "user", fromName: "user", text: "Zephyrus QX-880 是真的吗", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, provider: MINIMAX_PROFILE }
    );
    assert.equal(capture.params.length, 2, "no send-back after evidence");

    // A model that keeps offering is sent back twice and then let go.
    const bob = registry.create({ name: "Bob" });
    const stubborn: Capture = { params: [] };
    const offers = fakeModel(() => message([textBlock("要不要我现在去查一下？")]), { capture: stubborn });
    await runTurn(
      bob,
      [{ id: "m-stub", fromId: "user", fromName: "user", text: "GLM-5.3 发布了吗", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client: offers, registry, bus, box, resolution: undefined, provider: MINIMAX_PROFILE }
    );
    assert.equal(stubborn.params.length, 3, "two nudges, then the answer goes out as is");
    const bobSaid = (registry.readTranscript(bob.id) as { role: string; kind?: string; text?: string }[])
      .filter(entry => entry.role === "assistant" && entry.kind === undefined);
    assert.equal(bobSaid.length, 1, "the third answer is delivered, flagged in the log");

    // Switched off, the same model ends on round 0.
    process.env.AGENTBOX_GUARDS = "0";
    const vic = registry.create({ name: "Vic" });
    const off: Capture = { params: [] };
    await runTurn(
      vic,
      [{ id: "m-off", fromId: "user", fromName: "user", text: "GLM-5.3 发布了吗", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client: fakeModel(() => message([textBlock("要不要我现在去查一下？")]), { capture: off }), registry, bus, box, resolution: undefined, provider: MINIMAX_PROFILE }
    );
    assert.equal(off.params.length, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_GUARDS;
    else process.env.AGENTBOX_GUARDS = previous;
    cleanup();
  }
});

test("acknowledged, ran tools, ended silent: one closing nudge, then the result (docs/31 1b)", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const { box } = stubBox();
    const capture: Capture = { params: [] };
    const client = fakeModel(
      ({ index }) =>
        index === 0
          ? message([textBlock("收到，我看一下。"), toolUseBlock("bash", { command: "ls" }, "t1")], "tool_use")
          : index === 1
            ? message([])
            : message([textBlock("看完了：三个文件，没有问题。")]),
      { capture }
    );
    await runTurn(
      ada,
      [{ id: "m-close", fromId: "user", fromName: "user", text: "看一下目录", priority: false, receivedAt: "" }],
      new AbortController().signal,
      { client, registry, bus, box, resolution: undefined, provider: MINIMAX_PROFILE }
    );
    assert.equal(capture.params.length, 3);
    assert.match(JSON.stringify(capture.params[2]?.messages.at(-1)?.content), /\[harness\].*把结果告诉他们/);
    const said = (registry.readTranscript(ada.id) as { role: string; kind?: string; text?: string }[])
      .filter(entry => entry.role === "assistant" && entry.kind === undefined)
      .map(entry => entry.text);
    assert.deepEqual(said, ["看完了：三个文件，没有问题。"]);
  } finally {
    cleanup();
  }
});
