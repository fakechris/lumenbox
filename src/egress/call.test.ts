/**
 * The call token (INV-784): minted by the host, carried in the environment and the proxy
 * credential, vouched for by boxd, decoded by the relay. The model cannot forge one because
 * the proxy only forwards what boxd registered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_ENV,
  CALL_ENV_NAMES,
  CallRegistry,
  callEnvironment,
  decodeCall,
  encodeCall,
  isCallToken,
  tokenFromProxyAuthorization,
} from "./call.ts";

test("a token round-trips the agent, turn, tool call and job, and is opaque and URL-safe", () => {
  const token = encodeCall({ agentId: "ada", turnId: "t-1", toolUseId: "toolu_9", jobId: "job-abcdef01" });
  assert.ok(isCallToken(token));
  assert.doesNotMatch(token, /ada|toolu/, "a token is not its contents in the clear");
  assert.deepEqual(decodeCall(token), { agentId: "ada", turnId: "t-1", toolUseId: "toolu_9", jobId: "job-abcdef01" });
  assert.deepEqual(decodeCall(encodeCall({ agentId: "ada", turnId: "t-1" })), { agentId: "ada", turnId: "t-1" });
});

test("anything that is not a minted token decodes to nothing, never throws", () => {
  assert.equal(decodeCall(undefined), undefined);
  assert.equal(decodeCall(""), undefined);
  assert.equal(decodeCall("not base64url!"), undefined);
  assert.equal(decodeCall(Buffer.from("[]").toString("base64url")), undefined);
  assert.equal(decodeCall(Buffer.from('{"agentId":1}').toString("base64url")), undefined);
});

test("the environment names the call and routes the command's traffic through the proxy with it, loopback direct", () => {
  const env = callEnvironment("tok_1", 8791);
  assert.equal(env[CALL_ENV], "tok_1");
  assert.equal(env.HTTPS_PROXY, "http://call:tok_1@127.0.0.1:8791");
  assert.equal(env.http_proxy, env.HTTP_PROXY);
  assert.match(env.NO_PROXY!, /127\.0\.0\.1/);
  assert.deepEqual(Object.keys(env).sort(), [...CALL_ENV_NAMES].sort());
});

test("the credential is read back out of Proxy-Authorization, and only when it is ours", () => {
  const token = encodeCall({ agentId: "ada", turnId: "t-1" });
  const basic = `Basic ${Buffer.from(`call:${token}`).toString("base64")}`;
  assert.equal(tokenFromProxyAuthorization(basic), token);
  assert.equal(tokenFromProxyAuthorization(undefined), undefined);
  assert.equal(tokenFromProxyAuthorization("Bearer x"), undefined);
  assert.equal(tokenFromProxyAuthorization(`Basic ${Buffer.from(`someone:${token}`).toString("base64")}`), undefined);
  assert.equal(tokenFromProxyAuthorization(`Basic ${Buffer.from("call:not a token!").toString("base64")}`), undefined);
});

test("the registry vouches for a token only while its call runs, so a stale or invented token is unattributed", () => {
  const calls = new CallRegistry();
  assert.equal(calls.resolve("invented"), undefined);
  const release = calls.begin("tok_a");
  assert.equal(calls.resolve("tok_a"), "tok_a");
  assert.equal(calls.resolve("tok_b"), undefined, "another call's token is not vouched for");
  release();
  release();
  assert.equal(calls.resolve("tok_a"), undefined, "a token whose call ended is not vouched for");
});

test("an uncredentialed connection belongs to the one browser action in flight, and to nobody when two are", () => {
  const calls = new CallRegistry();
  assert.equal(calls.resolve(undefined), undefined);
  const first = calls.beginAmbient("tok_browser_1");
  assert.equal(calls.resolve(undefined), "tok_browser_1");
  const second = calls.beginAmbient("tok_browser_2");
  assert.equal(calls.resolve(undefined), undefined, "a guess is not a record");
  second();
  assert.equal(calls.resolve(undefined), "tok_browser_1");
  first();
  assert.equal(calls.resolve(undefined), undefined);
});
