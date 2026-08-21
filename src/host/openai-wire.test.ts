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
