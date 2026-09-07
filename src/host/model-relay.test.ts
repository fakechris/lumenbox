/**
 * The model relay: an engine in the box talks to "its" model, and what actually happens is
 * a per-job route on the host that carries the provider's key. The claims: the box's
 * credential is the route token and nothing else; the provider sees the real key and the
 * request as sent; the stream comes back whole; the usage row exists; a wrong token, a
 * lapsed lease or a path off the allow-list is refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { countUsage, ModelRelay, RELAY_LEASE_MS, RELAY_PATH } from "./model-relay.ts";
import type { ProviderProfile } from "./provider.ts";

const PROFILE: ProviderProfile = {
  label: "Fake Anthropic",
  model: "fake-3",
  maxTokens: 1000,
  vision: false,
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "x-api-key",
  keyEnv: "FAKE_KEY",
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? "POST", headers: options.headers ?? {} }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test("the relay carries the provider's key, streams the answer back, and records the spend", async () => {
  const seenUpstream: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      seenUpstream.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":40}}}\n\n');
      setTimeout(() => {
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":17}}\n\n');
        res.end();
      }, 20);
    });
  });
  const recorded: Record<string, unknown>[] = [];
  const relay = new ModelRelay({
    provider: () => ({ ...PROFILE, baseUrl: `${upstream.url}/anthropic` }),
    key: () => "sk-real-secret",
    usage: () => ({ record: (entry: Record<string, unknown>) => recorded.push(entry) }) as never,
  });
  const host = await listen((req, res) => {
    const match = RELAY_PATH.exec(req.url ?? "");
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    const route = relay.authenticate(match[1]!, req.headers);
    if (route === undefined) {
      res.writeHead(401).end();
      return;
    }
    void relay.proxy(req, res, route, match[2] ?? "/");
  });
  try {
    relay.baseUrl = host.url;
    const minted = relay.mint({ agentId: "a1", agentName: "Ada", conversation: "main", workId: "w1", preset: "claude" });
    assert.ok("route" in minted);
    const { route, url } = minted;
    assert.match(url, /\/relay\/[0-9a-f]{32}$/);

    // The engine, speaking Anthropic's wire with the route token where a key would go.
    const answer = await call(`${url}/v1/messages`, {
      headers: { "content-type": "application/json", "x-api-key": route.token, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "fake-3-large", stream: true, messages: [] }),
    });
    assert.equal(answer.status, 200);
    assert.match(answer.body, /message_start/);
    assert.match(answer.body, /output_tokens":17/);
    assert.equal(answer.headers["content-type"], "text/event-stream");

    // The provider saw its own key, the path under its base URL, and the body as sent.
    assert.equal(seenUpstream.length, 1);
    assert.equal(seenUpstream[0]!.path, "/anthropic/v1/messages");
    assert.equal(seenUpstream[0]!.headers["x-api-key"], "sk-real-secret");
    assert.equal(seenUpstream[0]!.headers.authorization, undefined);
    assert.equal(seenUpstream[0]!.headers["anthropic-version"], "2023-06-01");
    assert.match(seenUpstream[0]!.body, /fake-3-large/);

    // The spend is a row with the agent, the work and the model on it.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.kind, "delegate");
    assert.equal(recorded[0]!.agentId, "a1");
    assert.equal(recorded[0]!.workId, "w1");
    assert.equal(recorded[0]!.model, "fake-3-large");
    assert.equal(recorded[0]!.inputTokens, 120);
    assert.equal(recorded[0]!.outputTokens, 17);
    assert.equal(recorded[0]!.cacheReadTokens, 40);

    // Wrong token, and a path the engine has no business with.
    assert.equal((await call(`${url}/v1/messages`, { headers: { "x-api-key": "nope" }, body: "{}" })).status, 401);
    assert.equal((await call(`${url}/v1/admin/keys`, { headers: { authorization: `Bearer ${route.token}` }, body: "{}" })).status, 404);
    // A bearer works too, for engines that send one.
    assert.equal((await call(`${url}/v1/messages`, { headers: { authorization: `Bearer ${route.token}` }, body: "{}" })).status, 200);
  } finally {
    host.close();
    upstream.close();
  }
});

test("a route lapses without traffic and is kept alive by it; the ceiling is absolute", () => {
  let now = 1_000_000;
  const relay = new ModelRelay({ provider: () => PROFILE, key: () => "k", now: () => now });
  relay.baseUrl = "http://host";
  const minted = relay.mint({ agentId: "a", agentName: "A", conversation: "main", preset: "pi" });
  assert.ok("route" in minted);
  const { route } = minted;
  const headers = { authorization: `Bearer ${route.token}` };
  now += RELAY_LEASE_MS - 1;
  assert.ok(relay.authenticate(route.key, headers), "used just inside the lease");
  now += RELAY_LEASE_MS - 1;
  assert.ok(relay.authenticate(route.key, headers), "the use renewed it");
  now += RELAY_LEASE_MS + 1;
  assert.equal(relay.authenticate(route.key, headers), undefined, "idle past the lease");
  assert.equal(relay.active().length, 0, "and gone");

  const again = relay.mint({ agentId: "a", agentName: "A", conversation: "main", preset: "pi" });
  assert.ok("route" in again);
  assert.equal(relay.mint({ agentId: "a", agentName: "A", conversation: "main", preset: "pi" }) !== undefined, true);
  assert.equal(relay.sweep(), 0);
  now += 13 * 60 * 60_000;
  assert.equal(relay.sweep(), 2, "the ceiling ends a route however busy it was");
});

test("no key on the host means no route, said at mint rather than at the engine's first call", () => {
  const relay = new ModelRelay({ provider: () => PROFILE, key: () => undefined });
  relay.baseUrl = "http://host";
  const minted = relay.mint({ agentId: "a", agentName: "A", conversation: "main", preset: "claude" });
  assert.ok("error" in minted);
  assert.match(minted.error, /FAKE_KEY/);
});

test("usage is read off either wire, streamed or not", () => {
  const openai = countUsage(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } }));
  assert.deepEqual(openai, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 });
  const stream = countUsage('data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n');
  assert.equal(stream.inputTokens, 5);
  assert.equal(stream.outputTokens, 2);
  assert.deepEqual(countUsage("not json"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});
