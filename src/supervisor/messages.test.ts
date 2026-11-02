/** The supervisor on any configured provider (INV-1528): the Messages adapter, and a whole run on an Anthropic-style client. */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { TaskStore } from "../host/tasks.ts";
import { doorClient } from "../watchdog/client.ts";
import { handleMcpRequest, mintMcpToken, principalForToken } from "../web/mcp-server.ts";
import { mcpServerTools } from "../web/mcp-tools.ts";
import { ChangeFeed } from "../web/mcp-watch.ts";
import { Supervisor } from "./loop.ts";
import { messagesAdapter } from "./messages.ts";
import { supervisorModel, usesResponses } from "./models.ts";

type Request = { system: string; messages: { role: string; content: { type: string; tool_use_id?: string; content?: string; text?: string }[] }[]; tools: { name: string }[] };

function fakeClient(replies: ((request: Request) => { content: unknown[] })[]) {
  const requests: Request[] = [];
  let n = 0;
  return {
    requests,
    client: { messages: { create: async (request: Request) => { requests.push(JSON.parse(JSON.stringify(request))); const reply = replies[n++]!(request); return { id: `msg_${n}`, ...reply, usage: { input_tokens: 50, output_tokens: 5 } }; } } } as never,
  };
}

test("tool use comes back as calls, results go back as tool_result blocks, and the conversation carries over", async () => {
  const { client, requests } = fakeClient([
    () => ({ content: [{ type: "text", text: "Starting." }, { type: "tool_use", id: "tu_1", name: "goal_start", input: { objective: "x" } }] }),
    () => ({ content: [{ type: "text", text: "Done." }] }),
  ]);
  const ask = messagesAdapter(client, "claude-x");
  const first = await ask({ instructions: "be brief", input: [{ role: "user", content: "start" }], tools: [{ name: "goal_start", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.deepEqual(first.calls, [{ callId: "tu_1", name: "goal_start", arguments: { objective: "x" } }]);
  assert.equal(first.text, "Starting.");
  const second = await ask({ instructions: "be brief", input: [{ type: "function_call_output", call_id: "tu_1", output: "t1 started" }], tools: [] });
  assert.equal(second.text, "Done.");
  assert.equal(requests[1]!.messages.length, 3, "user, assistant, user: the whole conversation is sent");
  assert.deepEqual(requests[1]!.messages[2]!.content[0], { type: "tool_result", tool_use_id: "tu_1", content: "t1 started" });
  assert.equal(requests[0]!.system, "be brief");
});

test("which endpoint a choice uses, and a missing key or unknown provider said plainly", () => {
  assert.equal(usesResponses({ baseUrl: "https://api.openai.com/v1" }, "gpt-6.1-sol"), true);
  assert.equal(usesResponses({ baseUrl: "https://api.openai.com/v1" }, "gpt-5.1"), false, "older OpenAI models keep Chat Completions through the wire translation");
  assert.equal(usesResponses({ baseUrl: "https://openrouter.ai/api/v1" }, "gpt-6.1-sol"), false);
  assert.deepEqual(supervisorModel({ provider: "nope", model: "x" }, () => "k"), { error: "no provider named nope" });
  const missing = supervisorModel({ provider: "anthropic", model: "claude-x" }, () => undefined);
  assert.ok("error" in missing && /no key for Anthropic \(ANTHROPIC_API_KEY\); set it in Settings → Model/.test(missing.error));
  assert.ok("ask" in supervisorModel({ provider: "openai", model: "gpt-6.1-sol" }, () => "sk-test"), "OpenAI's own endpoint with a gpt-6 model: Responses");
});

test("a whole supervised run on an Anthropic-style model: start the goal, stay quiet, end when it completes", async () => {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const token = mintMcpToken("p1", "supervisor");
  const agent = { id: "a1", profile: { name: "Ada" } };
  const tools = mcpServerTools({
    registry: { tryGet: () => agent, resolve: () => agent, list: () => [agent], contextMode: () => "normal" } as never,
    orchestrator: { tasks: board, contextBlockers: () => [], prompt: async () => {}, ensureDefaultAgent: () => agent } as never,
    principals: { resolve: id => ({ name: id }) }, workDir: "/w", log: () => {}, listen: () => () => {}, mayDrive: () => true, changeFeed: feed,
  });
  const server: Server = createServer((req, res) => void handleMcpRequest(req, res, { tools, principalFor: presented => principalForToken(presented, [token]), log: () => {} }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    let goalId = "";
    const { client } = fakeClient([
      request => ({ content: [{ type: "tool_use", id: "tu_1", name: "goal_start", input: { objective: request.messages[0]!.content[0]!.text ?? "" } }] }),
      request => {
        goalId = /^(t\d+)/.exec(request.messages.at(-1)!.content[0]!.content ?? "")?.[1] ?? "";
        setTimeout(() => board.setPursuit(goalId, p => ({ ...p, status: "complete" }), "verified"), 30);
        return { content: [{ type: "text", text: "Started." }] };
      },
    ]);
    const supervisor = new Supervisor({ door: doorClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, token.token), ask: messagesAdapter(client, "claude-x"), record: () => {}, log: () => {}, runId: "m1", watchSeconds: 1 });
    const result = await supervisor.run("Ship the digest");
    assert.deepEqual([result.outcome, result.goalId, result.modelCalls], ["completed", goalId, 2]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
