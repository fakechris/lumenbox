/**
 * Tests for the relay's own rules.
 *
 * The allow list is the part with teeth: the relay exists to reach the user's network, and the
 * user's network is exactly what an agent should not be able to sweep.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayError, permitted, startEgressRelay } from "./relay.ts";

test("a relay without a real token refuses to start", () => {
  // Failing loudly rather than defaulting: a relay with no token is an open proxy on whatever
  // network it can reach.
  assert.throws(() => startEgressRelay({ token: "" }), RelayError);
  assert.throws(() => startEgressRelay({ token: "short" }), RelayError);
});

test("an empty allow list means anywhere", () => {
  assert.equal(permitted({ host: "example.com", port: 443 }, []), true);
});

test("an exact host, with and without a port", () => {
  assert.equal(permitted({ host: "example.com", port: 443 }, ["example.com"]), true);
  assert.equal(permitted({ host: "other.com", port: 443 }, ["example.com"]), false);
  assert.equal(permitted({ host: "example.com", port: 443 }, ["example.com:443"]), true);
  assert.equal(permitted({ host: "example.com", port: 80 }, ["example.com:443"]), false);
});

test("a wildcard matches the domain and its subdomains, not a lookalike", () => {
  const allow = ["*.example.com"];
  assert.equal(permitted({ host: "api.example.com", port: 443 }, allow), true);
  assert.equal(permitted({ host: "example.com", port: 443 }, allow), true);
  // The suffix check must not let notexample.com through.
  assert.equal(permitted({ host: "notexample.com", port: 443 }, allow), false);
  assert.equal(permitted({ host: "example.com.evil.net", port: 443 }, allow), false);
});

test("a bare star allows everything, for a deployment that means it", () => {
  assert.equal(permitted({ host: "anything.at.all", port: 8080 }, ["*"]), true);
});

// ── per box (INV-423) ─────────────────────────────────────────────────────────────
import { identify } from "./relay.ts";

test("a stream is the box its token names, with the global list widened by its bundles", () => {
  const options = {
    token: "relay-token-1234567890",
    allow: ["api.search.test"],
    boxes: [
      { name: "agentbox", token: "relay-token-1234567890", allow: ["vendor.test"] },
      { name: "grok", token: "grok-token-1234567890", allow: [] },
    ],
  };
  // The own box shares the relay token and is named as a box, so its bundle hosts apply.
  assert.deepEqual(identify("relay-token-1234567890", options), { box: "agentbox", allow: ["api.search.test", "vendor.test"] });
  // An attached box with nothing in its bundles gets the global list and no more.
  assert.deepEqual(identify("grok-token-1234567890", options), { box: "grok", allow: ["api.search.test"] });
  assert.equal(identify("nope", options), undefined);
  // A relay started the old way: only its token, no boxes — still works.
  assert.deepEqual(identify("relay-token-1234567890", { token: "relay-token-1234567890", allow: [] }), { box: "relay", allow: [] });
  // A global list that names hosts is not widened to anywhere by a box that says nothing.
  const strict = identify("grok-token-1234567890", options)!;
  assert.equal(permitted({ host: "vendor.test", port: 443 }, strict.allow), false);
  assert.equal(permitted({ host: "vendor.test", port: 443 }, identify("relay-token-1234567890", options)!.allow), true);
});

// ── attribution (INV-784) ─────────────────────────────────────────────────────────
import { createServer, connect } from "node:net";
import { encodeCall } from "./call.ts";
import { encodeRequest } from "./protocol.ts";
import { attributionOf, type NetworkEvent } from "./relay.ts";

test("attribution is read from the call token, and a missing or bad token is unattributed rather than dropped", () => {
  const token = encodeCall({ agentId: "ada", turnId: "t-1", toolUseId: "toolu_1", jobId: "job-0123abcd" });
  assert.deepEqual(attributionOf(token), { attribution: "call", agentId: "ada", turnId: "t-1", toolUseId: "toolu_1", jobId: "job-0123abcd" });
  assert.deepEqual(attributionOf(undefined), { attribution: "unattributed" });
  assert.deepEqual(attributionOf("garbage"), { attribution: "unattributed" });
});

test("the relay stamps the event with the call the stream named, allowed or refused", async () => {
  const upstream = createServer(socket => socket.end("hi"));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const events: NetworkEvent[] = [];
  const relay = startEgressRelay({ token: "relay-token-1234567890", allow: ["127.0.0.1"], port: 0, onEvent: event => events.push(event) });
  await new Promise<void>(resolve => relay.once("listening", resolve));
  const relayPort = (relay.address() as { port: number }).port;
  const token = encodeCall({ agentId: "ada", turnId: "t-1", toolUseId: "toolu_1" });

  const stream = (host: string, call?: string) =>
    new Promise<void>(resolve => {
      const socket = connect(relayPort, "127.0.0.1", () => socket.write(encodeRequest({ token: "relay-token-1234567890", host, port: upstreamPort, ...(call !== undefined ? { call } : {}) })));
      socket.on("data", () => socket.end());
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
  try {
    await stream("127.0.0.1", token);
    await stream("evil.test", token);
    await stream("127.0.0.1");
    assert.equal(events.length, 3);
    assert.equal(events[0]!.allowed, true);
    assert.deepEqual([events[0]!.attribution, events[0]!.agentId, events[0]!.turnId, events[0]!.toolUseId], ["call", "ada", "t-1", "toolu_1"]);
    assert.equal(events[1]!.allowed, false);
    assert.equal(events[1]!.toolUseId, "toolu_1", "a refusal is attributed too: that is what the tool result reports");
    assert.equal(events[2]!.attribution, "unattributed");
    assert.equal(events[2]!.agentId, undefined);
  } finally {
    relay.close();
    upstream.close();
  }
});
