import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { NEXT_SCREEN_JS } from "./next-screen-ui.ts";
import { NEXT_SET_BOXES_JS } from "./next-set-boxes-ui.ts";
import { NEXT_SET_DOORS_JS } from "./next-set-doors-ui.ts";
import { tr } from "../i18n/messages.ts";
import { OAUTH_PROVIDERS } from "../host/oauth.ts";

class Node {
  children: Node[] = [];
  handlers = new Map<string, () => void>();
  attributes = new Map<string, string>();
  value = "";
  hidden = false;
  disabled = false;
  constructor(readonly tag: string, readonly cls = "", public textContent = "") {}
  appendChild(child: Node) { this.children.push(child); }
  replaceChildren(...children: Node[]) { this.children = children; }
  addEventListener(name: string, run: () => void) { this.handlers.set(name, run); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  querySelector(selector: string): Node | undefined {
    return this.children.find(child => child.tag === selector || "." + child.cls === selector) ??
      this.children.map(child => child.querySelector(selector)).find(Boolean);
  }
  replaceWith() {}
}

const el = (tag: string, cls?: string, text?: string) => new Node(tag, cls, text);
const labelled = (text: string, control: Node) => {
  const label = el("label", "", text);
  label.appendChild(control);
  return label;
};
const t = (key: string, args?: Record<string, string>) => tr(key, "en", args);

test("host execution availability uses wrapping guidance instead of a truncated summary", () => {
  const reason = "Host execution is turned off. An operator enables it in Settings.";
  const document = { createTextNode: (text: string) => el("#text", "", text) };
  const context = vm.createContext({ el, t, labelled, document, settings: { me: { role: "admin" } }, reason });
  vm.runInContext(NEXT_SET_BOXES_JS, context);
  const form = vm.runInContext("boxSet.config = { hostExec: { unavailableReason: reason } }; hostBlock()", context) as Node;
  assert.equal(form.querySelector(".guidance")?.textContent, reason);
  assert.equal(form.querySelector(".why"), undefined);
});

test("reset explains the real data loss and labels confirmation with the configured name", () => {
  const context = vm.createContext({ el, t, labelled });
  vm.runInContext(NEXT_SET_BOXES_JS, context);
  const form = vm.runInContext("boxSet.limits = { container: 'custom-computer' }; limitsAndResetBlock()", context) as Node;
  const reset = form.querySelector("details")!;
  assert.match(reset.querySelector(".guidance")!.textContent, /deletes .*work folder.*Files saved outside this computer are kept/);
  const label = reset.querySelector("label")!;
  assert.equal(label.textContent, "Type custom-computer to confirm");
  assert.equal(label.children[0]?.tag, "input");
});

test("GitHub shows the installation callback and provider switching replaces the instructions", async () => {
  let copied = "";
  const uri = "https://lumenbox-example.test:8443/oauth/callback", select = el("select");
  select.value = "github";
  const context = vm.createContext({
    el, t, labelled, selectOf: () => select, toast() {},
    navigator: { clipboard: { async writeText(value: string) { copied = value; } } },
    failed: (error: Error) => { throw error; },
    data: { providers: OAUTH_PROVIDERS, redirectUri: uri },
  });
  vm.runInContext(NEXT_SET_DOORS_JS, context);
  const form = vm.runInContext("doors.connectors = data; connectorsBlock()", context) as Node;
  const setup = form.querySelector("p")!, callback = form.querySelector(".connector-callback")!;
  assert.match(setup.textContent, /OAuth Apps.*expiring user tokens/);
  assert.equal(callback.hidden, false);
  assert.equal(callback.querySelector("code")!.textContent, uri);
  callback.querySelector("button")!.handlers.get("click")!();
  await Promise.resolve();
  assert.equal(copied, uri);
  select.value = "feishu";
  select.handlers.get("change")!();
  assert.match(setup.textContent, /App ID and App Secret/);
  assert.equal(callback.hidden, true);
});

test("an offline local computer has in-panel recovery actions instead of desktop controls", () => {
  const body = el("div"), pane = el("aside"), toggle = el("button");
  const nodes = { "screen-body": body, screen: pane, "screen-toggle": toggle };
  const box = { id: "own", name: "My computer", connected: false };
  const agent = { id: "ada", boxId: "own", desktopUrl: "/desktop/1/vnc.html?autoconnect=1" };
  let starts = 0, view = "";
  const context = vm.createContext({
    el, t, $: (id: keyof typeof nodes) => nodes[id], document: { querySelectorAll: () => [] },
    chat: { agentId: "ada" }, next: { view: "chat", agents: { ada: agent } }, boxes: { own: "own" },
    boxById: () => box, canOperateInstallation: () => true,
    startBox: () => { starts++; }, navigateView: (key: string) => { view = key; },
  });
  vm.runInContext(NEXT_SCREEN_JS, context);
  vm.runInContext("screen2.open = true; renderScreen()", context);
  assert.equal(body.querySelector("h2")!.textContent, "Computer not connected");
  assert.match(body.querySelector("p")!.textContent, /My computer/);
  assert.equal(body.querySelector("iframe"), undefined);
  assert.equal(body.querySelector(".desk"), undefined);
  const [start, computers] = body.querySelector(".acts")!.children;
  start!.handlers.get("click")!();
  computers!.handlers.get("click")!();
  assert.equal(starts, 1);
  assert.equal(view, "boxes");
});
