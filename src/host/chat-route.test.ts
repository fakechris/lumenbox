/**
 * Who a chat message reaches (INV-2221, docs/109 §4): the real ChannelManager, the real Feishu and
 * DingTalk receivers turning wire events into messages, the real registry and roster, and the two
 * calls the server makes — `route` for the door, `asked` for the turn.
 *
 * What would be wrong: one person's message, or a name they typed, reaching an agent in a box they
 * may not enter; a message nobody is set to answer handed to whichever agent is first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { DingTalkChannel, TOPIC } from "../channels/dingtalk.ts";
import { FeishuChannel } from "../channels/feishu.ts";
import { type ChannelAdapter, ChannelManager, type InboundMessage } from "../channels/manager.ts";
import { tr } from "../i18n/messages.ts";
import { ChatRoute } from "./chat-route.ts";
import { Principals, roleAtLeast } from "./principals.ts";

type Handler = (message: InboundMessage) => Promise<string | undefined>;

/** An organisation: two members with a box and an agent each — the agents carry one name — and a shared box. */
function organisation(options: { defaultAgent?: string; installation?: unknown } = {}) {
  const home = mkdtempSync(join(tmpdir(), "inv2221-chat-route-"));
  const people = ["ana", "bob", "cat", "dan"].map(id => ({ id, name: id, role: "driver" as const, identities: [`feishu:ou_${id}`, `dingtalk:${id}`] }));
  const roster = [...people, { id: "vic", name: "vic", role: "viewer" as const, identities: ["feishu:ou_vic", "dingtalk:vic"] }];
  if (options.installation !== undefined) writeFileSync(join(home, "principals.json"), JSON.stringify({ installation: options.installation, principals: [] }));
  const registry = new AgentRegistry(join(home, "agents")), principals = new Principals(join(home, "principals.json"));
  if (options.installation === undefined) principals.save(roster);
  const box = (id: string, members: "everyone" | string[]) => registry.attachBox({ id, name: id, kind: "attached", members, displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() }).id;
  const make = (name: string, boxId: string) => registry.create({ name, boxId });
  const anas = make("Assistant", box("ana-box", ["ana"])), bobs = make("Assistant", box("bob-box", ["bob"])), desk = make("Desk", box("shared", "everyone"));
  if (options.installation === undefined) { principals.setHomeAgent("ana", anas.id); principals.setHomeAgent("bob", bobs.id); }
  const door: { defaultAgent?: string; type: string } = { type: "feishu", ...(options.defaultAgent !== undefined ? { defaultAgent: options.defaultAgent } : {}) };
  const logged: string[] = [];
  const route = new ChatRoute({ registry, principals, door: () => door, preparing: id => id === "dan", firstAgent: () => { throw new Error("no agent is made here"); }, log: line => logged.push(line) });

  // The server's wiring, with nothing of its own: the door asks `route`, the turn asks `asked`.
  const turns: { agent: string; text: string; by: string }[] = [];
  const manager = new ChannelManager({
    log: () => {},
    mayDrive: identity => roleAtLeast(principals.roleOf(identity), "driver"),
    known: identity => principals.resolve(identity).id !== identity,
    route: (adapterName, message, name) => route.route(adapterName, message, name),
    ask: async (token, text, identity) => {
      const agent = route.asked(token, identity);
      if (typeof agent === "string") return agent;
      turns.push({ agent: agent.id, text, by: identity });
      registry.appendTranscript(agent.id, { role: "user", text }, "chat");
      return `${agent.profile.name} in ${registry.boxOf(agent.id).name}`;
    },
  });
  // Both doors: the vendor's own event goes through the adapter's receiver, and what it makes of it goes to the manager.
  const handlers = new Map<string, Handler>();
  for (const name of ["feishu", "dingtalk"]) {
    const adapter: ChannelAdapter = { name, start: async handler => { handlers.set(name, handler); }, stop() {}, send: async () => undefined };
    manager.register(adapter, true, "test");
  }
  manager.start();
  const said: (string | undefined)[] = [];
  const into = (name: string): Handler => async message => { said.push(await handlers.get(name)!(message)); return undefined; };

  const feishuChannel = new FeishuChannel("app", "secret", () => {});
  const feishuInternals = feishuChannel as unknown as { ownOpenIdCache?: string; sendToChat: unknown; receiverFor: (handler: Handler) => (data: unknown) => unknown };
  feishuInternals.ownOpenIdCache = "ou_bot";
  feishuInternals.sendToChat = async () => undefined;
  const feishuReceive = feishuInternals.receiverFor(into("feishu"));
  const dingChannel = new DingTalkChannel("app", "secret", () => {});
  (dingChannel as unknown as { transmit: unknown }).transmit = async () => undefined;
  (dingChannel as unknown as { downloadResource: unknown }).downloadResource = async () => ({});

  let sent = 0;
  /** One message through a door, as the vendor sends it. Returns what the bot said on the wire, if anything, once any turn has ended. */
  const write = async (via: "feishu" | "dingtalk", who: string, text: string, where: "direct" | "group" = "direct"): Promise<string | undefined> => {
    sent += 1;
    const before = said.length;
    if (via === "feishu") {
      const group = where === "group";
      feishuReceive({
        sender: { sender_id: { open_id: `ou_${who}` } },
        message: {
          message_id: `om_${sent}`, chat_id: group ? "oc_room" : `oc_dm_${who}`, message_type: "text", chat_type: group ? "group" : "p2p",
          content: JSON.stringify({ text: group ? `@_user_1 ${text}` : text }),
          ...(group ? { mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1" }] } : {}),
        },
      });
    } else {
      const payload = { conversationId: where === "group" ? "cid_room" : `cid_dm_${who}`, conversationType: where === "group" ? "2" : "1", msgId: `msg_${sent}`, sessionWebhook: "https://hook.test/x",
        senderStaffId: who, senderNick: who, msgtype: "text", text: { content: text }, ...(where === "group" ? { isInAtList: true } : {}) };
      await dingChannel.receive(JSON.stringify({ type: "CALLBACK", headers: { topic: TOPIC, messageId: `tr-${sent}` }, data: JSON.stringify(payload) }), { respond: () => {} }, into(via));
    }
    for (let waited = 0; said.length === before && waited < 200; waited++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(said.length, before + 1, `${via} delivered "${text}" from ${who} to the manager`);
    await manager.idle();
    return said[before];
  };
  const last = () => turns.at(-1);
  const cleanup = () => { manager.stop(); rmSync(home, { recursive: true, force: true }); };
  return { registry, principals, route, door, turns, logged, write, last, box, make, anas, bobs, desk, handlers, cleanup };
}

test("a direct message reaches the writer's own agent through both doors; one name in two members' boxes never crosses; a room still reaches the door's default", async () => {
  const org = organisation({ defaultAgent: "Desk" });
  const { write, turns, anas, bobs, desk, registry } = org;
  try {
    // Feishu's `p2p` and DingTalk's `conversationType: "1"` are both a direct message, and it needs no @.
    await write("feishu", "ana", "what is on today");
    assert.deepEqual([org.last()?.agent, org.last()?.by], [anas.id, "feishu:ou_ana"]);
    await write("dingtalk", "bob", "what is on today");
    assert.deepEqual([org.last()?.agent, org.last()?.by], [bobs.id, "dingtalk:bob"]);
    await write("dingtalk", "ana", "and tomorrow");
    assert.equal(org.last()?.agent, anas.id, "the same person through the other door reaches the same agent");

    // Both agents are called Assistant: the name means the speaker's own.
    await write("feishu", "ana", "@Assistant draft it");
    assert.equal(org.last()?.agent, anas.id);
    await write("dingtalk", "bob", "@Assistant draft it");
    assert.equal(org.last()?.agent, bobs.id);
    assert.deepEqual([registry.readTranscript(anas.id, "chat").length, registry.readTranscript(bobs.id, "chat").length], [3, 2], "neither transcript grew with the other's messages");

    // Bob's agent, named by its id by Ana: the words for a name that does not exist, and no turn.
    const asked = turns.length;
    const theirs = await write("feishu", "ana", `@${bobs.id} show me`), nobody = await write("feishu", "ana", "@Nobody show me");
    assert.equal(theirs, tr("agent.unknown", "zh", { asked: bobs.id, roster: "Assistant、Desk" }));
    assert.equal(theirs!.replace(bobs.id, "Nobody"), nobody, "an agent in a box she may not enter is answered exactly as one that does not exist");
    assert.equal(turns.length, asked);

    // No box of her own (quota 0): the door's default, in the shared box. Her box still starting: told so, and nobody is asked.
    await write("feishu", "cat", "hello");
    assert.equal(org.last()?.agent, desk.id);
    assert.equal(await write("dingtalk", "dan", "hello"), tr("agent.preparing", "zh"));
    assert.equal(org.last()?.agent, desk.id, "nothing ran for a person whose agent is not there yet");

    // A group chat is as it was: the door's default answers a message that names nobody, whoever wrote it.
    await write("feishu", "ana", "who is on call", "group");
    assert.equal(org.last()?.agent, desk.id);
    await write("dingtalk", "bob", "who is on call", "group");
    assert.equal(org.last()?.agent, desk.id);

    // A viewer instructs nobody, direct or not.
    const before = turns.length;
    assert.equal(await write("feishu", "vic", "do this"), tr("access.viewer", "zh"));
    assert.equal(turns.length, before);
  } finally { org.cleanup(); }
});

test("with no default agent a room is told once and no agent is picked for it; a direct message with nobody to answer says what to do", async () => {
  const org = organisation();
  const { write, turns, make, principals, anas, bobs } = org;
  try {
    assert.equal(await write("feishu", "cat", "anyone there", "group"), tr("agent.noneForRooms", "zh"));
    assert.equal(await write("feishu", "ana", "anyone there", "group"), undefined, "said once in a room, then left alone");
    assert.equal(await write("dingtalk", "cat", "anyone there", "group"), tr("agent.noneForRooms", "zh"), "another room has not been told");
    assert.equal(turns.length, 0, "never the first agent of the installation");
    // A file dropped where nobody answers is not stored for an agent nobody chose either.
    assert.equal(await org.handlers.get("feishu")!({ identity: "feishu:ou_cat", chatKey: "feishu:oc_files", senderLabel: "cat", text: "", files: [{ name: "a.txt", base64: "YQ==" }] }), tr("agent.noneForRooms", "zh"));
    assert.equal(turns.length, 0);
    // A verb that needs no agent is still answered there.
    assert.match((await write("feishu", "cat", "/help", "group")) ?? "", /@/);

    // One agent she may reach: it is the only one she could mean.
    await write("feishu", "cat", "hello");
    assert.equal(org.last()?.agent, org.desk.id);
    // Two, and none of them hers: she is told, with their names, and nothing runs.
    make("Scribe", "shared");
    const asked = turns.length;
    assert.equal(await write("feishu", "cat", "hello"), tr("agent.noneHere", "zh") + tr("agent.reachHint", "zh", { roster: "Desk、Scribe" }));
    assert.equal(turns.length, asked);

    // A home agent that was deleted is not somebody else's agent, nor the first one: Ana is told the same.
    org.registry.remove(anas.id, { archive: false });
    assert.match((await write("dingtalk", "ana", "hello")) ?? "", /Desk、Scribe/);
    assert.equal(turns.length, asked);
    // A home agent in a box Bob was taken out of no longer answers him.
    org.registry.updateBox("bob-box", { members: ["ana"] });
    assert.equal(principals.byId("bob")?.homeAgentId, bobs.id);
    assert.match((await write("feishu", "bob", "hello")) ?? "", /Desk、Scribe/);
    assert.equal(turns.length, asked);
  } finally { org.cleanup(); }
});

test("@Name is looked for among the agents the speaker may reach: their own box first, and two shared boxes are told apart by box", async () => {
  const org = organisation({ defaultAgent: "Assistant" });
  const { write, box, make, anas } = org;
  try {
    // A third Assistant, in the shared box, which is what the door's default means by that name.
    const shared = make("Assistant", "shared");
    await write("feishu", "cat", "hello");
    assert.equal(org.last()?.agent, shared.id, "a default written as a name three agents carry is the one in a shared box");
    await write("feishu", "ana", "@assistant hello");
    assert.equal(org.last()?.agent, anas.id, "her own before the shared one");
    await write("feishu", "cat", "@Assistant hello");
    assert.equal(org.last()?.agent, shared.id, "the only one Cat may reach");

    const other = make("Assistant", box("second-shared", "everyone"));
    const asked = org.turns.length;
    const ambiguous = await write("feishu", "cat", "@Assistant hello");
    assert.equal(org.turns.length, asked);
    for (const piece of ["shared", "second-shared", shared.id, other.id]) assert.ok(ambiguous!.includes(piece), `the answer tells them apart: ${piece}`);
    for (const piece of ["ana-box", "bob-box", anas.id]) assert.ok(!ambiguous!.includes(piece), `and says nothing of a box she may not enter: ${piece}`);
    await write("feishu", "cat", `@${other.id} hello`);
    assert.equal(org.last()?.agent, other.id, "the id the answer gave reaches that one");
  } finally { org.cleanup(); }
});

test("a person chooses their home agent only among agents they may reach", async () => {
  const org = organisation({ defaultAgent: "Desk" });
  const { route, principals, anas, bobs, desk, write } = org;
  try {
    assert.equal(route.homeOf("ana")?.id, anas.id);
    assert.equal(route.chooseHome("ana", bobs.id), undefined, "not an agent in Bob's box");
    assert.equal(route.chooseHome("ana", "no-such-agent"), undefined);
    assert.equal(principals.byId("ana")?.homeAgentId, anas.id, "a refused choice changes nothing");
    assert.equal(route.chooseHome("ana", desk.id)?.id, desk.id);
    await write("dingtalk", "ana", "hello");
    assert.equal(org.last()?.agent, desk.id, "her direct messages reach the one she chose");
  } finally { org.cleanup(); }
});

test("a single-machine installation with no default agent is answered by its first agent, as before", async () => {
  const org = organisation({ installation: { mode: "single-machine", ownerId: "local:owner" } });
  try {
    org.principals.save([{ id: "local:owner", name: "Owner", role: "admin", identities: ["feishu:ou_owner"] }]);
    for (const id of ["ana-box", "bob-box"]) org.registry.updateBox(id, { members: "everyone" });
    await org.write("feishu", "owner", "hello");
    assert.equal(org.last()?.agent, org.registry.list()[0]!.id);
    await org.write("feishu", "owner", "hello", "group");
    assert.equal(org.last()?.agent, org.registry.list()[0]!.id);
  } finally { org.cleanup(); }
});
