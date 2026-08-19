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
