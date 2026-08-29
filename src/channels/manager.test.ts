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

/** An adapter that can address chats, render cards and show images, the way Feishu can. */
function cardAdapter(): ReturnType<typeof testAdapter> & {
  chatSent: { chatKey: string; text: string; replyTo?: string }[];
  cards: { handle: string; card: TaskCardState; replyTo?: string }[];
  images: { chatKey: string; base64: string; replyTo?: string }[];
  statuses: { id: string; status: string }[];
} {
  const base = testAdapter();
  const chatSent: { chatKey: string; text: string; replyTo?: string }[] = [];
  const cards: { handle: string; card: TaskCardState; replyTo?: string }[] = [];
  const images: { chatKey: string; base64: string; replyTo?: string }[] = [];
  const statuses: { id: string; status: string }[] = [];
  let nextHandle = 0;
  const anchored = (replyTo: string | undefined) =>
    replyTo === undefined ? {} : { replyTo };
  return Object.assign(base, {
    chatSent,
    cards,
    images,
    statuses,
    sendToChat(chatKey: string, text: string, options?: { replyTo?: string }) {
      chatSent.push({ chatKey, text, ...anchored(options?.replyTo) });
      return Promise.resolve();
    },
    postTaskCard(_chatKey: string, card: TaskCardState, options?: { replyTo?: string }) {
      const handle = `card-${nextHandle++}`;
      cards.push({ handle, card, ...anchored(options?.replyTo) });
      return Promise.resolve(handle);
    },
    updateTaskCard(handle: string, card: TaskCardState) {
      cards.push({ handle, card });
      return Promise.resolve();
    },
    sendImage(chatKey: string, base64: string, options?: { replyTo?: string }) {
      images.push({ chatKey, base64, ...anchored(options?.replyTo) });
      return Promise.resolve();
    },
    noteStatus(id: string, status: string) {
      statuses.push({ id, status });
      return Promise.resolve();
    },
    sentFiles: [] as { name: string; replyTo?: string }[],
    sendFile(this: { sentFiles: { name: string; replyTo?: string }[] }, _chatKey: string, name: string, _base64: string, options?: { replyTo?: string }) {
      this.sentFiles.push({ name, ...anchored(options?.replyTo) });
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
  assert.match(adapter2.sent[0]?.text ?? "", /没有留下说明/);
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
  assert.match(adapter.sent[0]!.text, /Ada开工了/);
  assert.match(adapter.sent[0]!.text, /发在这里/);
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
  assert.match(adapter.sent[0]!.text, /前面还有 2 件/);
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

test("a whole-message screen request posts the desktop and runs no turn", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "x";
    },
    screenshot: async agentName => {
      assert.equal(agentName, "Rex");
      return "img64";
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "@Rex 屏幕",
  });
  await manager.idle();
  assert.deepEqual(adapter.images, [{ chatKey: "feishu:oc_room", base64: "img64" }]);
  assert.deepEqual(asked, [], "a look is not a task");

  // A sentence about the screen is a task, not a look.
  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "看看屏幕上的报错是什么",
  });
  await manager.idle();
  assert.equal(asked.length, 1, "the sentence ran a turn");
});

test("a screen request degrades honestly: no image wire, or no desktop", async () => {
  const adapter = testAdapter(); // no sendImage
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    screenshot: async () => "img64",
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);
  await adapter.inject({ identity: "telegram:7", senderLabel: "c", text: "screen" });
  await manager.idle();
  assert.match(adapter.sent[0]!.text, /cannot show images/);

  const noDesk = cardAdapter();
  const manager2 = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    screenshot: async () => undefined,
    log: () => {},
  });
  manager2.register(noDesk, true, "test");
  await started(manager2);
  await noDesk.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_r", senderLabel: "c", text: "屏幕" });
  await manager2.idle();
  assert.match(noDesk.chatSent[0]!.text, /No desktop to show/);
  assert.deepEqual(noDesk.images, []);
});

test("a finished task attaches the desktop only when the turn actually used it", async () => {
  const adapter = cardAdapter();
  let progress: ((action: string, tool?: string) => void) | undefined;
  let slow = false;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, _t, _i, _c, onProgress) => {
      progress = onProgress;
      if (slow) await sleep(60);
      return "answer";
    },
    screenshot: async () => "final-desk",
    ackAfterMs: 25,
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_r", senderLabel: "c", text: "quick" });
  await manager.idle();
  assert.deepEqual(adapter.images, [], "a quick answer does not need a poster");

  slow = true;
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_r", senderLabel: "c", text: "research it" });
  await sleep(30);
  progress?.("bash: curl example.com", "bash");
  await manager.idle();
  assert.deepEqual(
    adapter.images,
    [],
    "a turn that never touched the desktop has no desk worth showing"
  );

  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_r", senderLabel: "c", text: "open the site" });
  await sleep(30);
  progress?.("computer: click", "computer");
  await manager.idle();
  assert.deepEqual(adapter.images, [{ chatKey: "feishu:oc_r", base64: "final-desk" }]);
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

test("a stranger's knock is recorded, and the refusal says the owner was told", async () => {
  const adapter = testAdapter();
  const knocks: { identity: string; senderLabel: string; channel: string }[] = [];
  const manager = new ChannelManager({
    mayDrive: () => false,
    ask: async () => "x",
    knock: request => knocks.push(request),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const reply = await adapter.inject({
    identity: "feishu:ou_9",
    senderLabel: "newcomer",
    text: "hello?",
  });
  assert.deepEqual(knocks, [
    { identity: "feishu:ou_9", senderLabel: "newcomer", channel: "telegram" },
  ]);
  assert.match(reply ?? "", /owner has been notified/);
  assert.match(reply ?? "", /feishu:ou_9/, "the manual path still shows the id");
});

test("bind <code> is redeemed before the allow list, and a sentence is not a code", async () => {
  const adapter = testAdapter();
  const bound: { code: string; identity: string }[] = [];
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => false, // nobody is allowed: binding must still work
    ask: async (_a, text) => {
      asked.push(text);
      return "x";
    },
    bind: (code, identity) => {
      bound.push({ code, identity });
      return code === "4F7KQZ" ? "You're in as driver." : "That code is not live.";
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const ok = await adapter.inject({ identity: "tg:1", senderLabel: "n", text: "绑定 4f7kqz" });
  assert.equal(ok, "You're in as driver.");
  assert.deepEqual(bound, [{ code: "4F7KQZ", identity: "tg:1" }], "case-normalised");

  const miss = await adapter.inject({ identity: "tg:1", senderLabel: "n", text: "bind NOPE99" });
  assert.match(miss ?? "", /not live/);

  const sentence = await adapter.inject({
    identity: "tg:1",
    senderLabel: "n",
    text: "bind the library to the app please",
  });
  assert.match(sentence ?? "", /Not authorised|notified/, "a sentence knocks, it does not bind");
  assert.deepEqual(asked, [], "no turn ran for any of it");
});

test("push routes a line through the named adapter to the identity", async () => {
  const adapter = testAdapter();
  const manager = new ChannelManager({ mayDrive: () => true, ask: async () => "x", log: () => {} });
  manager.register(adapter, true, "test");
  await manager.push("telegram", "telegram:7", "You're in.");
  await manager.push("feishu", "feishu:ou_1", "lost"); // no such adapter: dropped, not thrown
  assert.deepEqual(adapter.sent, [{ identity: "telegram:7", text: "You're in." }]);
});

test("the digest verbs are decisions, answered on the wire; a sentence about the digest is a task", async () => {
  const { parseDigestRequest } = await import("./manager.ts");
  assert.deepEqual(parseDigestRequest("早报"), { kind: "now" });
  assert.deepEqual(parseDigestRequest("digest"), { kind: "now" });
  assert.deepEqual(parseDigestRequest("早报 8点"), { kind: "schedule", hour: 8 });
  assert.deepEqual(parseDigestRequest("digest at 21"), { kind: "schedule", hour: 21 });
  assert.deepEqual(parseDigestRequest("早报 关"), { kind: "off" });
  assert.equal(parseDigestRequest("早报什么时候发"), undefined, "a sentence is not a command");
  assert.equal(parseDigestRequest("digest at 25"), undefined, "25 is not an hour");

  const adapter = testAdapter();
  const calls: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      calls.push(`turn:${text}`);
      return "x";
    },
    digest: {
      build: chatKey => {
        calls.push(`build:${chatKey}`);
        return "Daily digest\nClosed (24h): nothing";
      },
      schedule: (_chatKey, hour) => {
        calls.push(`schedule:${hour}`);
        return "set";
      },
      off: () => {
        calls.push("off");
        return "off";
      },
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const now = await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "c",
    text: "早报",
  });
  assert.match(now ?? "", /Daily digest/);
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "c", text: "早报 8点" });
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "c", text: "digest off" });
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "c", text: "早报什么时候发" });
  await manager.idle();
  assert.deepEqual(calls, [
    "build:feishu:oc_room",
    "schedule:8",
    "off",
    "turn:早报什么时候发",
  ]);
});

test("reading the chat's scope is open; binding it is an admin's call", async () => {
  const adapter = testAdapter();
  const calls: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    mayAdmin: identity => identity === "feishu:boss",
    ask: async (_a, text) => {
      calls.push(`turn:${text}`);
      return "x";
    },
    chatScope: {
      show: () => "This chat is bound to scope \"vendor\".",
      bind: (_chatKey, name) => {
        calls.push(`bind:${name}`);
        return "Bound.";
      },
      off: () => {
        calls.push("off");
        return "Unbound.";
      },
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);
  const at = (identity: string, text: string) =>
    adapter.inject({ identity, chatKey: "feishu:oc_room", senderLabel: "x", text });

  assert.match((await at("feishu:member", "scope")) ?? "", /vendor/, "anyone may read");
  assert.match((await at("feishu:member", "scope vendor-work")) ?? "", /管理员来定/);
  assert.match((await at("feishu:boss", "scope vendor-work")) ?? "", /Bound/);
  assert.match((await at("feishu:boss", "scope off")) ?? "", /Unbound/);
  await at("feishu:member", "scope out the venue options");
  await manager.idle();
  assert.deepEqual(calls, ["bind:vendor-work", "off", "turn:scope out the venue options"]);
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

test("everything a task says sits under the message that asked for it", async () => {
  const adapter = cardAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => {
      await sleep(50);
      return "threaded answer";
    },
    ackAfterMs: 10,
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_ask",
    senderLabel: "chris",
    text: "@Rex long thing",
  });
  await manager.idle();

  assert.equal(adapter.cards[0]!.replyTo, "om_ask", "the card opens the topic");
  assert.equal(adapter.chatSent[0]!.replyTo, "om_ask", "the answer lands in it");
  assert.deepEqual(
    adapter.statuses,
    [
      { id: "om_ask", status: "working" },
      { id: "om_ask", status: "done" },
    ],
    "the asking message is marked while the work runs, and unmarked when it lands"
  );

  // A failure marks the message instead of leaving the working mark to rot.
  const failing = new ChannelManager({
    mayDrive: () => true,
    ask: async () => {
      throw new Error("boom");
    },
    log: () => {},
  });
  const adapter2 = cardAdapter();
  failing.register(adapter2, true, "test");
  await started(failing);
  await adapter2.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_2",
    senderLabel: "c",
    text: "do it",
  });
  await failing.idle();
  assert.deepEqual(adapter2.statuses.at(-1), { id: "om_2", status: "failed" });

  // No wire id, no anchoring — and nothing pretends otherwise.
  const bare = cardAdapter();
  const plain = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "loose answer",
    log: () => {},
  });
  plain.register(bare, true, "test");
  await started(plain);
  await bare.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "c", text: "hi" });
  await plain.idle();
  assert.equal(bare.chatSent[0]!.replyTo, undefined);
  assert.deepEqual(bare.statuses, []);
});

test("a channel request lives on the board: opened, started at first work, closed with what happened", async () => {
  const adapter = cardAdapter();
  const events: string[] = [];
  let fail = false;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, _t, _i, _c, onProgress) => {
      onProgress?.("bash: run");
      onProgress?.("bash: run again");
      if (fail) throw new Error("box on fire");
      return "done";
    },
    ackAfterMs: 10,
    board: {
      open: input => {
        events.push(`open ${input.title} by ${input.senderLabel} for ${input.agentName ?? "-"}`);
        return "t7";
      },
      started: id => events.push(`started ${id}`),
      closed: (id, outcome, note) => {
        events.push(`closed ${id} ${outcome}${note ? ` (${note})` : ""}`);
        return outcome;
      },
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "@Rex ship the report",
  });
  await manager.idle();
  assert.deepEqual(events, [
    "open ship the report by chris for Rex",
    "started t7", // once, not once per progress event
    "closed t7 done",
  ]);

  events.length = 0;
  fail = true;
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris", text: "again" });
  await manager.idle();
  assert.deepEqual(events, [
    "open again by chris for -",
    "started t7",
    "closed t7 failed (box on fire)",
  ]);
});

test("看板 answers from the board on the wire, and no turn runs", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const shown: string[] = [];
  const view = {
    liveCount: 1,
    groups: [{ heading: "进行中", tasks: [{ id: "t1", who: "Ada", title: "报表" }] }],
    done: [],
  };
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "x";
    },
    board: {
      open: () => "t1",
      started: () => {},
      closed: () => "done",
      show: chatKey => {
        shown.push(chatKey);
        return view;
      },
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const reply = await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "看板",
  });
  assert.equal(reply, "看板 · 1 件在办\n进行中:\n  t1 @Ada 报表");
  assert.deepEqual(shown, ["feishu:oc_room"], "asked for the room's board");
  assert.deepEqual(asked, [], "a look at the board is not work");

  // A sentence *about* the board is work, not the verb.
  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "看板上加一条明天的任务",
  });
  await manager.idle();
  assert.equal(asked.length, 1);
});

test("看板 rides as a card where the wire draws one, and falls back to text when the card fails", async () => {
  const adapter = cardAdapter();
  const boardCards: { chatKey: string; liveCount: number }[] = [];
  let cardBroken = false;
  const withBoard = Object.assign(adapter, {
    postBoardCard(chatKey: string, view: { liveCount: number }) {
      if (cardBroken) return Promise.reject(new Error("card refused"));
      boardCards.push({ chatKey, liveCount: view.liveCount });
      return Promise.resolve();
    },
  });
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    board: {
      open: () => "t1",
      started: () => {},
      closed: () => "done",
      show: () => ({ liveCount: 2, groups: [], done: [] }),
    },
    log: () => {},
  });
  manager.register(withBoard, true, "test");
  await started(manager);

  const asCard = await withBoard.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "看板",
  });
  assert.equal(asCard, undefined, "the card is the whole answer");
  assert.deepEqual(boardCards, [{ chatKey: "feishu:oc_room", liveCount: 2 }]);

  cardBroken = true;
  const asText = await withBoard.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "看板",
  });
  assert.equal(asText, "这个群现在没有挂着的任务。", "a failed card degrades to the text form");
});

test("the person's whole message rides on the board entry as its description", async () => {
  const adapter = cardAdapter();
  let opened: { title: string; description?: string } | undefined;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "ok",
    ackAfterMs: 10,
    board: {
      open: input => {
        opened = { title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) };
        return "t1";
      },
      started: () => {},
      closed: () => "done",
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "整理报表\n把 Q3 的三个文件夹都算上,输出一个汇总 xlsx",
  });
  await manager.idle();
  assert.equal(opened?.description, "整理报表\n把 Q3 的三个文件夹都算上,输出一个汇总 xlsx");
  // The title stays the compact form; the description is where the whole message lives.
  assert.notEqual(opened?.title, opened?.description);
});

test("a card outlives its process: a fresh manager flips it through the ledger", async () => {
  // The two lies this removes, both seen live: a restart orphaning every running
  // card at 进行中 forever, and "可以" accepting reviewed work with no card flip —
  // the handle lived in a closure that was gone by the time the acceptance arrived.
  const { CardLedger } = await import("./card-ledger.ts");
  const ledger = new CardLedger(null);

  const adapter1 = cardAdapter();
  const manager1 = new ChannelManager({
    mayDrive: () => true,
    // Slow enough to earn a card: the acknowledgement threshold is what separates a
    // quick answer from carded work.
    ask: async () => {
      await sleep(40);
      return "留给你验收。";
    },
    ackAfterMs: 10,
    cards: ledger,
    board: {
      open: () => "t7",
      started: () => {},
      // The agent parked it for review; the card ends orange and the ledger keeps it.
      closed: () => "review",
    },
    log: () => {},
  });
  manager1.register(adapter1, true, "test");
  await started(manager1);
  await adapter1.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "整理一下报表",
  });
  await manager1.idle();
  const handle = adapter1.cards[0]!.handle;
  assert.equal(ledger.get("t7")?.card.status, "review", "the ledger mirrors the card");

  // "The restart": a new manager, a new adapter instance under the same name, and
  // only the ledger in common.
  const adapter2 = cardAdapter();
  const manager2 = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    cards: ledger,
    log: () => {},
  });
  manager2.register(adapter2, true, "test");
  manager2.syncTaskCard("t7", "done");
  await new Promise(resolve => setImmediate(resolve));

  const flip = adapter2.cards.find(entry => entry.handle === handle);
  assert.ok(flip !== undefined, "the old card was rewritten by its recorded handle");
  assert.equal(flip.card.status, "done");
  assert.equal(ledger.get("t7"), undefined, "green is final; the record can go");
  // And a second sync is a no-op, not a second write.
  manager2.syncTaskCard("t7", "done");
  assert.equal(adapter2.cards.length, 1);
});

test("a dropped file is stored and acknowledged, and no task opens", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const received: { chatKey: string; names: string[] }[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    // The look is scheduled but deliberately out of this test's frame.
    lookAfterMs: 60_000,
    ask: async (_a, text) => {
      asked.push(text);
      return "x";
    },
    receiveFiles: async (chatKey, files) => {
      received.push({ chatKey, names: files.map(file => file.name) });
      return files.map(file => `inbox/${file.name}`);
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_file",
    senderLabel: "chris",
    text: "",
    files: [{ name: "report.pdf", base64: "cGRm" }],
  });
  await manager.idle();

  assert.deepEqual(received, [{ chatKey: "feishu:oc_room", names: ["report.pdf"] }]);
  assert.deepEqual(asked, [], "a delivery is not an instruction");
  assert.match(adapter.chatSent[0]!.text, /收到:report\.pdf/);
  assert.equal(adapter.chatSent[0]!.replyTo, "om_file", "the receipt sits under the drop");

  // Nowhere to store: the chat is told plainly, not left to wonder.
  const boxless = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "x",
    receiveFiles: async () => undefined,
    log: () => {},
  });
  const adapter2 = cardAdapter();
  boxless.register(adapter2, true, "test");
  await started(boxless);
  await adapter2.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_r",
    senderLabel: "c",
    text: "",
    files: [{ name: "a.txt", base64: "eA==" }],
  });
  await boxless.idle();
  assert.match(adapter2.chatSent[0]!.text, /没有开着的工作机/);
});

test("a wordless drop is looked at: content first, then the chat hears what it is", async () => {
  // The observed complaint, verbatim: 「收到:image-4138d948.png。说一句要做什么就开工」
  // — a person hands something over and gets a form to fill in. The agent should look
  // at the thing and speak from its content.
  const adapter = cardAdapter();
  const asked: string[] = [];
  const opened: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    lookAfterMs: 20,
    ask: async (_a, text) => {
      asked.push(text);
      return "这是一张二维码截图,指向 FoloToy 的官网。要我查一下这个项目吗?";
    },
    board: {
      open: input => {
        opened.push(input.title);
        return "t1";
      },
      started: () => {},
      closed: () => "done",
    },
    receiveFiles: async (_c, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_drop",
    senderLabel: "chris",
    text: "",
    files: [{ name: "qr.png", base64: "cG5n" }],
  });
  await sleep(60);
  await manager.idle();

  assert.equal(asked.length, 1, "one look ran");
  assert.match(asked[0]!, /qr\.png/);
  assert.match(asked[0]!, /先看内容/);
  assert.deepEqual(opened, [], "a look is not work: no board row, no card");
  const look = adapter.chatSent.at(-1)!;
  assert.match(look.text, /二维码/);
  assert.equal(look.replyTo, "om_drop", "the look's answer sits under the drop");
});

test("an instruction inside the look window becomes the task; no separate look runs", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    lookAfterMs: 40,
    ask: async (_a, text) => {
      asked.push(text);
      return "ok";
    },
    receiveFiles: async (_c, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "",
    files: [{ name: "a.csv", base64: "eA==" }, { name: "b.csv", base64: "eA==" }],
  });
  // The drop finishes storing before the instruction arrives — which is also the real
  // ordering: storeFiles is milliseconds, people are seconds.
  await manager.idle();
  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "把两个表合并",
  });
  await sleep(90);
  await manager.idle();

  assert.equal(asked.length, 1, "the instruction is the only turn");
  assert.match(asked[0]!, /把两个表合并/);
  assert.match(asked[0]!, /a\.csv, inbox\/b\.csv|a\.csv/, "the files ride with the instruction");
});

test("a folder drop gets one look, not one per file", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    lookAfterMs: 40,
    ask: async (_a, text) => {
      asked.push(text);
      return "三份报表,格式一致。要我汇总吗?";
    },
    receiveFiles: async (_c, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  for (const name of ["q1.xlsx", "q2.xlsx", "q3.xlsx"]) {
    await adapter.inject({
      identity: "feishu:ou_1",
      chatKey: "feishu:oc_room",
      senderLabel: "chris",
      text: "",
      files: [{ name, base64: "eA==" }],
    });
    await sleep(10);
  }
  await sleep(90);
  await manager.idle();

  assert.equal(asked.length, 1, "the debounce merged the folder into one look");
  assert.match(asked[0]!, /q1\.xlsx/);
  assert.match(asked[0]!, /q3\.xlsx/);
});

test("a finished task ships the outbox — images as images, files as files, delivered once", async () => {
  const adapter = cardAdapter();
  const delivered: string[][] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "here you go",
    collectOutbox: async chatKey => {
      assert.equal(chatKey, "feishu:oc_room");
      return [
        { name: "chart.png", base64: "cGl4ZWxz" },
        { name: "report.pdf", base64: "cGRm" },
      ];
    },
    outboxDelivered: async (_chatKey, names) => {
      delivered.push(names);
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_files",
    senderLabel: "c",
    text: "make the report",
  });
  await manager.idle();

  assert.deepEqual(adapter.images, [
    { chatKey: "feishu:oc_room", base64: "cGl4ZWxz", replyTo: "om_files" },
  ]);
  assert.deepEqual(
    (adapter as unknown as { sentFiles: { name: string; replyTo?: string }[] }).sentFiles,
    [{ name: "report.pdf", replyTo: "om_files" }]
  );
  assert.deepEqual(delivered, [["chart.png", "report.pdf"]]);
});

test("an approval goes out as a card where the wire has buttons, and a press answers it", async () => {
  const adapter = testAdapter();
  const cards: { identity: string; approvalId: string }[] = [];
  let press:
    | ((input: { approvalId: string; reply: "once" | "always" | "session" | "deny"; identity: string }) => Promise<string | undefined>)
    | undefined;
  const withButtons = Object.assign(adapter, {
    postApprovalCard(identity: string, card: { approvalId: string }) {
      cards.push({ identity, approvalId: card.approvalId });
      return Promise.resolve();
    },
    onApprovalAction(handler: NonNullable<typeof press>) {
      press = handler;
    },
  });
  const answered: { id: string; reply: string }[] = [];
  const manager = new ChannelManager({
    mayDrive: identity => identity === "feishu:driver",
    ask: async () => "x",
    answerApproval: (id, reply) => {
      answered.push({ id, reply });
      return "Allowed.";
    },
    log: () => {},
  });
  manager.register(withButtons, true, "test");
  await started(manager);

  manager.remember("agent-1", "telegram", "feishu:driver");
  manager.notifyApproval("agent-1", "appr-2", "Ada", "run the deploy");
  assert.deepEqual(cards, [{ identity: "feishu:driver", approvalId: "appr-2" }]);
  assert.equal(adapter.sent.length, 0, "a card, not a text");

  // A stranger's press does nothing; a driver's press answers.
  assert.equal(await press!({ approvalId: "appr-2", reply: "once", identity: "feishu:stranger" }), undefined);
  assert.deepEqual(answered, []);
  assert.equal(await press!({ approvalId: "appr-2", reply: "once", identity: "feishu:driver" }), "Allowed.");
  assert.deepEqual(answered, [{ id: "appr-2", reply: "once" }]);

  // The word path was cleared by the press: a later "allow" approves nothing new.
  const stray = await adapter.inject({ identity: "feishu:driver", senderLabel: "c", text: "allow" });
  assert.equal(stray, undefined, "just a message that runs a turn, not a decision");
  await manager.idle();
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

test("a chat's files follow the conversation, and its reply follows the room", async () => {
  // These came apart when conversations began following threads: the prompt told the agent
  // its files were under the conversation's directory while the server read the room's, so
  // it was sent to a path nothing wrote and nothing read. It noticed and said so, which is
  // the only reason this was caught before somebody lost a deliverable.
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "done",
    collectOutbox: async key => {
      asked.push(key);
      return [];
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    threadKey: "feishu:oc_room:omt_topic",
    messageId: "om_1",
    senderLabel: "chris",
    text: "do a thing",
  });
  await manager.idle();

  // The topic owns the files; the room is still where the answer is posted.
  assert.deepEqual(asked, ["feishu:oc_room:omt_topic"]);
  assert.equal(adapter.chatSent.at(-1)?.text, "done");
});

test("a task the agent left in review shows on the card as review, not as done", async () => {
  // The other half of t51. The board was corrected to keep the agent's `review`, and the
  // card still said Done -- because it was being set in parallel with the board call rather
  // than from its answer. Fixing the record and leaving the lie on screen fixes nothing:
  // the card is the surface the person actually looks at.
  const adapter = cardAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    // Slow enough to get a card at all: the card exists to answer "is it working", so a
    // reply that comes back instantly never posts one.
    ackAfterMs: 1,
    ask: async (_a, _t, _i, _c, onProgress) => {
      onProgress?.("bash: free -h");
      await new Promise(resolve => setTimeout(resolve, 20));
      return "waiting for your next step";
    },
    board: {
      open: () => "t51",
      started: () => {},
      // What the real board now returns for work the agent deliberately parked.
      closed: () => "review",
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    senderLabel: "chris",
    text: "size the local models",
  });
  await manager.idle();

  const shown = adapter.cards.map(entry => entry.card.status);
  assert.equal(shown.at(-1), "review", "the card ends on what the board decided");
  assert.ok(!shown.includes("done"), "and never passes through Done on the way");
});

test("a file with its instruction in one message starts the work, files named in the prompt", async () => {
  // The walkthrough's step zero, and it was broken: any message carrying files was
  // diverted to the save-only branch, its text ignored, and the person told (in English)
  // to say what they wanted — which they had just done.
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "开工了";
    },
    receiveFiles: async (_chatKey, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    messageId: "om_1",
    senderLabel: "chris",
    text: "每份提取营收和毛利,汇总一张总表",
    files: [{ name: "q3.xlsx", base64: "eA==" }],
  });
  await manager.idle();

  assert.equal(asked.length, 1, "the instruction runs a turn");
  assert.match(asked[0]!, /每份提取营收和毛利/);
  assert.match(asked[0]!, /inbox\/q3\.xlsx/, "the agent is told where the files landed, not left to guess");
});

test("files first, instruction next: the next message in the conversation picks the files up", async () => {
  // The Feishu reality: a file message carries no text (text: ""), so drag-folder-then-type
  // is always two messages. The drop is remembered per conversation and the next
  // instruction consumes it — once, because the message after that is about something else.
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "好";
    },
    receiveFiles: async (_chatKey, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const room = { identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris" };
  await adapter.inject({ ...room, messageId: "om_f1", text: "", files: [{ name: "a.xlsx", base64: "eA==" }] });
  await adapter.inject({ ...room, messageId: "om_f2", text: "", files: [{ name: "b.xlsx", base64: "eA==" }] });
  await manager.idle();
  assert.deepEqual(asked, [], "drops alone still run nothing");

  await adapter.inject({ ...room, messageId: "om_t", text: "汇总这两份" });
  await manager.idle();
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /inbox\/a\.xlsx/);
  assert.match(asked[0]!, /inbox\/b\.xlsx/, "both drops are handed to the turn");

  await adapter.inject({ ...room, messageId: "om_t2", text: "再检查一遍" });
  await manager.idle();
  assert.equal(asked.length, 2);
  assert.ok(!/inbox\/a\.xlsx/.test(asked[1]!), "consumed once — later asks are not haunted by old files");
});

test("a drop in one conversation does not leak into another's next instruction", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "好";
    },
    receiveFiles: async (_chatKey, files) => files.map(file => `inbox/${file.name}`),
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({
    identity: "feishu:ou_1",
    chatKey: "feishu:oc_room",
    threadKey: "feishu:oc_room-om_threadA",
    senderLabel: "chris",
    text: "",
    files: [{ name: "secret.xlsx", base64: "eA==" }],
  });
  await adapter.inject({
    identity: "feishu:ou_2",
    chatKey: "feishu:oc_room",
    threadKey: "feishu:oc_room-om_threadB",
    senderLabel: "b",
    text: "帮我写个周报",
  });
  await manager.idle();
  assert.equal(asked.length, 1);
  assert.ok(!/secret\.xlsx/.test(asked[0]!), "files belong to the thread they were dropped in");
});

test("a question with choices becomes a card where the wire has cards, words elsewhere", async () => {
  const cards: { question: string; options: string[] }[] = [];
  const adapter = cardAdapter();
  (adapter as unknown as { postQuestionCard: unknown }).postQuestionCard = async (
    _identity: string,
    card: { question: string; options: string[] }
  ) => {
    cards.push({ question: card.question, options: card.options });
  };
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => "ok",
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  // The asker is whoever last drove this agent from the chat — recorded by the ask
  // wiring, which in production calls remember() with the agent's real id.
  manager.remember("a1", adapter.name, "feishu:ou_1");

  manager.askQuestion({ agentId: "a1", agentName: "Ada", question: "跳过还是停?", options: ["跳过", "停"] });
  await manager.idle();
  assert.deepEqual(cards, [{ question: "跳过还是停?", options: ["跳过", "停"] }]);
  assert.ok(
    !adapter.sent.some(entry => /有个问题/.test(entry.text)),
    "the card replaces the text push rather than doubling it"
  );

  // No options: nothing to press, so it stays words.
  manager.askQuestion({ agentId: "a1", agentName: "Ada", question: "你想怎么办?" });
  await manager.idle();
  assert.equal(cards.length, 1);
  assert.ok(adapter.sent.some(entry => /有个问题要先问你/.test(entry.text)));
});

test("one conversation runs one piece of work: mid-task words steer, 停 stops, neither opens a card", async () => {
  const adapter = cardAdapter();
  const steers: string[] = [];
  const stops: (string | undefined)[] = [];
  const opened: string[] = [];
  let release: () => void = () => {};
  const manager = new ChannelManager({
    mayDrive: () => true,
    // The first ask blocks until released, so the conversation is genuinely mid-task
    // when the follow-ups arrive. Later asks answer at once.
    ask: (() => {
      let first = true;
      return async () => {
        if (first) {
          first = false;
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return "做完了";
      };
    })(),
    steer: (_agent, text) => steers.push(text),
    stop: agentName => {
      stops.push(agentName);
      return true;
    },
    board: {
      open: input => {
        opened.push(input.title);
        return `t${opened.length}`;
      },
      started: () => {},
      closed: () => "done" as const,
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const room = { identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris" };
  await adapter.inject({ ...room, messageId: "m1", text: "把三百份报表汇总" });
  await new Promise(resolve => setTimeout(resolve, 20)); // let the task start and block

  // Steering: no second task, no second card, the words reach the turn.
  const steerReply = await adapter.inject({ ...room, messageId: "m2", text: "毛利改成百分比" });
  assert.equal(opened.length, 1, "steering does not open a second task");
  assert.deepEqual(steers, ["毛利改成百分比"]);
  assert.match(String(steerReply ?? ""), /带到了/);

  // The stop verb: the stop dep fires, still no new task.
  const stopReply = await adapter.inject({ ...room, messageId: "m3", text: "停" });
  assert.equal(stops.length, 1);
  assert.match(String(stopReply ?? ""), /叫停/);
  assert.equal(opened.length, 1);

  // Work finished: the conversation is free again, and the next message is new work.
  release();
  await manager.idle();
  await adapter.inject({ ...room, messageId: "m4", text: "再出一版周报" });
  await manager.idle();
  assert.equal(opened.length, 2, "a finished conversation takes new work");

  // 停 with nothing running is answered honestly, and stop is not fired.
  const idleStop = await adapter.inject({ ...room, messageId: "m5", text: "停" });
  assert.match(String(idleStop ?? ""), /没有正在做的事/);
  assert.equal(stops.length, 1);
});

test("a message addressed to a different agent is parallel work, not steering", async () => {
  const adapter = cardAdapter();
  const steers: string[] = [];
  const opened: string[] = [];
  let release: () => void = () => {};
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (agentName) => {
      if (agentName === "Ada") {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return "好";
    },
    steer: (_agent, text) => steers.push(text),
    board: {
      open: input => {
        opened.push(`${input.agentName ?? "-"}:${input.title}`);
        return `t${opened.length}`;
      },
      started: () => {},
      closed: () => "done" as const,
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const room = { identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris" };
  await adapter.inject({ ...room, messageId: "m1", text: "@Ada 汇总报表" });
  await new Promise(resolve => setTimeout(resolve, 20));

  await adapter.inject({ ...room, messageId: "m2", text: "@Bob 帮我查个数" });
  await new Promise(resolve => setTimeout(resolve, 20));
  // Two agents working in parallel is the team working, not a routing accident.
  assert.equal(opened.length, 2);
  assert.deepEqual(steers, []);
  release();
  await manager.idle();
});

test("可以 closes the task waiting on this person; with nothing waiting it is just chat", async () => {
  const adapter = cardAdapter();
  const accepts: { taskId: string; identity: string }[] = [];
  const asked: string[] = [];
  let reviewing = true;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (_a, text) => {
      asked.push(text);
      return "交付在这里";
    },
    board: {
      open: () => "t63",
      started: () => {},
      closed: () => "review" as const,
      accept: (taskId, identity) => {
        accepts.push({ taskId, identity });
        return reviewing ? ("done" as const) : ("not_review" as const);
      },
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const room = { identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris" };
  await adapter.inject({ ...room, messageId: "m1", text: "汇总报表" });
  await manager.idle();

  // The work went to review; the person's word is the verdict.
  const verdict = await adapter.inject({ ...room, messageId: "m2", text: "可以" });
  assert.deepEqual(accepts, [{ taskId: "t63", identity: "feishu:ou_1" }]);
  assert.match(String(verdict ?? ""), /t63 算完成了/);

  // Consumed: the next 可以 has nothing to accept and reaches the agent as chat.
  reviewing = false;
  await adapter.inject({ ...room, messageId: "m3", text: "好的" });
  await manager.idle();
  assert.equal(accepts.length, 1, "no task waiting — the word was chat, not a verdict");
  assert.ok(asked.some(text => text === "好的"), "and the agent hears it");

  // A pushback that merely contains an acceptance word is not an acceptance.
  await adapter.inject({ ...room, messageId: "m4", text: "可以再快点吗" });
  await manager.idle();
  assert.equal(accepts.length, 1);
});

test("answering the agent's question continues the work — no new task, no new card", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const opened: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    ackAfterMs: 1,
    ask: async (_a, text, _i, _c, onProgress) => {
      asked.push(text);
      onProgress?.("bash: ls");
      await new Promise(resolve => setTimeout(resolve, 15));
      return "看到了";
    },
    board: {
      open: input => {
        opened.push(input.title);
        return `t${opened.length}`;
      },
      started: () => {},
      closed: () => "done" as const,
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);
  manager.remember("a1", adapter.name, "feishu:ou_1");

  // The agent asks; the person's next message is the answer.
  manager.askQuestion({ agentId: "a1", agentName: "Ada", question: "附件到了吗?" });
  const room = { identity: "feishu:ou_1", chatKey: "feishu:oc_room", senderLabel: "chris" };
  await adapter.inject({ ...room, messageId: "m1", text: "附件刚上传完" });
  await manager.idle();

  assert.deepEqual(asked, ["附件刚上传完"], "the answer reaches the agent");
  assert.deepEqual(opened, [], "an answer is a continuation, not new work — observed as noise card t56");
  assert.equal(adapter.cards.length, 0, "and no card is posted for it");

  // One-shot: the message after the answer is ordinary work again.
  await adapter.inject({ ...room, messageId: "m2", text: "再出一版周报" });
  await manager.idle();
  assert.deepEqual(opened, ["再出一版周报"]);
});

test("the door's defaultAgent answers unaddressed messages; @Name still overrides", async () => {
  // docs/22 §2: routing follows the door. A message naming nobody goes to the
  // record's defaultAgent; an explicit @ reaches anyone in the box.
  const adapter = testAdapter();
  const asked: (string | undefined)[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    defaultAgentFor: adapterName => (adapterName === "telegram" ? "Bob" : undefined),
    ask: async (agentName, text) => {
      asked.push(agentName);
      return `did: ${text}`;
    },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  await adapter.inject({ identity: "telegram:7", senderLabel: "chris", text: "review the plan" });
  await sleep(20);
  assert.deepEqual(asked, ["Bob"], "nobody named, the door's default answers");

  await adapter.inject({ identity: "telegram:7", senderLabel: "chris", text: "@Ada check tests" });
  await sleep(20);
  assert.deepEqual(asked, ["Bob", "Ada"], "an explicit address wins over the default");
});

test("a door added while running opens live; a name already live is refused", async () => {
  const first = testAdapter();
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async (agentName) => "did it, " + (agentName || "default"),
    log: () => {},
  });
  manager.register(first, true, "test");
  await started(manager);

  // Same name: two writers on one namespace, refused.
  assert.equal(manager.registerAndStart(testAdapter(), "starting"), false);

  // A genuinely new door starts and handles messages like a boot-time one.
  const second = Object.assign(testAdapter(), { name: "feishu-work" });
  assert.equal(manager.registerAndStart(second, "starting"), true);
  await new Promise(resolve => setImmediate(resolve));
  await second.inject({ identity: "feishu-work:ou_1", senderLabel: "chris", text: "hello" });
  await sleep(20);
  assert.equal(second.sent.length, 1, "the live-started door answers");
  assert.ok(manager.list().some(s => s.name === "feishu-work" && s.running));
});

test("「团队」answers on the wire with the door's roster; work words do not trigger it", async () => {
  const adapter = testAdapter();
  const asked: string[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
    roster: adapterName => "roster for " + adapterName,
    ask: async (_agent, text) => { asked.push(text); return "did"; },
    log: () => {},
  });
  manager.register(adapter, true, "test");
  await started(manager);

  const reply = await adapter.inject({ identity: "telegram:7", senderLabel: "chris", text: "团队" });
  assert.equal(reply, "roster for telegram");
  assert.deepEqual(asked, [], "a roster look runs no turn");

  await adapter.inject({ identity: "telegram:7", senderLabel: "chris", text: "让团队看看这个" });
  await sleep(20);
  assert.deepEqual(asked, ["让团队看看这个"], "work mentioning the team is still work");
});
