/**
 * An agent reaches its person (INV-2221, docs/109 §4): the real ChannelManager and outbox, the real
 * DingTalk and Feishu adapters with the vendors' send endpoints faked, the real registry and roster.
 *
 * What would be wrong: a message from one member's agent arriving in another member's chat; an agent
 * nobody wrote to having nowhere to say anything; a vendor's refusal retried for ever, or lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, conversationIdFor } from "../agents/registry.ts";
import { DingTalkChannel, TOPIC } from "../channels/dingtalk.ts";
import { FeishuChannel } from "../channels/feishu.ts";
import { type ChannelAdapter, ChannelManager, type InboundMessage } from "../channels/manager.ts";
import { OutboxSender } from "../channels/outbox-sender.ts";
import { Outbox } from "./outbox.ts";
import { Principals } from "./principals.ts";
import { PushBudget } from "./push-budget.ts";
import { QuietQueue, quietChatDoor } from "./quiet-delivery.ts";
import { PersonReach } from "./reach-person.ts";

const OTO = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

/** Two members with a box and an agent each, one on a DingTalk door and one on a Feishu door, and a shared box. */
function organisation(t: { after(fn: () => void): void }, options: { dingStatus?: number; lastPersonAt?: (conversation: string) => number | undefined } = {}) {
  const home = mkdtempSync(join(tmpdir(), "inv2221-reach-"));
  const door = { incarnation: 1 }; // the DingTalk door's, as the server's roster asks it
  const registry = new AgentRegistry(join(home, "agents")), principals = new Principals(join(home, "principals.json"), { incarnationOf: identity => identity.startsWith("ding:") ? door.incarnation : 1 });
  principals.save([
    { id: "ana", name: "Ana", role: "driver", identities: ["web:ana", "ding:ana"] },
    { id: "bob", name: "Bob", role: "driver", identities: ["feishu:ou_bob"] },
    { id: "cat", name: "Cat", role: "driver", identities: ["telegram:7"] },
  ]);
  const box = (id: string, members: "everyone" | string[]) => registry.attachBox({ id, name: id, kind: "attached", members, displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() }).id;
  const anas = registry.create({ name: "Assistant", boxId: box("ana-box", ["ana"]) }), bobs = registry.create({ name: "Assistant", boxId: box("bob-box", ["bob"]) });
  const cats = registry.create({ name: "Assistant", boxId: box("cat-box", ["cat"]) }), desk = registry.create({ name: "Desk", boxId: box("shared", "everyone") });

  // DingTalk's endpoints, as `fetch` sees them: the app token, and the robot's one-to-one send.
  const dingSends: { robotCode: string; userIds: string[]; text: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1.0/oauth2/accessToken")) return Response.json({ accessToken: "app-token", expireIn: 7200 });
    if (url === OTO) {
      const body = JSON.parse(String(init?.body)) as { robotCode: string; userIds: string[]; msgParam: string };
      dingSends.push({ robotCode: body.robotCode, userIds: body.userIds, text: (JSON.parse(body.msgParam) as { content: string }).content });
      return options.dingStatus === undefined ? Response.json({ processQueryKey: "k" }) : Response.json({ code: "Forbidden.AccessDenied", message: "the app may not message this user" }, { status: options.dingStatus });
    }
    throw new Error(`unexpected vendor call ${url}`);
  }) as typeof fetch;
  const ding = new DingTalkChannel("ding-app", "secret", () => {}, undefined, undefined, undefined, "ding");
  // Feishu's message API, as the SDK client is called.
  const feishuSends: { receive_id_type: string; receive_id: string; text: string }[] = [];
  const feishu = new FeishuChannel("feishu-app", "secret", () => {});
  (feishu as unknown as { apiClient: unknown }).apiClient = { im: { message: { create: async (request: { params: { receive_id_type: string }; data: { receive_id: string; content: string } }) => {
    feishuSends.push({ receive_id_type: request.params.receive_id_type, receive_id: request.data.receive_id, text: (JSON.parse(request.data.content) as { text: string }).text });
    return { data: { message_id: `om_${feishuSends.length}` } };
  } } } };

  const outbox = new Outbox(join(home, "outbox.jsonl")), logged: string[] = [];
  const sender = new OutboxSender(outbox, line => logged.push(line), async () => {});
  const queue = new QuietQueue({ windowMinutes: 3, capMinutes: 30, log: () => {}, lastPersonAt: options.lastPersonAt ?? (() => undefined), answering: () => false, ready: () => true });
  const budget = new PushBudget(join(home, "push-budget.jsonl"));
  const turns: { agent: string | undefined; text: string }[] = [];
  let manager!: ChannelManager;
  const reach = new PersonReach({
    registry, principals, budget, log: line => logged.push(line),
    writesFirst: door => door === "ding" || door === "feishu",
    push: (chatKey, text, purpose) => manager.tryPushToChat(chatKey, text, purpose),
  });
  manager = new ChannelManager({
    log: () => {}, mayDrive: () => true,
    outbox: quietChatDoor(sender, queue, { conversationOf: conversationIdFor, push: (chatKey, text, purpose) => manager.tryPushToChat(chatKey, text, purpose) }),
    personFor: agentId => reach.addressFor(agentId),
    ask: async (agent, text) => { turns.push({ agent, text }); return "ok"; },
  });
  // The doors send as themselves; only their sockets are left unopened.
  const handlers = new Map<string, (message: InboundMessage) => Promise<string | undefined>>();
  for (const door of [ding, feishu] as ChannelAdapter[]) {
    manager.register({ name: door.name, start: async handler => { handlers.set(door.name, handler); }, stop() {}, send: (identity, text) => door.send(identity, text), sendToChat: (key, text, more) => door.sendToChat!(key, text, more) }, true, "test");
  }
  manager.start();
  t.after(() => { manager.stop(); globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  return { registry, principals, reach, manager, outbox, budget, queue, dingSends, feishuSends, turns, handlers, logged, anas, bobs, cats, desk, ding, door };
}

test("an agent nobody has written to tells its own person, through the door they hold, and nobody else", async t => {
  const org = organisation(t);
  const { reach, dingSends, feishuSends, anas, bobs, cats, desk } = org;

  assert.deepEqual(await reach.tellOwner(anas.id, "Your report is ready.", { about: "report" }), { delivered: true });
  assert.deepEqual(dingSends, [{ robotCode: "ding-app", userIds: ["ana"], text: "Your report is ready." }], "DingTalk: the robot's one-to-one send, to her user id");
  assert.deepEqual(feishuSends, [], "and nothing through the other door");

  assert.deepEqual(await reach.tellOwner(bobs.id, "Done.", { about: "report" }), { delivered: true });
  assert.deepEqual(feishuSends, [{ receive_id_type: "open_id", receive_id: "ou_bob", text: "Done." }], "Feishu: a message to his open_id");
  assert.equal(dingSends.length, 1, "Bob's agent reached Bob only");

  // Whose an agent is is read off the agent: there is no way to name another recipient.
  assert.equal(reach.ownerOf(bobs.id)?.id, "bob");
  assert.equal(reach.ownerOf(desk.id), undefined, "an agent in a shared box nobody chose is nobody's");
  assert.equal((await reach.tellOwner(desk.id, "hello", { about: "x" })).delivered, false);
  org.principals.setHomeAgent("ana", desk.id);
  assert.equal(reach.ownerOf(desk.id)?.id, "ana", "the one person who made it their home agent");
  org.principals.setHomeAgent("bob", desk.id);
  assert.equal(reach.ownerOf(desk.id), undefined, "two people's is nobody's");
  assert.equal(reach.ownerOf(anas.id)?.id, "ana", "and a box that is one person's stays theirs whatever anybody chose");
  // Once she has written to the bot, her agent writes into that direct conversation: its webhook gone stale, by her user id.
  await org.ding.receive(JSON.stringify({ type: "CALLBACK", headers: { topic: TOPIC, messageId: "tr-1" }, data: JSON.stringify({
    conversationId: "cid_ana", conversationType: "1", msgId: "m1", senderStaffId: "ana", senderNick: "Ana", msgtype: "text", text: { content: "hi" },
    sessionWebhook: "https://hook.test/x", sessionWebhookExpiredTime: Date.now() - 1 }) }), { respond: () => {} }, async message => { reach.noteDirect(message.identity, message.chatKey); return undefined; });
  assert.equal(reach.addressFor(anas.id)?.chatKey, "ding:cid_ana");
  assert.deepEqual(await reach.tellOwner(anas.id, "Again.", { about: "report" }), { delivered: true });
  assert.deepEqual(dingSends.at(-1), { robotCode: "ding-app", userIds: ["ana"], text: "Again." });
  // A door replaced since she was linked: her link is not hers any more, and nothing goes through it.
  org.door.incarnation = 2; org.principals.reload();
  assert.equal(reach.addressFor(anas.id), undefined, "a link from a replaced door is nobody's");
  assert.equal((await reach.tellOwner(anas.id, "Lost?", { about: "report" })).delivered, false);
  assert.equal(dingSends.length, 2);
  // A person with no door that can write first is not reached, and it is said why.
  const unreachable = await reach.tellOwner(cats.id, "hello", { about: "x" });
  assert.equal(unreachable.delivered, false);
  assert.match(unreachable.why ?? "", /no identity on a channel whose bot can write/);
  assert.deepEqual([dingSends.length, feishuSends.length], [2, 1]);
});

test("the agent's question goes to its person when no chat asked it, and their answer from the direct chat is taken", async t => {
  const org = organisation(t);
  const { manager, dingSends, anas, desk, turns, handlers } = org;
  assert.equal(manager.askQuestion({ agentId: desk.id, agentName: "Desk", question: "Anyone?" }), undefined, "nobody's agent still has nobody to ask");
  assert.equal(manager.askQuestion({ agentId: anas.id, agentName: "Assistant", questionId: "q1", question: "Which region?" }), "ding:ana");
  await new Promise(resolve => setImmediate(resolve));
  for (let waited = 0; dingSends.length === 0 && waited < 200; waited++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dingSends.map(sent => sent.userIds), [["ana"]]);
  assert.match(dingSends[0]!.text, /Which region\?[\s\S]*\/answer q1/);
  // Somebody else's answer is not hers; hers, from the direct chat the vendor opened, is.
  assert.match(String(await handlers.get("ding")!({ identity: "ding:bob", chatKey: "ding:cid_bob", privateChat: true, senderLabel: "Bob", text: "/answer q1 eu" })), /已失效/);
  await handlers.get("ding")!({ identity: "ding:ana", chatKey: "ding:cid_ana", privateChat: true, senderLabel: "Ana", text: "/answer q1 eu" });
  await manager.idle();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.agent, anas.id);
  assert.match(turns[0]!.text, /Which region\?[\s\S]*eu/);
});

test("it counts against the agent's daily allowance, waits while the person is writing, and a vendor's refusal is recorded once", async t => {
  const recent = new Map<string, number>();
  const org = organisation(t, { lastPersonAt: conversation => recent.get(conversation) });
  const { reach, budget, dingSends, anas } = org;
  budget.setPerDay(anas.id, 1);
  assert.equal((await reach.tellOwner(anas.id, "one", { about: "update" })).delivered, true);
  const second = await reach.tellOwner(anas.id, "two", { about: "update" });
  assert.match(second.why ?? "", /held for today's digest/);
  assert.deepEqual(dingSends.map(sent => sent.text), ["one"], "past the allowance it is held for the digest, not sent");
  assert.equal(budget.heldFor("ding:@ana").length, 1);
  await reach.tellOwner(anas.id, "needs you", { about: "decision", exempt: true });
  assert.deepEqual(dingSends.map(sent => sent.text), ["one", "needs you"], "what needs the person is never held");

  // She wrote a moment ago in her direct chat: an update waits for that conversation to be quiet, in that chat.
  budget.setPerDay(anas.id, null);
  reach.noteDirect("ding:ana", "ding:cid_ana");
  recent.set(conversationIdFor("ding:cid_ana"), Date.now());
  const waiting = await reach.tellOwner(anas.id, "three", { about: "update" });
  assert.equal(dingSends.length, 2, "nothing was sent while she is writing");
  assert.ok("queued" in waiting, "it is in the queue that waits for quiet");
});

test("a vendor that will not let the bot write first is a delivery problem, recorded once and not retried", async t => {
  const org = organisation(t, { dingStatus: 403 });
  const { reach, dingSends, outbox, anas } = org;
  const refused = await reach.tellOwner(anas.id, "hello", { about: "update" });
  assert.equal(refused.delivered, false);
  assert.match(refused.why ?? "", /no permission to write to this person first \(403 Forbidden\.AccessDenied/);
  assert.equal(dingSends.length, 1, "asked once: a verdict is not tried again");
  assert.deepEqual(outbox.entries().map(receipt => [receipt.chatKey, receipt.status]), [["ding:@ana", "dropped"]], "one receipt, closed with the reason");
  assert.equal(outbox.pending().length, 0, "and nothing is left to retry");
});
