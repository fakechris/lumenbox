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

test("a finished task attaches the desktop, but only when it was long enough to acknowledge", async () => {
  const adapter = cardAdapter();
  let slow = false;
  const manager = new ChannelManager({
    mayDrive: () => true,
    ask: async () => {
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
  await adapter.inject({ identity: "feishu:ou_1", chatKey: "feishu:oc_r", senderLabel: "c", text: "long" });
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
      closed: (id, outcome, note) => events.push(`closed ${id} ${outcome}${note ? ` (${note})` : ""}`),
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

test("a dropped file is stored and acknowledged, and no turn runs", async () => {
  const adapter = cardAdapter();
  const asked: string[] = [];
  const received: { chatKey: string; names: string[] }[] = [];
  const manager = new ChannelManager({
    mayDrive: () => true,
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
  assert.match(adapter.chatSent[0]!.text, /Saved: inbox\/report\.pdf/);
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
  assert.match(adapter2.chatSent[0]!.text, /no box running/);
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
