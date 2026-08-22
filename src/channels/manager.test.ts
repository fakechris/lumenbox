/**
 * Tests for the channel manager: the front-door rules.
 *
 * The claim that matters most is the closed-by-default one — a discoverable bot
 * handle must not be a discoverable shell — so the refusal path is tested harder
 * than the happy path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChannelManager,
  parseAddress,
  refusal,
  type ChannelAdapter,
  type InboundMessage,
} from "./manager.ts";

function testAdapter(): ChannelAdapter & {
  inject: (message: InboundMessage) => Promise<string | undefined>;
  sent: { identity: string; text: string }[];
} {
  let handler: ((message: InboundMessage) => Promise<string | undefined>) | undefined;
  const sent: { identity: string; text: string }[] = [];
  return {
    name: "telegram",
    sent,
    start(onMessage) {
      handler = onMessage;
      return Promise.resolve();
    },
    stop() {},
    send(identity, text) {
      sent.push({ identity, text });
      return Promise.resolve();
    },
    inject(message) {
      if (handler === undefined) throw new Error("not started");
      return handler(message);
    },
  };
}

test("@Name addresses an agent; anything else is the default", () => {
  assert.deepEqual(parseAddress("@Bob check the release"), {
    agentName: "Bob",
    text: "check the release",
  });
  assert.deepEqual(parseAddress("  just do the thing  "), { text: "just do the thing" });
  // An email mid-sentence is not an address.
  assert.deepEqual(parseAddress("mail a@b.com please"), { text: "mail a@b.com please" });
});

test("nobody is allowed until somebody is: the refusal names the id and only the id", async () => {
  const adapter = testAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => false,
    ask: async (_agent, text) => {
      asked.push(text);
      return "done";
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  manager.start();
  await new Promise(resolve => setImmediate(resolve));

  const reply = await adapter.inject({
    identity: "telegram:99",
    senderLabel: "stranger",
    text: "rm -rf everything",
  });
  assert.match(reply ?? "", /Not authorised/);
  assert.match(reply ?? "", /telegram:99/, "the id is the one thing the owner needs");
  assert.deepEqual(asked, [], "nothing ran");
  assert.match(refusal("feishu:ou_1"), /feishu:ou_1/);
});

test("an allowed sender runs a turn and gets what the agent said", async () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({
    mayDrive: identity => identity === "telegram:7",
    ask: async (agentName, text, identity) => {
      assert.equal(agentName, "Bob");
      assert.equal(identity, "telegram:7");
      return `Bob did: ${text}`;
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  manager.start();
  await new Promise(resolve => setImmediate(resolve));

  const reply = await adapter.inject({
    identity: "telegram:7",
    senderLabel: "chris",
    text: "@Bob check the build",
  });
  assert.equal(reply, "Bob did: check the build");

  // An empty reply is still an answer, not silence.
  const quiet = new ChannelManager({
    mayDrive: identity => identity === "telegram:7",
    ask: async () => "",
    log: () => {},
  });
  const adapter2 = testAdapter();
  quiet.register(adapter2, true, "test");
  quiet.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(
    (await adapter2.inject({ identity: "telegram:7", senderLabel: "c", text: "hi" })) ?? "",
    /finished without saying/
  );
});

test("an approval notice reaches whoever last drove the agent from a channel, and nobody else", () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({
    mayDrive: identity => identity === "telegram:7",
    ask: async () => "ok",
    log: () => {},
  });
  manager.register(adapter, true, "test");
  manager.notifyApproval("agent-1", "a1", "Ada", "needs consent");
  assert.equal(adapter.sent.length, 0, "an agent never driven from a channel notifies nobody");

  manager.remember("agent-1", "telegram", "telegram:7");
  manager.notifyApproval("agent-1", "a1", "Ada", "needs consent");
  assert.equal(adapter.sent.length, 1);
  const pushed = adapter.sent[0]!;
  assert.equal(pushed.identity, "telegram:7");
  assert.match(pushed.text, /needs consent/);
});

test("a one-word reply answers the approval that was pushed to that chat", async () => {
  const adapter = testAdapter();
  const answered: { id: string; reply: string }[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "running",
    answerApproval: (id, reply) => {
      answered.push({ id, reply });
      return reply === "deny" ? "Refused." : "Allowed.";
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  manager.start();
  await new Promise(resolve => setImmediate(resolve));

  // No approval pending yet: "allow" is just a message and runs a turn.
  manager.remember("agent-1", "telegram", "telegram:7");
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "allow" });
  assert.deepEqual(answered, [], "with nothing pending, a word is not a decision");

  // Push an approval to this chat, then a one-word reply answers it — no turn.
  manager.notifyApproval("agent-1", "appr-9", "Ada", "download from unlisted host");
  const reply = await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "Allow" });
  assert.deepEqual(answered, [{ id: "appr-9", reply: "once" }], "case-insensitive, answered once");
  assert.equal(reply, "Allowed.");

  // The mapping is cleared: a later "allow" does not approve something new.
  answered.length = 0;
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "allow" });
  assert.deepEqual(answered, [], "a stray word later approves nothing");
});

test("parseApprovalReply reads only a whole-message verb", async () => {
  const { parseApprovalReply } = await import("./manager.ts");
  assert.equal(parseApprovalReply("allow"), "once");
  assert.equal(parseApprovalReply("  ALWAYS "), "always");
  assert.equal(parseApprovalReply("deny."), "deny");
  assert.equal(parseApprovalReply("同意"), "once");
  assert.equal(parseApprovalReply("allow the download"), undefined, "a sentence is not a decision");
  assert.equal(parseApprovalReply("please do it"), undefined);
});

test("a pushed approval answered from the app leaves the chat reply saying so", async () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    answerApproval: () => undefined, // no longer pending
    log: () => {},
  });
  manager.register(adapter, true, "test");
  manager.start();
  await new Promise(resolve => setImmediate(resolve));
  manager.remember("agent-1", "telegram", "telegram:7");
  manager.notifyApproval("agent-1", "appr-1", "Ada", "do the thing");
  const reply = await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "deny" });
  assert.match(reply ?? "", /no longer waiting/);
});
