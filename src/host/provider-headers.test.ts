/**
 * What every model request says about itself, read off the wire (INV-2325).
 *
 * OpenCode Go asks a client to name itself in its User-Agent rather than as an SDK, and to send a
 * stable `x-opencode-session` per conversation. These requests go to a local server that records
 * the headers it is sent: every kind of client (x-api-key, bearer, the OpenAI translation), create
 * and stream, the User-Agent saved in Settings, and the session — only to Go, the same throughout a
 * conversation and across a restart, different between conversations, and naming nobody.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { buildInfo } from "./build-info.ts";
import { withModelSession, sessionIdOf } from "./model-session.ts";
import { clientUserAgent, createClient, defaultUserAgent, PRESET_MODELS, providerNames, resolveProviderPreset, userAgentProblem, type ProviderProfile } from "./provider.ts";

const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const ANTHROPIC_STREAM = [
  ["message_start", { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const OPENAI_REPLY = { id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const OPENAI_STREAM = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;

/** A model endpoint on loopback that answers both wires and keeps every request's headers. */
async function endpoint(): Promise<{ base: string; seen: IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push(req.headers);
      const streaming = (JSON.parse(body || "{}") as { stream?: boolean }).stream === true;
      const openai = req.url?.endsWith("/chat/completions") === true;
      res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
      res.end(streaming ? (openai ? OPENAI_STREAM : ANTHROPIC_STREAM) : JSON.stringify(openai ? OPENAI_REPLY : MESSAGE));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** One create and one stream, as a turn and a summary would make them. */
async function both(profile: ProviderProfile): Promise<void> {
  const client = createClient(profile);
  await client.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
  await client.messages.stream({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }).finalMessage();
}

function preset(name: string, base: string, path = ""): ProviderProfile {
  return { ...resolveProviderPreset(name)!, baseUrl: `${base}${path}` };
}

const KEYS = { ANTHROPIC_API_KEY: "k-anthropic", DEEPSEEK_API_KEY: "k-deepseek", OPENAI_API_KEY: "k-openai", OPENCODE_API_KEY: "k-go" };

async function withKeys(run: () => Promise<void>, extra: Record<string, string | undefined> = {}): Promise<void> {
  const saved = Object.fromEntries(Object.keys({ ...KEYS, ...extra, AGENTBOX_USER_AGENT: "" }).map(name => [name, process.env[name]]));
  Object.assign(process.env, KEYS);
  delete process.env.AGENTBOX_USER_AGENT;
  for (const [name, value] of Object.entries(extra)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { await run(); } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test("every client names itself LumenBox/<version>, not its SDK, on create and on stream, whichever wire and key header it uses", async () => {
  const server = await endpoint();
  try {
    await withKeys(async () => {
      for (const profile of [preset("anthropic", server.base), preset("deepseek", server.base), preset("openai", server.base, "/v1"), preset("opencode-go", server.base)]) await both(profile);
    });
    assert.equal(server.seen.length, 8, "four clients, a create and a stream each");
    assert.equal(defaultUserAgent(), `LumenBox/${buildInfo().version}`);
    for (const headers of server.seen) assert.equal(headers["user-agent"], defaultUserAgent(), JSON.stringify(headers));
  } finally {
    await server.close();
  }
});

test("a User-Agent saved in Settings is what the next request says, with no new client; an unusable one falls back to LumenBox's own", async () => {
  const server = await endpoint();
  try {
    await withKeys(async () => {
      const client = createClient(preset("deepseek", server.base));
      const once = () => client.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
      await once();
      process.env.AGENTBOX_USER_AGENT = "acme-agent/2.1";
      await once();
      process.env.AGENTBOX_USER_AGENT = "bad\nvalue";
      await once();
    });
    assert.deepEqual(server.seen.map(headers => headers["user-agent"]), [defaultUserAgent(), "acme-agent/2.1", defaultUserAgent()]);
  } finally {
    await server.close();
  }
  assert.equal(userAgentProblem("acme-agent/2.1 (+https://example.com)"), undefined);
  assert.equal(userAgentProblem("two\nlines"), "not-ascii");
  assert.equal(userAgentProblem("名字"), "not-ascii");
  assert.equal(userAgentProblem("x".repeat(201)), "too-long");
  await withKeys(async () => assert.equal(clientUserAgent(), defaultUserAgent()));
});

test("only Go is sent a session: the same for a conversation's every request and after a restart, another for another conversation, and naming nobody", async () => {
  const server = await endpoint();
  try {
    await withKeys(async () => {
      const go = createClient(preset("opencode-go", server.base));
      const ask = () => go.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
      await withModelSession("agent-ada", "main", async () => { await ask(); await go.messages.stream({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }).finalMessage(); });
      await withModelSession("agent-ada", "feishu-oc_room", ask);
      await ask();
      await ask();
      await both(preset("deepseek", server.base));
    }, { AGENTBOX_HOME: "/tmp/lumenbox-home-a" });
    const sessions = server.seen.map(headers => headers["x-opencode-session"]);
    const [first, second, other, background, backgroundAgain, ...others] = sessions;
    assert.equal(first, second, "the turn's create and stream share the conversation's session");
    assert.equal(first, sessionIdOf("conversation\nagent-ada\nmain"), "the same function in the next process gives the same id");
    assert.notEqual(other, first, "another conversation is another session");
    assert.equal(background, backgroundAgain, "outside a conversation, the installation's one background session");
    assert.notEqual(background, first);
    assert.deepEqual(others, [undefined, undefined], "no other provider is told the session");
    for (const id of [first, other, background]) {
      assert.match(id as string, /^[0-9a-f]{32}$/);
      assert.ok(!/ada|main|feishu|room/i.test(id as string));
    }
  } finally {
    await server.close();
  }
});

test("a turn's context is its model session: what runs inside AgentRegistry.withContext, a summary or a memory pass included, carries that conversation's id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-model-session-"));
  const server = await endpoint();
  try {
    const registry = new AgentRegistry(dir);
    const ada = registry.create({ name: "Ada" });
    await withKeys(async () => {
      const go = createClient(preset("opencode-go", server.base));
      await registry.withContext(ada.id, "main", async () => {
        await go.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "turn" }] });
        await Promise.resolve().then(() => go.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "summary" }] }));
      });
    });
    assert.deepEqual(server.seen.map(headers => headers["x-opencode-session"]), [sessionIdOf(`conversation\n${ada.id}\nmain`), sessionIdOf(`conversation\n${ada.id}\nmain`)]);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode Go is a preset: its own address, a bearer key in OPENCODE_API_KEY, every capability off until measured, and no -free model offered", () => {
  // The name list is what Settings offers and what a save is checked against: a preset missing from it can be neither chosen nor saved.
  assert.ok(providerNames().includes("opencode-go"));
  const go = resolveProviderPreset("opencode-go")!;
  assert.equal(go.baseUrl, "https://opencode.ai/inference/go/anthropic");
  assert.equal(go.auth, "bearer");
  assert.equal(go.keyEnv, "OPENCODE_API_KEY");
  assert.equal(go.sessionHeader, "x-opencode-session");
  assert.deepEqual([go.vision, go.adaptiveThinking, go.effort, go.promptCaching], [false, false, false, false]);
  for (const name of ["anthropic", "minimax", "deepseek", "openai", "openrouter"]) assert.equal(resolveProviderPreset(name)!.sessionHeader, undefined, name);
  assert.ok(PRESET_MODELS["opencode-go"]!.includes(go.model));
  assert.deepEqual(PRESET_MODELS["opencode-go"]!.filter(model => model.endsWith("-free")), [], "Go's free models answer OpenCode alone");
});
