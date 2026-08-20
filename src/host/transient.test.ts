/**
 * Tests for the failure classifier and the retry decision.
 *
 * The cases that matter are the wrapped ones. Node buries the interesting error — a failed `fetch` is
 * a generic TypeError whose `cause` holds the ECONNRESET — so a classifier that reads only the
 * top-level message misses most real transients, which is the failure mode of every naive version of
 * this. The other half is the reverse: a permanent error must not become retryable because something
 * transient-looking wrapped it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  CAPACITY_POLICY,
  classifyFailure,
  decideRetry,
  FirstTokenStallError,
  isFirstTokenStall,
  MAX_RETRY_AFTER_MS,
  serverRetryAfterMs,
  TRANSIENT_POLICY,
} from "./transient.ts";

test("a dropped connection is transient however deeply it is wrapped", () => {
  assert.equal(classifyFailure(Object.assign(new Error("boom"), { code: "ECONNRESET" })), "transient");

  // The shape a real failed fetch has: a generic TypeError with the interesting part in `cause`.
  const wrapped = new Error("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  assert.equal(classifyFailure(wrapped), "transient");

  // And two levels down, because SDKs wrap what undici already wrapped.
  assert.equal(
    classifyFailure(new Error("request failed", { cause: wrapped })),
    "transient",
    "a classifier that stops at the first level misses most real transients"
  );

  // An AggregateError, which is what a multi-address connection failure produces.
  const aggregate = new AggregateError(
    [new Error("nothing useful"), Object.assign(new Error("x"), { code: "EHOSTUNREACH" })],
    "all attempts failed"
  );
  assert.equal(classifyFailure(aggregate), "transient");

  // Message-only, for the layers that stringify and lose `code`.
  assert.equal(classifyFailure(new Error("socket hang up")), "transient");
  assert.equal(classifyFailure("Premature close"), "transient");
});

test("a rejected request stays permanent even inside a transient-looking wrapper", () => {
  // The dangerous direction: retrying a 400 forever burns money and hides the real error.
  const inner = new Error("invalid_request_error: messages: at least one message is required");
  assert.equal(classifyFailure(inner), "permanent");
  assert.equal(
    classifyFailure(new Error("connection closed", { cause: inner })),
    "permanent",
    "a wrapper must not make a permanent error look retryable"
  );
  assert.equal(classifyFailure(Object.assign(new Error("nope"), { status: 401 })), "permanent");
  assert.equal(classifyFailure(new Error("invalid x-api-key")), "permanent");
  assert.equal(classifyFailure(new Error("Your credit balance is too low")), "permanent");
});

test("a busy provider is its own kind, retried sooner and fewer times", () => {
  assert.equal(classifyFailure(Object.assign(new Error("slow down"), { status: 429 })), "capacity");
  assert.equal(classifyFailure(Object.assign(new Error("busy"), { status: 529 })), "capacity");
  assert.equal(classifyFailure(new Error("Overloaded")), "capacity");
  assert.equal(classifyFailure(new Error("rate_limit_error")), "capacity");

  // Hammering a busy provider is what turns a rate limit into a longer one, so it gets less patience
  // than a dropped connection — which is probably talking to something that is fine.
  assert.ok(CAPACITY_POLICY.maxAttempts < TRANSIENT_POLICY.maxAttempts);
  assert.ok(CAPACITY_POLICY.baseDelayMs < TRANSIENT_POLICY.baseDelayMs);
});

test("server errors retry and other client errors do not", () => {
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 500 })), "transient");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 502 })), "transient");
  // The server saying it gave up waiting is something a retry can fix.
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 408 })), "transient");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 504 })), "transient");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 503 })), "capacity");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 404 })), "permanent");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { status: 422 })), "permanent");
});

test("an unrecognised failure is not retried", () => {
  // An unknown error retried in a loop is how a bug becomes a bill.
  assert.equal(classifyFailure(new Error("something nobody has seen before")), "unknown");
  const decision = decideRetry({
    error: new Error("something nobody has seen before"),
    attempt: 1,
    aborted: false,
    outputProduced: false,
  });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /not recognised/);
});

test("a stalled stream is transient, and says what actually happened", () => {
  const stall = new FirstTokenStallError(120_000);
  assert.equal(isFirstTokenStall(stall), true);
  assert.equal(classifyFailure(stall), "transient");
  // The message matters: a person seeing "aborted" would look for who aborted it.
  assert.match(stall.message, /produced nothing for 120s/);
  assert.match(stall.message, /stalled connection rather than a long think/);

  // Recognised structurally too, so it survives being serialised across a boundary.
  assert.equal(isFirstTokenStall({ isFirstTokenStall: true }), true);
  assert.equal(isFirstTokenStall(new Error("aborted")), false);
});

test("a deliberate stop is never retried", () => {
  // Checked before anything else: a person who stopped a turn did not ask for it to try harder.
  const decision = decideRetry({
    error: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    attempt: 1,
    aborted: true,
    outputProduced: false,
  });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /stopped/);
});

test("attempts are bounded, and the reason says so", () => {
  const error = Object.assign(new Error("x"), { code: "ECONNRESET" });
  const base = { error, aborted: false, outputProduced: false };
  for (let attempt = 1; attempt < TRANSIENT_POLICY.maxAttempts; attempt++) {
    assert.equal(decideRetry({ ...base, attempt }).retry, true, `attempt ${attempt} retries`);
  }
  const exhausted = decideRetry({ ...base, attempt: TRANSIENT_POLICY.maxAttempts });
  assert.equal(exhausted.retry, false);
  assert.match(exhausted.reason, /is the limit/);
});

test("backoff grows, is capped, and is half-jittered", () => {
  const policy = { maxAttempts: 9, baseDelayMs: 1_000, maxDelayMs: 8_000 };

  // With random() at 0 the delay is exactly half the exponential; at ~1 it is the whole of it. Half
  // fixed and half random: pure jitter can put two retries at nearly the same instant, and no jitter
  // puts every agent's retry at exactly the same instant.
  assert.equal(backoffMs(1, policy, () => 0), 500);
  assert.equal(backoffMs(1, policy, () => 0.999), 1_000);
  assert.equal(backoffMs(2, policy, () => 0), 1_000);
  assert.equal(backoffMs(3, policy, () => 0), 2_000);
  // Capped, so a long-running turn does not end up waiting minutes.
  assert.equal(backoffMs(20, policy, () => 0), 4_000);
  // 0.999 of the random half, not 1.0 — the cap is 8,000 and half of it is fixed.
  assert.equal(backoffMs(20, policy, () => 0.999), 7_996);
});

test("a provider's retry-after is a floor, not a suggestion", () => {
  // Waiting less than asked is how a rate limit becomes a harder rate limit.
  const asked = {
    status: 429,
    message: "rate limit",
    headers: new Headers({ "retry-after": "5" }),
  };
  assert.equal(serverRetryAfterMs(asked), 5_000);

  const decision = decideRetry({ error: asked, attempt: 1, aborted: false, outputProduced: false });
  assert.equal(decision.retry, true);
  assert.equal(decision.delayMs, 5_000, "the server's number wins over the computed backoff");
  assert.equal(decision.serverPaced, true);

  // A plain object bag, which is the other shape the SDK surfaces.
  assert.equal(serverRetryAfterMs({ headers: { "retry-after": "2" } }), 2_000);
  assert.equal(serverRetryAfterMs({ retryAfter: 3 }), 3_000);
  // Read through a wrapper too.
  assert.equal(serverRetryAfterMs({ cause: { headers: { "retry-after": "4" } } }), 4_000);

  // Capped, so a bad or hostile header cannot stall a turn for an hour.
  assert.equal(serverRetryAfterMs({ headers: { "retry-after": "99999" } }), MAX_RETRY_AFTER_MS);

  // And when the computed backoff is longer, that wins instead.
  const small = { status: 429, headers: new Headers({ "retry-after": "0.001" }) };
  assert.equal(decideRetry({ error: small, attempt: 1, aborted: false, outputProduced: false }).serverPaced, false);

  assert.equal(serverRetryAfterMs({}), undefined);
  assert.equal(serverRetryAfterMs(null), undefined);
});

test("a partial answer already shown does not stop the retry, but is flagged", () => {
  // Nothing is written to the transcript until a round completes, so a retry cannot duplicate stored
  // history or re-run a tool. What it can do is show a partial answer twice — worth flagging so the
  // watcher drops the first, and not worth abandoning the turn over.
  const decision = decideRetry({
    error: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    attempt: 1,
    aborted: false,
    outputProduced: true,
  });
  assert.equal(decision.retry, true);
});
