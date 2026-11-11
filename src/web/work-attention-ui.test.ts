import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { WORK_ATTENTION_JS } from "./work-attention-ui.ts";
import { localizeScript } from "./page-locale.ts";

class Element {
  hidden = true; open = false; textContent = ""; children: Element[] = [];
  handlers = new Map<string, () => void>();
  appendChild(child: Element) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler); }
}
test("a hundred communications occupy one collapsed summary, never move the conversation, and disclose bounded plain text on demand", async () => {
  const nodes = new Map<string, Element>(); const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const scope = { $: node, document: { createElement: () => new Element() }, queueMicrotask };
  runInNewContext(localizeScript(WORK_ATTENTION_JS, "zh"), scope);
  runInNewContext('for(var i=0;i<100;i++)recordCommunication({label:"Peer",text:"<script>unsafe</script> message "+i});showCurrentWork({status:"waiting",held:100});', scope);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(node("communications").open, false);
  assert.equal(node("communications-list").children.length, 0, "collapsed means no message DOM, even during a flood");
  assert.match(node("communications-summary").textContent, /100/);
  assert.match(node("currentwork").textContent, /正在等待.*100/);
  node("communications").open = true; node("communications").handlers.get("toggle")!();
  assert.equal(node("communications-list").children.length, 50);
  assert.equal(node("communications-list").children[0]!.children[1]!.textContent, "<script>unsafe</script> message 50", "communications remain text, never injected HTML");
  assert.equal(nodes.has("chat"), false, "no chat or scroll mutation is needed to update communications");
  runInNewContext("resetCommunications()", scope);
  assert.equal(node("communications").hidden, true); assert.equal(node("communications-list").children.length, 0); assert.equal(node("currentwork").hidden, true);
});
