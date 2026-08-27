/**
 * Tests for "is anyone still listening".
 *
 * The failure this exists for: a channel logged "connected" once, and ninety minutes
 * later `lsof` showed it had no socket at all. Nothing had recorded a disconnect, a
 * retry, or a failure to retry. Messages reached nobody, and the ingress ledger correctly
 * recorded that nothing had arrived — which is exactly what a quiet afternoon looks like.
 *
 * So the property under test is the *separation*: reachable-and-silent must not read the
 * same as unreachable, and neither must read the same as fine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SILENCE_BEFORE_SUSPECT_MS, channelHealth } from "./liveness.ts";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const alive = () => Promise.resolve(undefined);

test("a long silence behind a healthy account is the case that produced no signal", async () => {
  const health = await channelHealth({
    channel: "feishu",
    lastInboundAt: ago(SILENCE_BEFORE_SUSPECT_MS + 60_000),
    now,
    probe: alive,
  });
  assert.equal(health.state, "suspect");
  // The remedy has to be in the message: knowing something is wrong without knowing what
  // to do about it is the state this replaces.
  assert.match(health.detail, /restart/);
});

test("recent traffic is not a problem, however sleepy", async () => {
  const health = await channelHealth({
    channel: "feishu",
    lastInboundAt: ago(30 * 60_000),
    now,
    probe: alive,
  });
  assert.equal(health.state, "ok");
  assert.match(health.detail, /30m/);
});

test("a fresh installation that has never heard anything is not suspect", async () => {
  // Otherwise every new install starts by accusing its own channel.
  const health = await channelHealth({ channel: "feishu", lastInboundAt: undefined, now, probe: alive });
  assert.equal(health.state, "ok");
});

test("an unreachable account is its own answer, and says so even when it is also quiet", async () => {
  const health = await channelHealth({
    channel: "feishu",
    lastInboundAt: ago(SILENCE_BEFORE_SUSPECT_MS * 3),
    now,
    probe: () => Promise.resolve("app disabled (code 99991663)"),
  });
  assert.equal(health.state, "unreachable", "credentials failing outrank a silence they explain");
  assert.match(health.detail, /99991663/);
  assert.match(health.detail, /not a quiet period/);
});

test("a probe that throws is unreachable, not a crash", async () => {
  const health = await channelHealth({
    channel: "feishu",
    lastInboundAt: ago(60_000),
    now,
    probe: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
  });
  assert.equal(health.state, "unreachable");
  assert.match(health.detail, /ENOTFOUND/);
});
