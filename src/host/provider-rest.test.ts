/**
 * A plan that is out of usage is not a busy provider (INV-1577): it is not retried, and the account
 * rests for every agent at once, with one call per rest window to find out whether it came back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { classifyFailure, decideRetry } from "./transient.ts";
import { accountOf, gateClient, ProviderRests, ProviderRestingError, setRejectionNote, type RejectionEntry, type RestEvent } from "./provider-rest.ts";
import { fakeModel } from "./testing/fake-model.ts";

/** What MiniMax answered all evening on 2026-11-04, verbatim. */
const TOKEN_PLAN_2056 = Object.assign(
  new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"},"request_id":"073a3dff63b1fe1e3e082921"}'),
  { status: 429 }
);

const reply = (text: string): Anthropic.Message => ({
  id: "msg", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text, citations: null }],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} as unknown as Anthropic.Message);

test("a plan out of usage is usage_limit and is not retried; a busy provider still is", () => {
  assert.equal(classifyFailure(TOKEN_PLAN_2056), "usage_limit");
  for (const text of ["You exceeded your current quota, please check your plan", "insufficient_quota", "Your credit balance is too low", "out of credits", "余额不足"]) {
    assert.equal(classifyFailure(Object.assign(new Error(text), { status: 429 })), "usage_limit", text);
  }
  const decision = decideRetry({ error: TOKEN_PLAN_2056, attempt: 1, aborted: false, outputProduced: false });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /out of usage/);
  // Ordinary capacity is unchanged.
  assert.equal(classifyFailure(Object.assign(new Error("slow down"), { status: 429 })), "capacity");
  assert.equal(classifyFailure(new Error("Overloaded")), "capacity");
  assert.equal(decideRetry({ error: new Error("Overloaded"), attempt: 1, aborted: false, outputProduced: false }).retry, true);
});

test("five agents on one exhausted plan: one call per rest window, one notice, and back after it resets", async () => {
  let clock = Date.parse("2026-11-04T09:00:00Z");
  const rests = new ProviderRests({ now: () => clock });
  const events: RestEvent[] = [];
  rests.on(event => events.push(event));
  let exhausted = true;
  let calls = 0;
  const upstream = fakeModel(() => { calls++; if (exhausted) throw TOKEN_PLAN_2056; return reply("back"); }, { create: () => { calls++; if (exhausted) throw TOKEN_PLAN_2056; return reply("back"); } });
  const account = accountOf({ label: "MiniMax (China)", baseUrl: "https://api.minimaxi.com/anthropic" }, "key-1");
  const client = gateClient(upstream, account, "MiniMax (China)", rests);
  const turn = async () => client.messages.stream({ model: "m", max_tokens: 1, messages: [] } as never).finalMessage();

  // The first agent finds out; the other four, a moment later, never reach the provider.
  await assert.rejects(turn(), /用量上限/);
  const refused = await Promise.allSettled([turn(), turn(), turn(), turn()]);
  assert.equal(calls, 1, "one call, not one per agent");
  for (const outcome of refused) {
    assert.equal(outcome.status, "rejected");
    assert.ok((outcome as PromiseRejectedResult).reason instanceof ProviderRestingError);
    assert.match(String((outcome as PromiseRejectedResult).reason.message), /plan quota is used up.*resting until.*no call was made/s);
  }
  assert.equal(classifyFailure((refused[0] as PromiseRejectedResult).reason), "usage_limit", "a refusal is not retried either");
  // Summaries and extraction call `create`; they rest too.
  await assert.rejects(client.messages.create({ model: "m", max_tokens: 1, messages: [] } as never), ProviderRestingError);
  assert.equal(calls, 1);

  // The window ends: exactly one probe goes out, however many agents ask at once. Still out → the rest grows.
  clock += 15 * 60_000 + 1;
  await Promise.allSettled([turn(), turn(), turn(), turn(), turn()]);
  assert.equal(calls, 2, "one probe for the five");
  assert.equal(rests.list()[0]?.streak, 2);
  assert.ok(Date.parse(rests.list()[0]!.until) - clock >= 60 * 60_000 - 1, "the second rest is longer: an hour");

  // The plan resets; the next probe succeeds and everyone is back.
  exhausted = false;
  clock += 60 * 60_000 + 1;
  assert.equal((await turn()).content.length, 1);
  assert.equal(rests.list().length, 0);
  const results = await Promise.all([turn(), turn(), turn(), turn()]);
  assert.equal(results.length, 4);
  assert.equal(calls, 7);

  assert.deepEqual(events.map(event => event.type), ["resting", "recovered"], "admins hear once when it starts and once when it ends");
});

test("turns that leave at the same instant each make one call, and none is retried: five, not fifteen", async () => {
  const rests = new ProviderRests();
  let calls = 0;
  const client = gateClient(fakeModel(() => { calls++; throw TOKEN_PLAN_2056; }), "acct", "MiniMax (China)", rests);
  const events: RestEvent[] = [];
  rests.on(event => events.push(event));
  // Five in flight before any answer: the gate cannot know yet. Each fails once (no retry), and the account rests once.
  await Promise.allSettled([1, 2, 3, 4, 5].map(() => client.messages.stream({ model: "m", max_tokens: 1, messages: [] } as never).finalMessage()));
  assert.equal(calls, 5);
  assert.equal(events.length, 1);
  await assert.rejects(client.messages.stream({ model: "m", max_tokens: 1, messages: [] } as never).finalMessage(), ProviderRestingError);
  assert.equal(calls, 5);
});

test("a reset time the provider gives is believed; retry now ends the rest; accounts are separate", async () => {
  let clock = Date.parse("2026-11-04T09:00:00Z");
  const rests = new ProviderRests({ now: () => clock });
  const reset = new Date(clock + 3 * 3_600_000).toISOString();
  const withReset = Object.assign(new Error("usage limit reached"), { status: 429, headers: { "anthropic-ratelimit-tokens-reset": reset } });
  const a = accountOf({ label: "A", baseUrl: "https://a" }, "k"), b = accountOf({ label: "B", baseUrl: "https://b" }, "k");
  assert.notEqual(a, b);
  assert.equal(accountOf({ label: "A", baseUrl: "https://a" }, "k"), a, "stable");
  assert.ok(!a.includes("k|") && !a.endsWith("k"), "the key itself is not in the account id");
  rests.failed(a, "A", withReset);
  assert.equal(rests.list()[0]?.until, reset);
  assert.equal(rests.check(b).refuse, false, "another account is not resting");
  assert.equal(rests.check(a).refuse, true);
  assert.equal(rests.retryNow(a), true);
  assert.equal(rests.check(a).refuse, false, "the next call is let through to find out");
  // A failure that is not usage_limit never rests anything.
  assert.equal(rests.failed(b, "B", Object.assign(new Error("Overloaded"), { status: 529 })), false);
  assert.equal(rests.check(b).refuse, false);
});

test("scenario: five agents' turns on an exhausted plan — one call reaches the provider, each turn ends saying why, and the next turn after the reset is answered", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { Orchestrator } = await import("./orchestrator.ts");
  const root = mkdtempSync(join(tmpdir(), "provider-rest-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    let clock = Date.parse("2026-11-04T09:00:00Z");
    const rests = new ProviderRests({ now: () => clock });
    const notices: RestEvent[] = [];
    rests.on(event => notices.push(event));
    let exhausted = true, calls = 0;
    const answer = () => { calls++; if (exhausted) throw TOKEN_PLAN_2056; return reply("Here is the summary."); };
    const client = gateClient(fakeModel(answer, { create: answer }), "minimax|test|k", "MiniMax (China)", rests);
    const registry = new AgentRegistry(join(root, "agents"));
    const agents = ["Bob", "Vic", "Enzo", "Heng", "Ada"].map(name => registry.create({ name }));
    const errors: string[] = [];
    const orch = new Orchestrator({ registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks: null, extensions: null, pendingWork: null, client,
      onBusEvent: event => { if (event.type === "turn_failed") errors.push(event.error); } });

    // The first agent's turn finds out; the four whose turns come after it never reach the provider.
    await orch.prompt(agents[0]!.id, "what changed today?", { userId: "chris" }).catch(() => undefined);
    assert.equal(calls, 1, "the first call, and not retried");
    const waited = await Promise.allSettled(agents.slice(1).map(agent => orch.prompt(agent.id, "what changed today?", { userId: "chris" })));
    for (const outcome of waited) if (outcome.status === "rejected") errors.push(String((outcome.reason as Error)?.message ?? outcome.reason));
    assert.equal(calls, 1, "one call for five agents, not three per agent");
    assert.equal(notices.filter(event => event.type === "resting").length, 1, "people hear once");
    assert.ok(errors.filter(message => /plan quota is used up.*no call was made/s.test(message)).length >= 4, `the four that waited are told why:\n${errors.join("\n")}`);

    exhausted = false;
    clock += 15 * 60_000 + 1;
    await orch.prompt(agents[0]!.id, "and now?", { userId: "chris" });
    assert.equal(calls, 2, "the probe");
    const last = registry.readTranscript(agents[0]!.id).at(-1) as { text?: string; blocks?: { text?: string }[] };
    assert.match(JSON.stringify(last), /Here is the summary/);
    assert.deepEqual(notices.map(event => event.type), ["resting", "recovered"]);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forecast hold is refused before the call and is not retried; a real 2056 is a zero-token row", async () => {
  const rests = new ProviderRests();
  let calls = 0;
  const held = Object.assign(new Error("quota_hold: Forecast, not a bill. No call was made."), { providerResting: true as const });
  const blocked = gateClient(fakeModel(() => { calls += 1; return reply("nope"); }), "acct", "MiniMax", rests, () => held);
  await assert.rejects(blocked.messages.create({ model: "m", max_tokens: 1, messages: [] } as never), /quota_hold/);
  await assert.rejects(blocked.messages.stream({ model: "m", max_tokens: 1, messages: [] } as never).finalMessage(), /quota_hold/);
  assert.equal(calls, 0, "the forecast hold does not reach the provider");
  assert.equal(rests.list().length, 0, "a forecast hold does not open a second rest");
  assert.equal(classifyFailure(held), "usage_limit");
  assert.equal(decideRetry({ error: held, attempt: 1, aborted: false, outputProduced: false }).retry, false);

  const notes: RejectionEntry[] = [];
  setRejectionNote(entry => notes.push(entry));
  try {
    const quota = () => { throw TOKEN_PLAN_2056; };
    const live = gateClient(fakeModel(quota, { create: quota }), "acct-2", "MiniMax", new ProviderRests());
    await assert.rejects(live.messages.create({ model: "m", max_tokens: 1, messages: [] } as never), /2056/);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.rejection, "quota_hold");
    assert.equal(notes[0]!.model, "rejected");
    assert.equal(notes[0]!.inputTokens, 0);
    assert.equal(notes[0]!.outputTokens, 0);
    assert.match(notes[0]!.reason, /2056/);

    const slow = Object.assign(new Error("速率限制 (2062)"), { status: 429 });
    const pace = () => { throw slow; };
    const paced = gateClient(fakeModel(pace, { create: pace }), "acct-3", "MiniMax", new ProviderRests());
    await assert.rejects(paced.messages.create({ model: "m", max_tokens: 1, messages: [] } as never), /2062/);
    assert.equal(notes[1]!.rejection, "retry_after");
    assert.match(notes[1]!.reason, /2062/);
    assert.equal(notes[1]!.inputTokens, 0);
  } finally {
    setRejectionNote(() => undefined);
  }
});
