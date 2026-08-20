/**
 * Tests for the model relay.
 *
 * The parts worth testing are the ones a mistake makes silently wrong: that a box cannot reach a
 * provider it was not issued for, that a streamed response is metered without being delayed or
 * altered, and that the running totals in a stream are not added up — which would multiply the
 * input tokens by the number of frames and over-bill by an order of magnitude.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  pathAllowed,
  presentedToken,
  startRelay,
  UsageAccumulator,
  usageFromBody,
  type RelayClient,
  type RelayUsage,
  type Upstream,
} from "./server.ts";

/** A stand-in provider that reports what it was sent and can answer either shape. */
async function fakeProvider(options: {
  stream?: boolean;
  status?: number;
} = {}): Promise<{ url: string; seen: { authorization?: string; apiKey?: string; path?: string; body?: string }[]; close: () => void }> {
  const seen: { authorization?: string; apiKey?: string; path?: string; body?: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += String(chunk);
    });
    req.on("end", () => {
      seen.push({
        authorization: req.headers.authorization as string | undefined,
        apiKey: req.headers["x-api-key"] as string | undefined,
        path: req.url,
        body,
      });
      if (options.status !== undefined && options.status >= 400) {
        res.writeHead(options.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "no" } }));
        return;
      }
      if (options.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split across writes deliberately, and one frame split mid-way, because that is what a real
        // connection does and a parser that assumed one frame per chunk would miss most of them.
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x",' +
            '"usage":{"input_tokens":1200,"cache_read_input_tokens":40,"cache_creation_input_tokens":5,' +
            '"output_tokens":1}}}\n\n'
        );
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_to');
        res.write('kens":7}}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":31}}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "claude-x",
          usage: {
            input_tokens: 1200,
            output_tokens: 31,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 5,
          },
        })
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

async function relayFor(
  upstream: Upstream,
  tokens: Record<string, { tenantId: string; boxId: string }>
): Promise<{ url: string; usage: RelayUsage[]; close: () => void }> {
  const usage: RelayUsage[] = [];
  const server = startRelay({
    port: 0,
    resolve: (token): RelayClient | undefined => {
      const found = tokens[token];
      return found === undefined ? undefined : { token, ...found, upstream };
    },
    onUsage: entry => usage.push(entry),
  });
  await new Promise<void>(resolve => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, usage, close: () => server.close() };
}

test("only the paths an agent runtime needs are forwarded", () => {
  assert.equal(pathAllowed("/v1/messages"), true);
  assert.equal(pathAllowed("/v1/messages/count_tokens"), true);
  // Each of these is a capability nobody asked for, and every one widens what a leaked box token
  // buys. A relay forwarding any path is a general proxy holding a provider key.
  assert.equal(pathAllowed("/v1/models"), false);
  assert.equal(pathAllowed("/v1/files"), false);
  assert.equal(pathAllowed("/v1/messages/batches"), false);
  assert.equal(pathAllowed("/"), false);
});

test("a token is read from either header shape", () => {
  assert.equal(presentedToken({ "x-api-key": "abc" }), "abc");
  assert.equal(presentedToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(presentedToken({ authorization: "bearer abc" }), "abc", "case-insensitively");
  // The SDK sends one or the other depending on how it was constructed, and the box should not have
  // to care which.
  assert.equal(presentedToken({}), undefined);
  assert.equal(presentedToken({ authorization: "Basic abc" }), undefined);
  assert.equal(presentedToken({ "x-api-key": "  " }), undefined);
});

test("running totals in a stream are not summed", () => {
  // The bug this prevents: message_start reports input_tokens once and each message_delta reports
  // the *running* output total. Adding the frames would multiply input by the frame count and
  // over-bill by an order of magnitude.
  const accumulator = new UsageAccumulator();
  accumulator.push(
    'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n'
  );
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":10}}\n\n');
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":25}}\n\n');
  accumulator.end();

  const result = accumulator.result();
  assert.equal(result?.inputTokens, 1000, "not 3000");
  assert.equal(result?.outputTokens, 25, "the last value, not 36");
  assert.equal(result?.model, "m");
});

test("frames split across chunks are still read", () => {
  // A parser that assumed one chunk per frame would miss most frames on a slow connection.
  const accumulator = new UsageAccumulator();
  accumulator.push('data: {"type":"message_start","message":{"usage":{"input_to');
  accumulator.push('kens":42},"model":"m"}}\n\n');
  accumulator.end();
  assert.equal(accumulator.result()?.inputTokens, 42);
});

test("a final frame with no trailing blank line is not lost", () => {
  const accumulator = new UsageAccumulator();
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":9}}');
  assert.equal(accumulator.result(), undefined, "nothing complete yet");
  accumulator.end();
  assert.equal(accumulator.result()?.outputTokens, 9);
});

test("unparseable frames cost a measurement, never the request", () => {
  const accumulator = new UsageAccumulator();
  accumulator.push("data: {not json\n\n");
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n');
  accumulator.push("data: [DONE]\n\n");
  accumulator.end();
  assert.equal(accumulator.result()?.outputTokens, 4, "the readable frame still counted");

  // A response with nothing to measure says so, rather than reporting zeros that look like a bill.
  const empty = new UsageAccumulator();
  empty.push("event: ping\ndata: {}\n\n");
  empty.end();
  assert.equal(empty.result(), undefined);
});

test("a non-streamed body is measured too", () => {
  assert.deepEqual(
    usageFromBody('{"model":"m","usage":{"input_tokens":5,"output_tokens":6,"cache_read_input_tokens":7}}'),
    { model: "m", inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0 }
  );
  assert.equal(usageFromBody("not json"), undefined);
  assert.equal(usageFromBody('{"model":"m"}'), undefined, "no usage is not zero usage");
});

test("the box's token is replaced by the real credential, which never travels back", async () => {
  const provider = await fakeProvider();
  const relay = await relayFor(
    { label: "anthropic", baseUrl: provider.url, key: "THE-REAL-KEY", auth: "x-api-key" },
    { "box-token": { tenantId: "t1", boxId: "b1" } }
  );
  try {
    const response = await fetch(`${relay.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "box-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [] }),
    });
    assert.equal(response.status, 200);

    // The provider saw the real key and not the box's token. This is the whole point.
    assert.equal(provider.seen[0]?.apiKey, "THE-REAL-KEY");
    assert.equal(provider.seen[0]?.authorization, undefined);
    assert.equal(provider.seen[0]?.path, "/v1/messages");
    assert.match(provider.seen[0]?.body ?? "", /claude-x/, "the body passed through unchanged");

    // And nothing about the real key comes back.
    const returned = JSON.stringify([...response.headers.entries()]) + (await response.text());
    assert.ok(!returned.includes("THE-REAL-KEY"));

    assert.equal(relay.usage.length, 1);
    assert.equal(relay.usage[0]?.inputTokens, 1200);
    assert.equal(relay.usage[0]?.outputTokens, 31);
    assert.equal(relay.usage[0]?.tenantId, "t1");
    assert.equal(relay.usage[0]?.streamed, false);
  } finally {
    relay.close();
    provider.close();
  }
});

test("a streamed response is metered without being altered", async () => {
  const provider = await fakeProvider({ stream: true });
  const relay = await relayFor(
    { label: "minimax", baseUrl: provider.url, key: "K", auth: "bearer" },
    { "box-token": { tenantId: "t1", boxId: "b1" } }
  );
  try {
    const response = await fetch(`${relay.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer box-token" },
      body: "{}",
    });
    const text = await response.text();

    // Byte-for-byte: the SDK on the other side parses this, so a relay that reshaped it would break
    // streaming in ways that look like a model fault.
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
    // Counting event lines, not the string: "message_delta" appears in both the event line and the
    // payload's own type field, so a naive count is double.
    assert.equal((text.match(/^event: message_delta$/gm) ?? []).length, 2);

    assert.equal(relay.usage.length, 1);
    assert.equal(relay.usage[0]?.streamed, true);
    assert.equal(relay.usage[0]?.inputTokens, 1200, "not multiplied by the frame count");
    assert.equal(relay.usage[0]?.outputTokens, 31, "the last running total");
    assert.equal(relay.usage[0]?.cacheReadTokens, 40);
    assert.equal(relay.usage[0]?.provider, "minimax");

    // Bearer upstreams get a Bearer, not an x-api-key.
    assert.equal(provider.seen[0]?.authorization, "Bearer K");
  } finally {
    relay.close();
    provider.close();
  }
});

test("no token, a wrong token and a forbidden path are all refused", async () => {
  const provider = await fakeProvider();
  const relay = await relayFor(
    { label: "anthropic", baseUrl: provider.url, key: "K", auth: "x-api-key" },
    { "box-token": { tenantId: "t1", boxId: "b1" } }
  );
  try {
    const noToken = await fetch(`${relay.url}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(noToken.status, 401);
    const wrongToken = await fetch(`${relay.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "guessed" },
      body: "{}",
    });
    assert.equal(wrongToken.status, 401);
    // The same answer for both: which one it was is not the caller's business.
    assert.deepEqual(await noToken.json(), await wrongToken.json());

    // A path check that came *after* authentication would let a valid token probe the surface.
    const forbidden = await fetch(`${relay.url}/v1/models`, { headers: { "x-api-key": "box-token" } });
    assert.equal(forbidden.status, 404);

    // Nothing reached the provider, so the operator's key was never spent on any of it.
    assert.equal(provider.seen.length, 0);

    // Health needs no credential, so a container check does not need one.
    assert.equal((await fetch(`${relay.url}/health`)).status, 200);
  } finally {
    relay.close();
    provider.close();
  }
});

test("an upstream that fails is reported as a provider error, not as a hang", async () => {
  const relay = await relayFor(
    // Nothing listening there.
    { label: "anthropic", baseUrl: "http://127.0.0.1:1", key: "K", auth: "x-api-key" },
    { "box-token": { tenantId: "t1", boxId: "b1" } }
  );
  try {
    const response = await fetch(`${relay.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "box-token" },
      body: "{}",
    });
    // Shaped like a provider error, because the SDK on the other side knows how to read that and
    // will retry a 502 appropriately.
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  } finally {
    relay.close();
  }
});

test("a provider error passes through with its status and body", async () => {
  const provider = await fakeProvider({ status: 400 });
  const relay = await relayFor(
    { label: "anthropic", baseUrl: provider.url, key: "K", auth: "x-api-key" },
    { "box-token": { tenantId: "t1", boxId: "b1" } }
  );
  try {
    const response = await fetch(`${relay.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "box-token" },
      body: "{}",
    });
    // Not translated: an agent that cannot see why its request was rejected cannot fix it, and the
    // compaction retry in turn.ts reads exactly these messages.
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /invalid_request_error/);
    assert.equal(relay.usage.length, 0, "a rejected request is not billed");
  } finally {
    relay.close();
    provider.close();
  }
});
