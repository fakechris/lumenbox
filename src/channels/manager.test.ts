/**
 * Tests for the channel manager: the front-door rules.
 *
 * The claim that matters most is the closed-by-default one — a discoverable bot
 * handle must not be a discoverable shell — so the refusal path is tested harder
 * than the happy path. The second claim is the accepted-is-not-answered one: the
 * wire is acknowledged in milliseconds, the work lands later as a push, and what
 * gets pushed when is a contract these tests pin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChannelManager,
  parseAddress,
  refusal,
  type ChannelAdapter,
  type InboundMessage,
  type TaskCardState,
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

/** An adapter that can address chats and render cards, the way Feishu can. */
function cardAdapter(): ReturnType<typeof testAdapter> & {
  chatSent: { chatKey: string; text: string }[];
  cards: { handle: string; card: TaskCardState }[];
} {
  const base = testAdapter();
  const chatSent: { chatKey: string; text: string }[] = [];
  const cards: { handle: string; card: TaskCardState }[] = [];
  let nextHandle = 0;
  return Object.assign(base, {
    chatSent,
    cards,
    sendToChat(chatKey: string, text: string) {
      chatSent.push({ chatKey, text });
      return Promise.resolve();
    },
    postTaskCard(_chatKey: string, card: TaskCardState) {
      const handle = `card-${nextHandle++}`;
      cards.push({ handle, card });
      return Promise.resolve(handle);
    },
    updateTaskCard(handle: string, card: TaskCardState) {
      cards.push({ handle, card });
      return Promise.resolve();
    },
  });
}

async function started(manager: ChannelManager): Promise<void> {
  manager.start();
  await new Promise(resolve => setImmediate(resolve));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  await started(manager);

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

test("an allowed sender's answer arrives as a push, not as the wire reply", async () => {
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
  await started(manager);

  const reply = await adapter.inject({
    identity: "telegram:7",
    senderLabel: "chris",
    text: "@Bob check the build",
  });
  assert.equal(reply, undefined, "the wire gets its acknowledgement, not the answer");
  await manager.idle();
  assert.deepEqual(adapter.sent, [{ identity: "telegram:7", text: "Bob did: check the build" }]);

  // An empty reply is still an answer, not silence.
  const quiet = new ChannelManager({
    mayDrive: identity => identity === "telegram:7",
    ask: async () => "",
    log: () => {},
  });
  const adapter2 = testAdapter();
  quiet.register(adapter2, true, "test");
  await started(quiet);
  await adapter2.inject({ identity: "telegram:7", senderLabel: "c", text: "hi" });
  await quiet.idle();
  assert.match(adapter2.sent[0]?.text ?? "", /finished without saying/);
});

test("a quick turn posts its answer alone; a slow one says it is under way first", async () => {
  const adapter = testAdapter();
  let slow = false;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => {
      if (slow) await sleep(60);
      return "the answer";
    },
    ackAfterMs: 25,
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "quick one" });
  await manager.idle();
  assert.deepEqual(
    adapter.sent.map(entry => entry.text),
    ["the answer"],
    "no 'working on it' in front of an answer that was already there"
  );

  adapter.sent.length = 0;
  slow = true;
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "@Ada slow one" });
  await manager.idle();
  assert.equal(adapter.sent.length, 2);
  assert.match(adapter.sent[0]!.text, /Ada is on it/);
  assert.match(adapter.sent[0]!.text, /posted here/);
  assert.equal(adapter.sent[1]!.text, "the answer");
});

test("queued work is acknowledged immediately, with how many are ahead", async () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "eventually",
    ahead: () => 2,
    ackAfterMs: 5_000,
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "another thing" });
  await manager.idle();
  assert.equal(adapter.sent.length, 2, "queued is known-slow: no threshold wait");
  assert.match(adapter.sent[0]!.text, /2 requests ahead/);
  assert.equal(adapter.sent[1]!.text, "eventually");
});

test("a failed turn pushes the error instead of going quiet", async () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => {
      throw new Error("No agent named Zed.");
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "@Zed do it" });
  await manager.idle();
  assert.deepEqual(adapter.sent.map(entry => entry.text), ["No agent named Zed."]);
});

test("a card-capable chat gets a card that finishes, and the answer addressed to the chat", async () => {
  const adapter = cardAdapter();
  let progress: ((action: string) => void) | undefined;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, _t, _i, _c, onProgress) => {
      progress = onProgress;
      await sleep(60);
      return "report ready";
    },
    ackAfterMs: 10,
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "@Rex weekly report\nwith details",
  });
  await sleep(30);
  progress?.("bash: build-report");
  await manager.idle();

  const first = adapter.cards[0]!;
  assert.equal(first.card.status, "working");
  assert.equal(first.card.title, "weekly report", "the header is the first line only");
  assert.equal(first.card.agentName, "Rex");
  assert.equal(first.card.requesterLabel, "chris");

  const last = adapter.cards[adapter.cards.length - 1]!;
  assert.equal(last.handle, first.handle, "finished by rewriting the same card");
  assert.equal(last.card.status, "done");
  assert.equal(last.card.action, undefined, "a finished card does not claim a current action");

  assert.deepEqual(adapter.chatSent, [{ chatKey: "feishu:oc_room", text: "report ready" }]);
  assert.deepEqual(adapter.sent, [], "nothing routed by identity when the chat is addressable");
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
  await started(manager);

  // No approval pending yet: "allow" is just a message and runs a turn.
  manager.remember("agent-1", "telegram", "telegram:7");
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "allow" });
  await manager.idle();
  assert.deepEqual(answered, [], "with nothing pending, a word is not a decision");

  // Push an approval to this chat, then a one-word reply answers it — no turn.
  manager.notifyApproval("agent-1", "appr-9", "Ada", "download from unlisted host");
  const reply = await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "Allow" });
  assert.deepEqual(answered, [{ id: "appr-9", reply: "once" }], "case-insensitive, answered once");
  assert.equal(reply, "Allowed.", "a decision is the whole response, answered on the wire");

  // The mapping is cleared: a later "allow" does not approve something new.
  answered.length = 0;
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "allow" });
  await manager.idle();
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
  await started(manager);
  manager.remember("agent-1", "telegram", "telegram:7");
  manager.notifyApproval("agent-1", "appr-1", "Ada", "do the thing");
  const reply = await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "deny" });
  assert.match(reply ?? "", /no longer waiting/);
});
