import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, classifyFailureOf, keepFirstSpecific, RECOMMENDED_ACTION } from "./failure-taxonomy.ts";

test("failures are classed by what a person reads in the message, unknown otherwise", () => {
  assert.equal(classifyFailure("429 Too Many Requests"), "rate_limit");
  assert.equal(classifyFailure("request timed out after 120000ms"), "timeout");
  assert.equal(classifyFailure("fetch failed: ECONNRESET"), "network");
  assert.equal(classifyFailure("401 unauthorized: invalid api key"), "auth");
  assert.equal(classifyFailure("prompt is too long: 210000 tokens > 200000 maximum"), "context_overflow");
  assert.equal(classifyFailure('400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"}}'), "context_overflow");
  assert.equal(classifyFailure("bash: permission denied"), "permission_denied");
  assert.equal(classifyFailure("npm test exited 1"), "tool_error");
  assert.equal(classifyFailure("something odd"), "unknown");
  for (const action of Object.values(RECOMMENDED_ACTION)) assert.ok(action.length > 10);
});

test("an error object is classed by its fields before its wording (INV-1235)", () => {
  const api = (status: number, type: string, message = "some wording the regexes do not know") =>
    Object.assign(new Error(message), { status, error: { type: "error", error: { type, message } } });
  assert.equal(classifyFailureOf(api(429, "rate_limit_error")), "rate_limit");
  assert.equal(classifyFailureOf(api(529, "overloaded_error")), "rate_limit");
  assert.equal(classifyFailureOf(api(401, "authentication_error")), "auth");
  assert.equal(classifyFailureOf(api(403, "permission_error")), "auth");
  assert.equal(classifyFailureOf(api(400, "invalid_request_error", "prompt is too long: 210000 tokens > 200000 maximum")), "context_overflow");
  assert.equal(classifyFailureOf(api(408, "timeout_error")), "timeout");
  assert.equal(classifyFailureOf(Object.assign(new Error("connect failed"), { code: "ECONNRESET" })), "network");
  assert.equal(classifyFailureOf(Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" })), "timeout");
  // Reworded or translated by a provider or a relay: the status still decides.
  assert.equal(classifyFailureOf(Object.assign(new Error("请求过于频繁"), { status: 429 })), "rate_limit");
  // Wrapped: the provider error sits in the cause chain.
  assert.equal(classifyFailureOf(new Error("delegate call failed", { cause: api(401, "authentication_error") })), "auth");
  // Structured wins over wording that would say otherwise.
  assert.equal(classifyFailureOf(api(429, "rate_limit_error", "connection timed out")), "rate_limit");
  // No field decides: the text rules apply as before; a bare string has only text.
  assert.equal(classifyFailureOf(new Error("npm test exited 1")), "tool_error");
  assert.equal(classifyFailureOf(Object.assign(new Error("fetch failed: ECONNRESET"), { status: undefined })), "network");
  assert.equal(classifyFailureOf("429 Too Many Requests"), "rate_limit");
  assert.equal(classifyFailureOf(new Error("something odd")), "unknown");
});

test("the first specific class a turn saw is kept; unknown never overwrites it (INV-1235)", () => {
  assert.equal(keepFirstSpecific(undefined, "rate_limit"), "rate_limit");
  assert.equal(keepFirstSpecific("rate_limit", "unknown"), "rate_limit");
  assert.equal(keepFirstSpecific("rate_limit", "network"), "rate_limit");
  assert.equal(keepFirstSpecific("unknown", "network"), "network");
  assert.equal(keepFirstSpecific(undefined, "unknown"), "unknown");
});
