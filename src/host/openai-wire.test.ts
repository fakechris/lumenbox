/**
 * Tests for the OpenAI-compatible wire.
 *
 * The contract under test is the one the turn engine relies on: an Anthropic-shaped
 * request goes in, an Anthropic-shaped message comes out, and the stream shim fires
 * `streamEvent` for every kind of progress (the first-token deadline depends on it)
 * and `text` only for prose. The stream test runs against a real local HTTP server
 * speaking SSE, because the frame-splitting is exactly the part a mocked fetch
 * cannot get wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { OpenAIWireClient, fromOpenAIResponse, toOpenAIRequest } from "./openai-wire.ts";
import { priceOf, summariseSpend } from "./spend.ts";

test("a full conversation round-trips: system, tools, tool results, screenshots", () => {
  const request = toOpenAIRequest({
    model: "gpt-5.1",
    max_tokens: 1000,
    system: [{ type: "text", text: "You are Ada." }] as Anthropic.TextBlockParam[],
    tools: [
      {
        name: "bash",
        description: "Run a command.",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ] as Anthropic.Tool[],
    messages: [
      { role: "user", content: "List the files." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Listing now." },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "a.txt b.txt" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/webp", data: "AAAA" },
              },
            ],
            is_error: false,
          },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);

  assert.equal(request.messages[0]!.role, "system");
  assert.equal(request.messages[0]!.content, "You are Ada.");

  const assistant = request.messages[2]!;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "Listing now.");
  assert.equal(assistant.tool_calls?.[0]?.function.name, "bash");
  assert.equal(assistant.tool_calls?.[0]?.function.arguments, '{"command":"ls"}');

  // The tool result becomes a tool message; its screenshot follows as a user message,
  // because chat completions tool messages carry text only.
  const toolMessage = request.messages[3]!;
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "call_1");
  assert.equal(toolMessage.content, "a.txt b.txt");
  const imageMessage = request.messages[4]!;
  assert.equal(imageMessage.role, "user");
  assert.ok(Array.isArray(imageMessage.content));
  const parts = imageMessage.content as { type: string; image_url?: { url: string } }[];
  assert.ok(parts.some(part => part.image_url?.url.startsWith("data:image/webp;base64,")));

  assert.equal(request.tools?.[0]?.function !== undefined, true);
});

test("a failed tool result says so in the text, since is_error has no wire equivalent", () => {
  const request = toOpenAIRequest({
    model: "m",
    max_tokens: 10,
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);
  assert.match(String(request.messages[0]!.content), /boom\n\[This tool call failed\.\]/);
});

test("responses map to Anthropic shape: tool calls, finish reasons, usage", () => {
  const message = fromOpenAIResponse({
    id: "chatcmpl-1",
    model: "gpt-5.1",
    choices: [
      {
        message: {
          content: "Running it.",
          tool_calls: [
            {
              id: "call_9",
              type: "function",
              function: { name: "bash", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 34 },
  });

  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.input_tokens, 120);
  assert.equal(message.usage.output_tokens, 34);
  const [text, call] = message.content;
  assert.equal(text?.type, "text");
  assert.equal(call?.type, "tool_use");
  assert.deepEqual((call as Anthropic.ToolUseBlock).input, { command: "pwd" });

  // Malformed arguments become an empty call the tool rejects readably, not a crash.
  const broken = fromOpenAIResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "c", type: "function", function: { name: "bash", arguments: "{oops" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  assert.deepEqual((broken.content[0] as Anthropic.ToolUseBlock).input, {});

  assert.equal(
    fromOpenAIResponse({ choices: [{ message: { content: "x" }, finish_reason: "length" }] })
      .stop_reason,
    "max_tokens"
  );
});

test("only verified OpenAI cached_tokens is subtracted from inclusive prompt_tokens", () => {
  const response = { usage: { prompt_tokens: 100, completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 40 } } };
  const direct = fromOpenAIResponse(response, { officialOpenAI: true });
  const compatible = fromOpenAIResponse(response);
  assert.equal(direct.usage.input_tokens, 60);
  assert.equal(direct.usage.cache_read_input_tokens, 40);
  assert.equal(direct.usage.cache_creation_input_tokens, 0);
  assert.equal((direct.usage as { metering?: string }).metering, "complete");
  assert.equal(direct.usage.input_tokens + (direct.usage.cache_read_input_tokens ?? 0), 100);
  assert.equal((compatible.usage as { metering?: string }).metering, "cache_unknown");
  assert.equal(compatible.usage.cache_read_input_tokens, null);

  const money = priceOf({ model: "test", inputTokens: 60, outputTokens: 7,
    cacheReadTokens: 40, cacheWriteTokens: 0, metering: "complete" },
  { test: { inputPerM: 2, cacheReadPerM: .2, cacheWritePerM: 3, outputPerM: 4 } });
  assert.equal(money, (60 * 2 + 40 * .2 + 7 * 4) / 1e6);
});

test("absent, conflicting and unsupported provider metering withhold money", () => {
  const samples = [
    [undefined, "missing"],
    [{ prompt_tokens: 1, completion_tokens: 2 }, "cache_unknown"],
    [{ prompt_tokens: 2, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 3 } }, "invalid"],
    [{ prompt_tokens: -1, completion_tokens: 3 }, "invalid"],
  ] as const;
  for (const [usage, expected] of samples) {
    const parsed = fromOpenAIResponse({ usage }, { officialOpenAI: true });
    assert.equal((parsed.usage as { metering?: string }).metering, expected);
    const row = { seq: 1, at: "2026-09-29T00:00:00Z", agentId: "a", agentName: "a",
      provider: "openai", model: "test", round: 0, inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens, cacheReadTokens: parsed.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? 0,
      metering: expected as "missing" | "invalid" | "cache_unknown" };
    const report = summariseSpend([row], { rates: { test: { inputPerM: 2, outputPerM: 4 } } });
    assert.equal(report.money, undefined);
    assert.equal(report.unmeasured[0]?.status, expected);
  }
  const oldRow = { seq: 0, at: "2026-09-29T00:00:00Z", agentId: "a", agentName: "a",
    provider: "old", model: "test", round: 0, inputTokens: 1, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(summariseSpend([oldRow], { rates: { test: { inputPerM: 2, outputPerM: 4 } } }).money, 2 / 1e6);
});

test("SSE tail usage wins after choices; missing tail never means a free call", async () => {
  const original = globalThis.fetch;
  try {
    for (const tail of [
      { usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }, expected: "complete" },
      { usage: undefined, expected: "missing" },
    ]) {
      globalThis.fetch = async () => new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
        (tail.usage ? `data: ${JSON.stringify({ choices: [], usage: tail.usage })}\n\n` : "") +
        "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
      const wire = new OpenAIWireClient({ baseURL: "https://api.openai.com/v1" });
      const message = await wire.messages.stream({ model: "m", max_tokens: 10,
        messages: [{ role: "user", content: "hi" }] } as Anthropic.MessageCreateParamsNonStreaming).finalMessage();
      assert.equal((message.usage as { metering?: string }).metering, tail.expected);
      if (tail.usage) {
        assert.equal(message.usage.input_tokens, 6);
        assert.equal(message.usage.cache_read_input_tokens, 4);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("the stream shim assembles deltas and fires the engine's progress signals", async () => {
  // A real SSE server, frame boundaries split awkwardly on purpose.
  const frames = [
    'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const push = () => {
      if (i >= frames.length) {
        res.end();
        return;
      }
      res.write(frames[i]);
      i += 1;
      setTimeout(push, 5);
    };
    push();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new OpenAIWireClient({
      baseURL: `http://127.0.0.1:${port}`,
      key: "k",
    });
    const stream = client.messages.stream({
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textDeltas: string[] = [];
    let progressEvents = 0;
    stream.on("text", (delta: string) => textDeltas.push(delta));
    stream.on("streamEvent", () => {
      progressEvents += 1;
    });

    const message = await stream.finalMessage();
    assert.equal(textDeltas.join(""), "Hello");
    // Progress fired for the tool-call fragments too — a round that is entirely tool
    // calls must not read as a first-token stall.
    assert.ok(progressEvents >= 4, `saw ${progressEvents}`);
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(message.usage.input_tokens, 7);
    const call = message.content.find(block => block.type === "tool_use");
    assert.deepEqual((call as Anthropic.ToolUseBlock).input, { command: "ls" });
  } finally {
    server.close();
  }
});

test("a vendor error arrives with the status and the vendor's own words", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":{"message":"Incorrect API key provided"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OpenAIWireClient({ baseURL: `http://127.0.0.1:${port}`, key: "bad" });
    await assert.rejects(
      client.messages.create({
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      } as Anthropic.MessageCreateParamsNonStreaming),
      /401.*Incorrect API key/s
    );
  } finally {
    server.close();
  }
});

test("tool_choice crosses the wire: any is required, a named tool is a function reference (docs/31 1d)", () => {
  const base = {
    model: "MiniMax-M3",
    max_tokens: 100,
    messages: [{ role: "user" as const, content: "check it" }],
    tools: [
      { name: "WebSearch", description: "Search.", input_schema: { type: "object", properties: {} } },
    ] as Anthropic.Tool[],
  };
  assert.equal(toOpenAIRequest(base).tool_choice, undefined, "absent stays absent");
  assert.equal(toOpenAIRequest({ ...base, tool_choice: { type: "any" } }).tool_choice, "required");
  assert.deepEqual(toOpenAIRequest({ ...base, tool_choice: { type: "tool", name: "WebSearch" } }).tool_choice, {
    type: "function",
    function: { name: "WebSearch" },
  });
  assert.equal(toOpenAIRequest({ ...base, tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(toOpenAIRequest({ ...base, tool_choice: { type: "none" } }).tool_choice, "none");
});
