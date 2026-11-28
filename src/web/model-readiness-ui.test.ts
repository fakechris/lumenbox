import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_CHAT_JS } from "./next-chat-ui.ts";
import { NEXT_COMPOSER_JS } from "./next-composer-ui.ts";

test("unconfigured send keeps the draft and shows the Model settings entry point", async () => {
  const nodes = new Map<string, any>();
  const node = () => ({ children: [] as any[], hidden: true, value: "", style: {}, scrollHeight: 70,
    setAttribute() {}, prepend(child: unknown) { this.children.unshift(child); },
    replaceChildren() { this.children = []; }, appendChild(child: unknown) { this.children.push(child); },
    addEventListener(_type: string, action: () => void) { this.click = action; }, click: () => {} });
  let configured = false, admin = true, posts = 0, opened = "";
  const checked: string[] = [];
  const context = vm.createContext({ window: {}, Promise, encodeURIComponent, navigator: { onLine: true },
    next: { view: "chat", agents: { rex: { id: "rex", name: "Rex" } } },
    $: (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    el: (_tag: string, _cls: string, text: string) => ({ ...node(), text }), t: (key: string) => key,
    getJson: async (path: string) => { checked.push(path); return { configured: configured && !path.endsWith("=rex") }; },
    postJson: async () => { posts++; },
    need: {}, sendReply: () => false, render: () => {},
    canOperateInstallation: () => admin, settings: { me: null },
    openSettingsPane: (pane: string) => { opened = pane; },
  });
  vm.runInContext(NEXT_CHAT_JS + NEXT_COMPOSER_JS + '; chat.agentId = "ada"; syncChatComposer(chatTarget()); $("composer-text").value = "Hello Ada"; loadThread = function () {};', context);
  await vm.runInContext("sendMessage()", context);
  assert.equal(posts, 0); assert.equal(nodes.get("composer-text").value, "Hello Ada");
  const notice = nodes.get("composer").children[0];
  assert.equal(notice.hidden, false); assert.equal(notice.children[0].text, "ui.first.model.none");
  notice.children[1].click(); assert.equal(opened, "model");
  admin = false;
  await vm.runInContext("refreshModelReadiness()", context);
  assert.deepEqual(notice.children.map((child: { text: string }) => child.text), ["ui.first.model.member"]);
  configured = true;
  nodes.get("composer-text").value = "@Rex Hello Rex";
  await vm.runInContext("sendMessage()", context);
  assert.equal(checked.at(-1), "/api/model-readiness?agent=rex");
  assert.equal(posts, 0); assert.equal(nodes.get("composer-text").value, "@Rex Hello Rex");
  assert.deepEqual(notice.children.map((child: { text: string }) => child.text), ["ui.first.model.member"]);
  admin = true; opened = "";
  await vm.runInContext("sendMessage()", context);
  assert.equal(posts, 0); assert.equal(nodes.get("composer-text").value, "@Rex Hello Rex");
  assert.deepEqual(notice.children.map((child: { text: string }) => child.text), ["ui.first.model.none", "ui.first.model.choose"]);
  notice.children[1].click(); assert.equal(opened, "model");
  // While Getting started shows its model step, the sentence is there only (INV-2311): the footer is empty.
  vm.runInContext("settings.listShowsModel = true; renderModelNotice()", context);
  assert.equal(notice.hidden, true);
  vm.runInContext("settings.listShowsModel = false; renderModelNotice()", context);
  assert.equal(notice.hidden, false);
  nodes.get("composer-text").value = "Hello Ada";
  await vm.runInContext("sendMessage()", context);
  assert.equal(posts, 1); assert.equal(nodes.get("composer-text").value, ""); assert.equal(notice.hidden, true);
  nodes.get("composer-text").value = "";
  await vm.runInContext("sendMessage()", context); assert.equal(posts, 1);
  context.getJson = async () => { throw new Error("offline"); };
  assert.equal(await vm.runInContext("refreshModelReadiness()", context), true, "a failed check is not a missing credential");
});
