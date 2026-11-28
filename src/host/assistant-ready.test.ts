/**
 * Telling a person their assistant is ready (INV-2220, docs/109 §3): through the real PersonReach,
 * ChannelManager, outbox and DingTalk adapter, with DingTalk's send endpoint faked.
 *
 * What would be wrong: a message to somebody other than the box's owner; a second message when the
 * box comes up again; a refusal lost, or retried for ever; a migrated person written to by an upgrade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, conversationIdFor } from "../agents/registry.ts";
import { DingTalkChannel } from "../channels/dingtalk.ts";
import { type ChannelAdapter, ChannelManager } from "../channels/manager.ts";
import { OutboxSender } from "../channels/outbox-sender.ts";
import { Activations } from "./activations.ts";
import { AssistantReady } from "./assistant-ready.ts";
import { directorySource } from "./directory.ts";
import { Outbox } from "./outbox.ts";
import { Principals } from "./principals.ts";
import { PushBudget } from "./push-budget.ts";
import { QuietQueue, quietChatDoor } from "./quiet-delivery.ts";
import { PersonReach } from "./reach-person.ts";

const OTO = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

/** Ana and Dan, activated on the DingTalk door with a box asked for each; Dan by the upgrade's migration. Eve is on the roster another way. */
function organisation(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "inv2220-told-"));
  const registry = new AgentRegistry(join(home, "agents")), principals = new Principals(join(home, "principals.json"));
  principals.save(["ana", "dan", "eve"].map(id => ({ id: `ding:${id}`, name: id[0]!.toUpperCase() + id.slice(1), role: "driver" as const, identities: [`ding:${id}`] })));
  const source = directorySource("ding", 1, "ding-app", "dingtalk"), activations = new Activations(join(home, "activations.jsonl"));
  for (const id of ["ana", "dan"]) activations.activatePerson(source, { subject: id, name: id }, "driver", "p-admin", true);
  activations.enrolled(source, [{ subject: "ana", principalId: "ding:ana" }]);
  activations.enrolled(source, [{ subject: "dan", principalId: "ding:dan" }], true);
  activations.boxesAsked(source, "p-admin", ["ding:ana"]);
  const agents = new Map(["ana", "dan", "eve"].map(id => {
    const box = registry.attachBox({ id: `${id}-box`, name: `${id}-box`, kind: "attached", members: [`ding:${id}`], displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() }).id;
    const agent = registry.create({ name: "助手", boxId: box });
    principals.setHomeAgent(`ding:${id}`, agent.id);
    return [id, agent.id];
  }));

  const vendor = { status: 200 }, sends: { userIds: string[]; text: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1.0/oauth2/accessToken")) return Response.json({ accessToken: "app-token", expireIn: 7200 });
    if (url === OTO) {
      const body = JSON.parse(String(init?.body)) as { userIds: string[]; msgParam: string };
      sends.push({ userIds: body.userIds, text: (JSON.parse(body.msgParam) as { content: string }).content });
      return vendor.status === 200 ? Response.json({ processQueryKey: "k" }) : Response.json({ code: "Forbidden.AccessDenied", message: "the app may not message this user" }, { status: vendor.status });
    }
    throw new Error(`unexpected vendor call ${url}`);
  }) as typeof fetch;
  const ding = new DingTalkChannel("ding-app", "secret", () => {}, undefined, undefined, undefined, "ding");
  const outbox = new Outbox(join(home, "outbox.jsonl")), sender = new OutboxSender(outbox, () => {}, async () => {});
  const queue = new QuietQueue({ windowMinutes: 3, capMinutes: 30, log: () => {}, lastPersonAt: () => undefined, answering: () => false, ready: () => true });
  let manager!: ChannelManager;
  const reach = new PersonReach({ registry, principals, budget: new PushBudget(join(home, "push-budget.jsonl")), log: () => {}, writesFirst: door => door === "ding",
    push: (chatKey, text, purpose) => manager.tryPushToChat(chatKey, text, purpose) });
  manager = new ChannelManager({
    log: () => {}, mayDrive: () => true, personFor: agentId => reach.addressFor(agentId), ask: async () => "ok",
    outbox: quietChatDoor(sender, queue, { conversationOf: conversationIdFor, push: (chatKey, text, purpose) => manager.tryPushToChat(chatKey, text, purpose) }),
  });
  manager.register({ name: ding.name, start: async () => {}, stop() {}, send: (identity, text) => ding.send(identity, text), sendToChat: (key, text, more) => ding.sendToChat!(key, text, more) } as ChannelAdapter, true, "test");
  manager.start();
  const ready = new AssistantReady({ activations, principals, registry, reach, publicUrl: () => "https://org.example", locale: () => "en", log: () => {}, sourceOf: door => door === "ding" ? source : undefined });
  t.after(() => { manager.stop(); globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  return { home, source, activations, ready, sends, vendor, agents };
}

test("a ready box makes one message, to its owner and nobody else, with the address and no credential; a migrated person and somebody not activated get none", async t => {
  const org = organisation(t);
  const told = await org.ready.tell("ding:ana");
  assert.equal(told?.reached.delivered, true);
  assert.deepEqual(org.sends, [{ userIds: ["ana"], text: "Hello, I'm 助手, your LumenBox assistant, and I'm ready. Sign in at https://org.example with this account to find me, or just talk to me here." }]);
  assert.equal(await org.ready.tell("ding:ana"), undefined, "the box coming up again says nothing twice");
  assert.equal(await org.ready.tell("ding:dan"), undefined, "made by the upgrade: their box comes at their first use, and nobody writes to them");
  assert.equal(await org.ready.tell("ding:eve"), undefined, "on the roster another way");
  assert.equal(org.sends.length, 1);
  const lines = readFileSync(join(org.home, "activations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.filter(line => line.type === "told").map(({ by, subject, principalId, delivered }) => ({ by, subject, principalId, delivered })),
    [{ by: "activation", subject: "ana", principalId: "ding:ana", delivered: true }], "the audit says who was told and by what");
});

test("a door that will not carry it lists the person as not told, with the reason; an Admin's retry sends once", async t => {
  const org = organisation(t);
  org.vendor.status = 403;
  assert.equal((await org.ready.tell("ding:ana"))?.reached.delivered, false);
  const waiting = org.ready.notTold(org.source);
  assert.deepEqual(waiting.map(activation => activation.subject), ["ana"]);
  assert.match(waiting[0]!.told?.why ?? "", /no permission to write to this person first/);
  assert.equal(org.sends.length, 1, "asked once, not retried by itself");

  org.vendor.status = 200;
  assert.deepEqual(await org.ready.tellAgain(org.source, undefined, "p-admin"), { told: 1, notTold: 0 });
  assert.equal(org.sends.length, 2);
  assert.deepEqual(org.ready.notTold(org.source), []);
  assert.deepEqual(await org.ready.tellAgain(org.source, undefined, "p-admin"), { told: 0, notTold: 0 }, "nobody is left to tell");
  assert.equal(org.sends.length, 2);

  // A send that throws (an outbox that cannot be written) is written down as not told, so it can be asked again.
  const broken = new AssistantReady({ activations: org.activations, principals: new Principals(join(org.home, "principals.json")), registry: new AgentRegistry(join(org.home, "agents")),
    reach: { tellOwner: async () => { throw new Error("outbox not writable"); } }, publicUrl: () => undefined, locale: () => "en", log: () => {}, sourceOf: () => org.source });
  assert.deepEqual((await broken.tellAgain(org.source, ["ana"], "p-admin")), { told: 0, notTold: 0 }, "Ana was told already: not asked again");
  org.activations.told(org.source, "activation", { subject: "ana", principalId: "ding:ana" }, { delivered: false, why: "pretend" });
  assert.deepEqual(await broken.tellAgain(org.source, ["ana"], "p-admin"), { told: 0, notTold: 1 });
  assert.equal(broken.notTold(org.source)[0]?.told?.why, "outbox not writable");
});
