/**
 * Vendor codes are not one kind of 429 (INV-1612).
 *
 * The phrase scan still catches the sentences we already knew. What it cannot see is a code
 * that never appears in the message: OpenAI's error.code, Anthropic's details.error_code,
 * a numeric 2056. A rate code also has to beat a quota sentence sitting next to it, or a
 * 2062 that mentions the plan would rest the account.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionOf } from "./disposition.ts";
import { classifyFailure, decideRetry } from "./transient.ts";

const noRetry = (error: unknown) => decideRetry({ error, attempt: 1, aborted: false, outputProduced: false });

test("MiniMax 2056 rests and 2062 does not, including when the sentence says the opposite", () => {
  const quota = { status: 429, error: { type: "rate_limit_error", message: "limit", code: 2056 } };
  assert.equal(dispositionOf(quota), "quota_hold");
  assert.equal(classifyFailure(quota), "usage_limit");
  assert.equal(noRetry(quota).retry, false);

  const rate = Object.assign(new Error("速率限制 (2062)"), { status: 429, headers: { "retry-after": "30" } });
  assert.equal(dispositionOf(rate), "retry_after");
  assert.equal(classifyFailure(rate), "capacity");
  assert.equal(noRetry(rate).retry, true);

  // The code wins. A quota sentence must not turn a rate limit into an account rest.
  const mixed = Object.assign(new Error("用量上限 (2062)"), { status: 429 });
  assert.equal(classifyFailure(mixed), "capacity");

  // rate_limit_error is the type on both. It is not itself a rate code.
  assert.equal(classifyFailure({ status: 429, error: { type: "rate_limit_error", message: "slow down" } }), "capacity");
});

test("OpenAI quota codes are usage_limit even when the message does not say so", () => {
  const quota = { status: 429, error: { message: "please wait", type: "tokens", code: "insufficient_quota" } };
  const balance = { status: 429, error: { message: "nope", code: "credit_balance_exhausted" } };
  const typed = { status: 429, error: { message: "please wait", type: "insufficient_quota" } };
  const rate = { status: 429, error: { message: "please wait", code: "rate_limit_exceeded" } };
  assert.equal(classifyFailure(quota), "usage_limit");
  assert.equal(classifyFailure(balance), "usage_limit");
  assert.equal(classifyFailure(typed), "usage_limit");
  assert.equal(noRetry(quota).retry, false);
  assert.equal(classifyFailure(rate), "capacity");
});

test("an Anthropic spend cap without retry-after rests; the same cap with retry-after does not", () => {
  const body = { type: "rate_limit_error", message: "limit", details: { error_code: "enforced_spend_limit_reached" } };
  const capped = { status: 429, error: body };
  assert.equal(dispositionOf(capped), "quota_hold");
  assert.equal(classifyFailure(capped), "usage_limit");

  const paced = { status: 429, headers: { "retry-after": "2" }, error: body };
  assert.equal(dispositionOf(paced), "retry_after");
  assert.equal(classifyFailure(paced), "capacity");

  // A quota code beside the spend cap still wins, even when the provider asked for a pause.
  const both = { status: 429, headers: { get: (name: string) => (name === "retry-after" ? "2" : null) }, error: { code: "insufficient_quota", details: body.details } };
  assert.equal(dispositionOf(both), "quota_hold");
});

test("an unknown 429 stays capacity and does not rest the account", () => {
  const unknown = Object.assign(new Error("nope"), { status: 429 });
  assert.equal(dispositionOf(unknown), undefined);
  assert.equal(classifyFailure(unknown), "capacity");
  assert.equal(noRetry(unknown).retry, true);
});
