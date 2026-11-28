/**
 * A chat's files are exchanged with the box of the agent the message is for (INV-2261).
 *
 * The real ChannelManager, ChatRoute (who a message reaches) and the server's file dependencies
 * (chat-files.ts), with one in-memory box per box entry. What would be wrong: a file a member sends
 * their own agent landing in another box, where the agent never sees it; a file their agent leaves
 * in its outbox never sent, or sent to somebody else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, conversationIdFor } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { type ChannelAdapter, ChannelManager, type InboundMessage } from "../channels/manager.ts";
import { ChatRoute } from "../host/chat-route.ts";
import { Principals, roleAtLeast } from "../host/principals.ts";
import { chatFilesRoot } from "../host/prompt.ts";
import { chatBoxFor, chatFiles } from "./chat-files.ts";

/** Enough of a box for a chat's files: mkdir, list, upload, download, and the move to sent/. */
function memoryBox(): { client: BoxClient; files: Map<string, string> } {
  const files = new Map<string, string>();
  const client = {
    exec: async (command: string) => {
      const move = /cd '([^']+)' && mv -- (.+) \.\.\/sent\/$/.exec(command);
      if (move !== null) {
        const dir = move[1]!, sent = dir.replace(/\/outbox$/, "/sent");
        for (const quoted of move[2]!.match(/'[^']*'/g) ?? []) {
          const name = quoted.slice(1, -1);
          files.set(`${sent}/${name}`, files.get(`${dir}/${name}`)!);
          files.delete(`${dir}/${name}`);
        }
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    },
    listDir: async (dir: string) => ({ path: dir, entries: [...files.keys()].filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")).map(path => ({ name: path.slice(dir.length + 1), type: "file", size: 1 })) }),
    uploadFile: async (path: string, base64: string) => { files.set(path, base64); return { path, size: base64.length }; },
    downloadFile: async (path: string) => { const base64 = files.get(path); if (base64 === undefined) throw new Error(`${path} does not exist`); return { path, size: base64.length, media_type: "text/plain", base64 }; },
  };
  return { client: client as unknown as BoxClient, files };
}

test("a file a member sends their own agent lands in that agent's box, and the file it leaves in its outbox comes back to them only", async t => {
  const home = mkdtempSync(join(tmpdir(), "inv2261-chat-files-"));
  const registry = new AgentRegistry(join(home, "agents")), principals = new Principals(join(home, "principals.json"));
  principals.save(["ana", "bob", "cat"].map(id => ({ id, name: id, role: "driver" as const, identities: [`ding:${id}`] })));
  const attach = (id: string, members: "everyone" | string[]) => registry.attachBox({ id, name: id, kind: "attached", members, displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() }).id;
  const anas = registry.create({ name: "Assistant", boxId: attach("ana-box", ["ana"]) }), bobs = registry.create({ name: "Assistant", boxId: attach("bob-box", ["bob"]) });
  const desk = registry.create({ name: "Desk", boxId: registry.defaultBox().id }); // the installation's own box: what was there before stays as it was
  principals.setHomeAgent("ana", anas.id); principals.setHomeAgent("bob", bobs.id);
  const boxes = new Map([[registry.defaultBox().id, memoryBox()], ["ana-box", memoryBox()], ["bob-box", memoryBox()]]);
  const files = chatFiles({
    boxOf: chatBoxFor({ registry, boxClient: id => boxes.get(id === undefined ? registry.defaultBox().id : registry.boxOf(id).id)?.client }),
    workRoot: () => "/home/box/work", log: () => {},
  });
  const route = new ChatRoute({ registry, principals, door: () => ({ type: "dingtalk", defaultAgent: "Desk" }), preparing: () => false, firstAgent: () => desk, log: () => {} });
  const turns: { agent: string | undefined; text: string }[] = [], sent: { chatKey: string; name: string; text: string }[] = [];
  let handler!: (message: InboundMessage) => Promise<string | undefined>;
  const adapter: ChannelAdapter = {
    name: "ding", start: async receive => { handler = receive; }, stop() {}, send: async () => undefined, sendToChat: async () => {},
    sendFile: async (chatKey, name, base64) => { sent.push({ chatKey, name, text: Buffer.from(base64, "base64").toString() }); },
  };
  const manager = new ChannelManager({
    log: () => {}, mayDrive: identity => roleAtLeast(principals.roleOf(identity), "driver"),
    route: (adapterName, message, name) => route.route(adapterName, message, name),
    ...files,
    ask: async (token, text, identity, chatKey) => {
      const agent = route.asked(token, identity);
      if (typeof agent === "string") return agent;
      turns.push({ agent: agent.id, text });
      // The turn writes its deliverable where its prompt says the chat's outbox is: on its own box.
      const outbox = `${chatFilesRoot(conversationIdFor(chatKey), registry.boxOf(agent.id))}/outbox`;
      boxes.get(registry.boxOf(agent.id).id)!.files.set(`${outbox}/summary.txt`, Buffer.from(`summary by ${agent.profile.name} for ${identity}`).toString("base64"));
      return "Done — the summary is attached.";
    },
  });
  manager.register(adapter, true, "test"); manager.start();
  t.after(() => { manager.stop(); rmSync(home, { recursive: true, force: true }); });
  await new Promise(resolve => setImmediate(resolve));
  const file = { name: "notes.txt", base64: Buffer.from("Ana's notes").toString("base64") };
  const inbox = (box: string, chatKey: string) => [...boxes.get(box)!.files.keys()].filter(path => path.startsWith(`${chatFilesRoot(conversationIdFor(chatKey), registry.boxById(box)!)}/inbox/`));

  // Bob's agent left something in his own chat's outbox earlier; it is his, and must not reach Ana.
  const bobOutbox = `${chatFilesRoot(conversationIdFor("ding:dm-bob"), registry.boxById("bob-box")!)}/outbox/payroll.txt`;
  boxes.get("bob-box")!.files.set(bobOutbox, Buffer.from("Bob's").toString("base64"));

  await handler({ identity: "ding:ana", chatKey: "ding:dm-ana", privateChat: true, senderLabel: "ana", text: "summarise this", messageId: "m1", files: [file] });
  await manager.idle();
  assert.deepEqual(turns.map(turn => turn.agent), [anas.id], "her own agent did the work");
  assert.match(turns[0]!.text, /inbox\/notes\.txt/, "and was told where the file is");
  assert.deepEqual(inbox("ana-box", "ding:dm-ana").map(path => path.split("/").pop()), ["notes.txt"], "the file is in her agent's box, where its turn reads its inbox");
  assert.deepEqual([inbox(registry.defaultBox().id, "ding:dm-ana"), inbox("bob-box", "ding:dm-ana")], [[], []], "and in no other box");
  assert.deepEqual(sent, [{ chatKey: "ding:dm-ana", name: "summary.txt", text: `summary by Assistant for ding:ana` }], "what her agent left in its outbox came back to her chat, and nothing else did");
  const anaChat = chatFilesRoot(conversationIdFor("ding:dm-ana"), registry.boxById("ana-box")!);
  assert.ok(boxes.get("ana-box")!.files.has(`${anaChat}/sent/summary.txt`) && !boxes.get("ana-box")!.files.has(`${anaChat}/outbox/summary.txt`), "and was moved to sent/ on her agent's box");
  assert.ok(boxes.get("bob-box")!.files.has(bobOutbox), "Bob's outbox is untouched");

  // A member with no box of their own reaches the agent in the installation's own box: the exchange is there, as before.
  await handler({ identity: "ding:cat", chatKey: "ding:dm-cat", privateChat: true, senderLabel: "cat", text: "summarise this", messageId: "m2", files: [file] });
  await manager.idle();
  assert.equal(turns.at(-1)!.agent, desk.id);
  assert.deepEqual(inbox(registry.defaultBox().id, "ding:dm-cat").map(path => path.split("/").pop()), ["notes.txt"]);
  assert.deepEqual(sent.at(-1), { chatKey: "ding:dm-cat", name: "summary.txt", text: "summary by Desk for ding:cat" });
  assert.equal(files.workDir(anas.id), "/home/box/work");
  assert.equal(files.workDir(undefined), "/home/box/work");
});
