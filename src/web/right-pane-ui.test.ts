import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ACTIVITY_FEED_JS } from "./right-pane-ui.ts";

test("activity stays bounded and a live failure remains visible while collapsed or reading older entries", () => {
  class Element {
    children: Element[] = [];
    open = false; hidden = true; scrollTop = 0; textContent = ""; className = ""; innerHTML = "";
    handlers = new Map<string, () => void>();
    classList = { toggle: () => {} };
    get scrollHeight() { return this.children.length * 20; }
    get firstElementChild() { return { remove: () => this.children.shift() }; }
    appendChild(child: Element) { this.children.push(child); }
    addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler.bind(this)); }
  }
  const ids = ["feed", "activity-panel", "activity-count", "activity-unread", "activity-retention"];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const scope = {
    $: (id: string) => nodes[id]!, document: { createElement: () => new Element() },
    nearBottom: (el: Element) => el.scrollHeight - el.scrollTop <= 100,
  };
  const feed = runInNewContext(`${ACTIVITY_FEED_JS}; feed`, scope) as (html: string, cls?: string, at?: string) => void;
  for (let n = 0; n < 230; n++) feed("Retained entry", "err", "2026-11-01T00:00:00Z");
  assert.equal(nodes.feed!.children.length, 200);
  assert.equal(nodes["activity-retention"]!.hidden, false);
  assert.equal(nodes["activity-unread"]!.textContent, "", "replayed errors are not new failures");
  feed("Sending failed", "err");
  assert.match(nodes["activity-unread"]!.textContent, /1 .*newErrors/);
  nodes["activity-panel"]!.open = true;
  nodes["activity-panel"]!.handlers.get("toggle")!();
  assert.equal(nodes["activity-unread"]!.textContent, "");
  nodes.feed!.scrollTop = 200;
  feed("Approval failed", "err");
  assert.equal(nodes.feed!.scrollTop, 200, "an error must not drag the person away from older history");
  assert.match(nodes["activity-unread"]!.textContent, /1 .*newErrors/);
  nodes.feed!.scrollTop = nodes.feed!.scrollHeight;
  nodes.feed!.handlers.get("scroll")!();
  assert.equal(nodes["activity-unread"]!.textContent, "", "reading the latest entries clears the indicator");
});
