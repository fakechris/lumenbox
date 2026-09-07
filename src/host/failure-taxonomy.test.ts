import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, RECOMMENDED_ACTION } from "./failure-taxonomy.ts";

test("failures are classed by what a person reads in the message, unknown otherwise", () => {
  assert.equal(classifyFailure("429 Too Many Requests"), "rate_limit");
  assert.equal(classifyFailure("request timed out after 120000ms"), "timeout");
  assert.equal(classifyFailure("fetch failed: ECONNRESET"), "network");
  assert.equal(classifyFailure("401 unauthorized: invalid api key"), "auth");
  assert.equal(classifyFailure("prompt is too long: 210000 tokens > 200000 maximum"), "context_overflow");
  assert.equal(classifyFailure("bash: permission denied"), "permission_denied");
  assert.equal(classifyFailure("npm test exited 1"), "tool_error");
  assert.equal(classifyFailure("something odd"), "unknown");
  for (const action of Object.values(RECOMMENDED_ACTION)) assert.ok(action.length > 10);
});
