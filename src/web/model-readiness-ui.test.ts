import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_CHAT_JS } from "./next-chat-ui.ts";
import { NEXT_COMPOSER_JS } from "./next-composer-ui.ts";

test("unconfigured send keeps the draft and shows the Model settings entry point", async () => {
  const nodes = new Map<string, any>();
  const node = () => ({ children: [] as any[], hidden: true, value: "Hello Ada", style: {},
    replaceChildren() { this.children = []; }, appendChild(child: unknown) { this.children.push(child); },
    addEventListener(_type: string, action: () => void) { this.click = action; }, click: () => {} });
  let configured = false, posts = 0, opened = "";
  const context = vm.createContext({ window: {}, Promise, encodeURIComponent,
    $: (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    el: (_tag: string, _cls: string, text: string) => ({ ...node(), text }), t: (key: string) => key,
    getJson: async () => ({ configured }), postJson: async () => { posts++; },
    addressed: () => null, need: {}, sendReply: () => false, render: () => {},
    openSettingsPane: (pane: string) => { opened = pane; },
  });
  vm.runInContext(NEXT_CHAT_JS + NEXT_COMPOSER_JS + '; chat.agentId = "ada";', context);
  await vm.runInContext("sendMessage()", context);
  assert.equal(posts, 0); assert.equal(nodes.get("composer-text").value, "Hello Ada");
  const notice = nodes.get("composer-model");
  assert.equal(notice.hidden, false); assert.equal(notice.children[0].text, "ui.next.composer.modelMissing");
  notice.children[1].click(); assert.equal(opened, "model");
  configured = true;
  await vm.runInContext("sendMessage()", context);
  assert.equal(posts, 1); assert.equal(nodes.get("composer-text").value, ""); assert.equal(notice.hidden, true);
  nodes.get("composer-text").value = "";
  await vm.runInContext("sendMessage()", context); assert.equal(posts, 1);
  context.getJson = async () => { throw new Error("offline"); };
  assert.equal(await vm.runInContext("refreshModelReadiness()", context), true, "a failed check is not a missing credential");
});
