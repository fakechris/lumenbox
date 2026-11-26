/**
 * The rebuilt page (INV-1825): that it is a page at all in both languages, that its script names no
 * element the markup lacks, and that the few decisions it makes for itself are the ones docs/99 §4 lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_PAGE } from "./page-locale.ts";
import { nextLogic } from "./next-logic-ui.ts";
import { DELIVERY_BRIEF, DELIVERY_SECTIONS, deliveryLabel } from "../host/delivery-report.ts";
import { ASK_SENTENCES, askLabel, askProse, splitAsk } from "../host/person-ask.ts";
import { NEXT_AUTO_JS } from "./next-auto-ui.ts";
import { NEXT_PANEL_JS } from "./next-panel-ui.ts";
import { NEXT_FILES_JS } from "./next-files-ui.ts";
import { NEXT_CHAT_JS } from "./next-chat-ui.ts";
import { NEXT_DOCK_JS } from "./next-dock-ui.ts";

/** The inline scripts of a page, in order. */
const pageScripts = (page: string): string[] => [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);

test("rejected model credentials stay Stuck and offer the right next step for the role (INV-2108)", () => {
  const task = { status: "doing", reading: { phase: "waiting", blocker: { kind: "model_auth_rejected", tools: [] } } };
  const calls: string[] = [];
  let admin = false;
  const modelAuthBlock = pageFunction("modelAuthBlock", {
    canOperateInstallation: () => admin, nextStateOf: nextLogic.nextStateOf, el: fakeEl, t: (key: string) => key,
    closePanel: () => calls.push("closed"), openSettingsPane: (pane: string) => calls.push(pane),
  }) as (task: unknown) => Fake | null;
  assert.equal(nextLogic.nextStateOf(task).key, "stuck");
  const member = modelAuthBlock(task)!;
  assert.deepEqual(member.kids.map(node => node.text), ["ui.wr.blocker.model_auth_rejected", "ui.next.panel.modelAuthMember"]);
  admin = true;
  const operator = modelAuthBlock(task)!;
  assert.equal(operator.kids[1]!.text, "ui.next.panel.modelAuthAdmin");
  const button = operator.kids[2]!.kids[0]!;
  assert.equal(button.text, "ui.next.composer.modelSettings");
  button.press!();
  assert.deepEqual(calls, ["closed", "model"]);
  assert.equal(modelAuthBlock({ ...task, reading: { phase: "waiting", blocker: { kind: "failed" } } }), null);
});

test("work process distinguishes delivered files from a task metadata update failure", () => {
  const node = (tag: string, cls = "", text = "") => ({
    tag, cls, text, kids: [] as unknown[],
    appendChild(child: unknown) { this.kids.push(child); },
  });
  const context = vm.createContext({ el: node, t: (key: string) => key, agentName: () => "Ada", MSG: { "ui.next.step.failed": "failed" } });
  vm.runInContext(NEXT_PANEL_JS, context);
  vm.runInContext(`panel.steps = [
    { name: "Tasks", detail: "update", metadataUpdate: true, outcome: "failed" },
    { name: "Tasks", detail: "submit", outcome: "succeeded" },
    { name: "tool", detail: { status: "unexpected" }, outcome: "failed" }
  ]`, context);
  const render = (task: string): string => vm.runInContext("JSON.stringify(processBlock(" + task + "))", context);
  const delivered = render("{ deliverables: [{ id: 'report' }] }");
  assert.match(delivered, /filesDelivered.*metadataFailed.*metadataDeliveryIntact.*Tasks submit/);
  assert.doesNotMatch(delivered, /Tasks update|\[object Object\]/);
  assert.match(delivered, /ui\.next\.step\.failed/, "unrelated failures still have a flag");
  assert.match(render("{}"), /metadataFailed.*metadataRetry/);
  assert.doesNotMatch(render("{}"), /filesDelivered|resultSubmitted|metadataDeliveryIntact/);
  assert.match(render("{ delivery: { submitted: true } }"), /resultSubmitted.*metadataDeliveryIntact/);
});

test("Files opens in the main view and downloads from the selected box", async () => {
  assert.match(NEXT_PAGE("en"), /data-nav="files">Files<\/button>/);
  const boxes = [{ id: "private", name: "Personal box" }, { id: "shared", name: "Shared box" }];
  const pending: { path: string; resolve: (listing: unknown) => void }[] = [];
  const clicks = new Map<string, () => void>();
  const node = (tag: string, cls = "", text = "") => ({
    tag, cls, text, kids: [] as unknown[], classList: { add() {} },
    appendChild(child: unknown) { this.kids.push(child); },
    addEventListener(event: string, run: () => void) { if (event === "click") clicks.set(text, run); },
    setAttribute() {},
  });
  let view = node("main");
  const context = vm.createContext({
    boxes: { list: boxes }, chat: { box: "private" }, next: { view: "files" }, boxById: (id: string) => boxes.find(box => box.id === id),
    el: node, t: (key: string) => key, bytes: (n: number) => String(n),
    getJson: (path: string) => new Promise(resolve => pending.push({ path, resolve })),
    render: () => { view = node("main"); vm.runInContext("renderFiles(view)", Object.assign(context, { view })); },
  });
  vm.runInContext(NEXT_FILES_JS, context);
  vm.runInContext("render()", context);
  assert.equal(pending[0]!.path, "/api/files?boxId=private");
  vm.runInContext("readWorkFiles('shared', ''); render()", context);
  assert.equal(pending[1]!.path, "/api/files?boxId=shared");
  pending[0]!.resolve({ root: "/work", path: "/work", entries: [{ name: "private.md", type: "file", size: 1 }] });
  pending[1]!.resolve({ root: "/work", path: "/work", entries: [
    { name: "one turn.md", type: "file", size: 47 },
    { name: "latest.md", type: "symlink", target_in_work: true, target_type: "file" },
    { name: "archive-link", type: "symlink", target_in_work: true, target_type: "directory" },
    { name: "outside.md", type: "symlink", target_in_work: false },
    { name: "broken.md", type: "symlink", target_in_work: false },
    { name: "unverified.md", type: "symlink" },
  ] });
  await Promise.resolve();
  assert.doesNotMatch(JSON.stringify(view), /private\.md/);
  assert.match(JSON.stringify(view), /one turn.md.*\/api\/file\?boxId=shared&path=%2Fwork%2Fone%20turn.md/);
  assert.match(JSON.stringify(view), /latest\.md.*\/api\/file\?boxId=shared&path=%2Fwork%2Flatest\.md/);
  assert.doesNotMatch(JSON.stringify(view), /(?:outside|broken|unverified)\.md/);
  assert.doesNotMatch(JSON.stringify(view), /\/api\/file\?boxId=shared&path=%2Fwork%2Farchive-link/);
  assert.ok(clicks.has("archive-link/"), "an in-root directory alias is a folder button, not a download");
  clicks.get("archive-link/")!();
  assert.equal(pending[2]!.path, "/api/files?boxId=shared&dir=%2Fwork%2Farchive-link");
});

test("automation refresh shows discovery, ignores an old response and renders the new paused routine", async () => {
  const pending: { resolve: (got: unknown) => void; reject: (error: Error) => void }[] = [];
  const settings = { routines: null as unknown };
  const errors: Error[] = [];
  const node = (tag: string, cls = "", text = "") => ({
    tag, cls, text, kids: [] as unknown[],
    appendChild(child: unknown) { this.kids.push(child); }, addEventListener() {},
  });
  let view = node("main");
  const context = vm.createContext({
    settings, boxes: { state: { connected: true } }, next: { view: "auto" }, el: node, t: (key: string) => key, initial: () => "N",
    getJson: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    failed: (error: Error) => errors.push(error),
    render: () => { view = node("main"); vm.runInContext("renderAuto(view)", Object.assign(context, { view })); },
  });
  vm.runInContext(NEXT_AUTO_JS, context);
  vm.runInContext("render()", context);
  assert.match(JSON.stringify(view), /ui.next.auto.reading/);
  vm.runInContext("reloadAuto()", context);
  pending[1]!.resolve({ schedules: [{ slug: "new-routine", name: "New routine", paused: true }] });
  await Promise.resolve();
  pending[0]!.resolve({ schedules: [] });
  await Promise.resolve();
  assert.match(JSON.stringify(view), /New routine/);
  assert.match(JSON.stringify(view), /ui.next.auto.paused/);
  vm.runInContext("reloadAuto()", context);
  pending[2]!.resolve({ schedules: [] });
  await Promise.resolve();
  assert.match(JSON.stringify(view), /ui.next.auto.empty/);
  vm.runInContext("reloadAuto()", context);
  pending[3]!.reject(new Error("offline"));
  await Promise.resolve();
  assert.equal(errors[0]?.message, "offline");
});

test("automation creation guides an offline user to Computers and preserves the draft until a retry succeeds", async () => {
  class Node {
    kids: Node[] = [];
    events = new Map<string, () => void>();
    style = {};
    value = "";
    hidden = false;
    constructor(readonly tag: string, readonly text = "") {}
    appendChild(child: Node) { this.kids.push(child); }
    addEventListener(event: string, run: () => void) { this.events.set(event, run); }
    setAttribute() {}
    find(text: string): Node | undefined {
      if (this.text === text) return this;
      for (const child of this.kids) { const found = child.find(text); if (found) return found; }
    }
    click() { this.events.get("click")!(); }
  }
  const settings = { routines: [], runnerAgents: ["Ada"] }, next = { view: "auto" };
  const boxes = { state: { connected: false } };
  const connectionError = Object.assign(new Error("No box is connected"), { data: { code: "no-box" } });
  const payloads: unknown[] = [];
  let view = new Node("main");
  const context = vm.createContext({
    settings, boxes, next, t: String,
    el: (tag: string, _cls: string, text: string) => new Node(tag, text),
    field: (text: string, value: string) => {
      const label = new Node("label", text), input = new Node("input");
      input.value = value; label.appendChild(input); return { label, input };
    },
    navigateView: (view: string) => { next.view = view; },
    getJson: async () => ({ schedules: [] }),
    postJson: async (path: string, body: unknown) => {
      assert.equal(path, "/api/automations");
      payloads.push(JSON.parse(JSON.stringify(body)));
      if (!boxes.state.connected) throw connectionError;
      return { slug: "morning-report" };
    },
    render: () => { view = new Node("main"); vm.runInContext("renderAuto(view)", Object.assign(context, { view })); },
  });
  vm.runInContext(NEXT_AUTO_JS, context);
  const render = () => vm.runInContext("render()", context);
  const control = (key: string) => view.find("ui.next.auto." + key)!.kids[0]!;
  render();
  assert.equal(view.find("ui.next.auto.new"), undefined);
  assert.ok(view.find("ui.auto.needsComputer"));
  view.find("ui.auto.openComputers")!.click();
  assert.equal(next.view, "boxes");

  boxes.state.connected = true; next.view = "auto"; render();
  view.find("ui.next.auto.new")!.click();
  control("name").value = "Morning report";
  control("what").value = "Summarize yesterday’s work.";
  control("who").value = "Ada";
  control("starts").value = "message";
  control("match").value = "morning report";
  view.kids[0]!.events.get("change")!();
  boxes.state.connected = false;
  view.find("ui.next.member.create")!.click();
  await Promise.resolve();
  assert.ok(view.find("ui.auto.computerLost"));
  assert.ok(view.find("ui.auto.computerRetry"));
  view.find("ui.auto.openComputers")!.click();
  assert.equal(next.view, "boxes");

  boxes.state.connected = true; next.view = "auto"; render();
  assert.equal(control("name").value, "Morning report");
  assert.equal(control("what").value, "Summarize yesterday’s work.");
  assert.equal(control("who").value, "Ada");
  assert.equal(control("starts").value, "message");
  assert.equal(control("match").value, "morning report");
  assert.equal(view.find("ui.next.auto.match")!.hidden, false);
  view.find("ui.next.member.create")!.click();
  await Promise.resolve();
  await Promise.resolve();
  const payload = { name: "Morning report", body: "Summarize yesterday’s work.", triggerType: "message", match: "morning report", agent: "Ada" };
  assert.deepEqual(payloads, [payload, payload]);
  assert.ok(view.find("ui.next.auto.new"));
  assert.equal(view.find("ui.auto.computerLost"), undefined);
});

const row = (phase: string, blocker?: string, status = "doing") => ({ status, reading: { phase, ...(blocker ? { blocker: { kind: blocker } } : {}) } });

test("the page fills in both languages, and its script parses", () => {
  for (const locale of ["zh", "en"] as const) {
    const page = NEXT_PAGE(locale);
    assert.doesNotMatch(page, /\{\{/, "no unfilled word");
    const scripts = pageScripts(page);
    assert.ok(scripts.length >= 2, "the theme script and the page script");
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script), "each page script is valid JavaScript");
  }
  assert.match(NEXT_PAGE("zh"), /全部工作/);
  assert.match(NEXT_PAGE("en"), /All work/);
});

test("every element the script looks up by id is in the markup", () => {
  const page = NEXT_PAGE("en");
  const ids = new Set([...page.matchAll(/\$\("([a-z-]+)"\)/g)].map(match => match[1]!));
  assert.ok(ids.size > 5);
  for (const id of ids) assert.match(page, new RegExp(`id="${id}"`), `#${id}`);
});

test("one word per row: whose move it is decides the word (docs/99 §4)", () => {
  const word = (phase: string, blocker?: string, status?: string) => nextLogic.nextStateOf(row(phase, blocker, status)).key;
  assert.equal(word("working"), "running");
  assert.equal(word("review"), "review");
  assert.equal(word("needs", "confirmation"), "answer");
  assert.equal(word("needs", "capability"), "stuck", "a missing tool is not a question for the person");
  assert.equal(word("waiting", "failed"), "stuck");
  assert.equal(word("waiting", "execution", "doing"), "running", "between two slices of its own it is still being worked on");
  assert.equal(word("waiting", "dependency"), "waiting");
  assert.equal(word("ended"), "done");
  assert.equal(word("dropped"), "stopped");
});

test("every word has a section, and the inbox sorts by what the person must do", () => {
  for (const key of ["running", "queued", "checking", "waiting", "answer", "stuck", "proposal", "review", "done", "stopped"]) {
    assert.ok(["running", "you", "review", "done"].includes(nextLogic.nextGroupOf(key)), key);
  }
  assert.equal(nextLogic.nextGroupOf("stuck"), "you");
  assert.equal(nextLogic.nextInboxGroupOf("approval"), "approve");
  assert.equal(nextLogic.nextInboxGroupOf("question"), "answer");
  assert.equal(nextLogic.nextInboxGroupOf("review"), "review");
  assert.equal(nextLogic.nextInboxGroupOf("undeliverable"), "stuck");
  assert.equal(nextLogic.nextInboxGroupOf("nudged"), "other");
});

test("progress is shown only where something was counted, and never from a stale or verifying source", () => {
  assert.equal(nextLogic.nextProgressOf(undefined), undefined);
  assert.equal(nextLogic.nextProgressOf({ sources: [{ processed: 3, stale: true, total: 70 }] }), undefined);
  assert.equal(nextLogic.nextProgressOf({ sources: [{ processed: 8, total: 70, source: "independent-verifier" }] }), undefined);
  assert.deepEqual(nextLogic.nextProgressOf({ sources: [{ processed: 41, total: 70, source: "agent-reported" }] }), { done: 41, total: 70 });
  assert.deepEqual(nextLogic.nextAgo(new Date(Date.now() - 5 * 60_000).toISOString(), Date.now()), { key: "minutes", n: 5 });
});

test("with no choice the page is the rebuilt one; the page somebody switched to is the one they come back to", async () => {
  const { pageChoice, APP_PAGE } = await import("./page-locale.ts");
  const ask = (path: string, cookie?: string) => pageChoice({ headers: cookie ? { cookie } : {} } as never, new URL(path, "http://127.0.0.1"));
  assert.equal(ask("/").page, NEXT_PAGE, "no choice: the rebuilt page");
  assert.equal(ask("/").remember, undefined);
  assert.equal(ask("/?ui=classic").page, APP_PAGE);
  assert.match(ask("/?ui=classic").remember!, /^lumen-ui=classic; /);
  assert.equal(ask("/", "agentbox_ui=x; lumen-ui=classic").page, APP_PAGE, "remembered across a plain reload");
  assert.equal(ask("/?ui=next", "lumen-ui=classic").page, NEXT_PAGE, "and switching back is one link");
  assert.match(ask("/?ui=next", "lumen-ui=classic").remember!, /^lumen-ui=next; /);
  assert.equal(ask("/?ui=sideways").page, NEXT_PAGE, "an unknown choice is no choice");
  assert.equal(ask("/?ui=classic", "lumen-ui=classic").remember, undefined, "nothing to remember twice");
  assert.deepEqual([ask("/?ui=classic&once=1&task=t1", "lumen-ui=next").page, ask("/?ui=classic&once=1&task=t1", "lumen-ui=next").remember], [APP_PAGE, undefined], "one look at the other page changes nothing");
  assert.equal(ask("/?import=abc").page, NEXT_PAGE, "a template link is the rebuilt page's to open");
});

/** A stand-in for a page element: what was put in it, what it was told, and what a press on it runs. */
interface Fake {
  cls: string; text: string; kids: Fake[]; childNodes: Fake[]; dataset: Record<string, string>; attrs: Record<string, string>; value: string; placeholder?: string; href?: string; press?: () => void; swapped?: Fake;
  appendChild(kid: Fake): void; addEventListener(name: string, run: () => void): void; setAttribute(name: string, value: string): void; replaceWith(other: Fake): void;
}
const fakeEl = (_tag: string, cls = "", text = ""): Fake => {
  const kids: Fake[] = [];
  const node: Fake = {
    cls, text, kids, childNodes: kids, dataset: {}, attrs: {}, value: "",
    appendChild(kid) { kids.push(kid); }, addEventListener(_name, run) { node.press = run; }, setAttribute(name, value) { node.attrs[name] = value; }, replaceWith(other) { node.swapped = other; },
  };
  return node;
};

function chatComposerTest() {
  const input = { value: "", style: { height: "" }, scrollHeight: 70 };
  const status = { hidden: true, textContent: "" }, send = { disabled: false }, navigator = { onLine: true };
  const nodes = { "composer-text": input, "composer-menu": { hidden: false }, "composer-send-status": status, "composer-send": send };
  const posts: Array<{ path: string; body: unknown; accept: () => void; reject: (e: Error) => void }> = [];
  const postJson = (path: string, body: unknown) => new Promise<void>((accept, reject) => posts.push({ path, body, accept, reject }));
  const rows: Array<{ id: string; assigneeId: string }> = [];
  const need = { detached: "", page: {} };
  const next = { view: "chat", agents: { ada: { id: "ada", name: "Ada" }, rex: { id: "rex", name: "Rex" } }, rows };
  const context = vm.createContext({
    window: {}, next, navigator, $: (id: keyof typeof nodes) => nodes[id],
    need, watchOnly: () => false, composerCanSend: async () => true, rereadRole: () => {},
    waitsOnPerson: () => true, pendingCards: () => [],
    sayNeed: (row: { id: string }, text: string) => postJson("/api/tasks/update", { id: row.id, note: text }),
    postJson,
    t: (key: string, args?: { error: string }) => args?.error && key.endsWith("sendRefused") ? key + ": " + args.error : key,
  });
  vm.runInContext(NEXT_CHAT_JS + NEXT_DOCK_JS, context);
  const chat = context.chat as { agentId: string; conversation: string; entries: unknown[]; live: unknown; jump: boolean };
  const go = (id: string, conversation = "main") => {
    chat.agentId = id; chat.conversation = conversation;
    vm.runInContext("syncChatComposer(chatTarget())", context);
  };
  const open = (id: string) => go(id);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const loaded: string[] = [];
  context.loadThread = () => loaded.push(chat.agentId);
  context.openChat = open;
  const press = () => vm.runInContext("sendMessage()", context) as Promise<void>;
  const withCard = (id = "card", assigneeId = "ada") => rows.push({ id, assigneeId });
  const replyTarget = () => vm.runInContext("replyTarget()", context) as { id: string } | null;
  go("ada");
  return { input, status, send, navigator, posts, chat, go, press, settle, loaded, withCard, need, replyTarget };
}

test("drafts follow the exact agent and conversation, including explicit @ routing (INV-2106)", async () => {
  const f = chatComposerTest();
  f.input.value = "Only for Ada";
  f.go("rex"); assert.equal(f.input.value, "");
  f.input.value = "Only for Rex";
  f.go("ada"); assert.equal(f.input.value, "Only for Ada");
  f.go("ada", "other"); assert.equal(f.input.value, "", "the same agent's other conversation has its own draft");
  f.input.value = "A different conversation";
  f.go("rex"); assert.equal(f.input.value, "Only for Rex");
  f.go("ada"); assert.equal(f.input.value, "Only for Ada");
  f.go("ada", "other"); assert.equal(f.input.value, "A different conversation");
  f.go("ada"); f.input.value = "@Rex A message for Rex";
  const message = f.press(); await f.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts[0]!.body)), { agent: "rex", conversation: "main", text: "A message for Rex" });
  f.posts[0]!.accept(); await message;
  assert.equal(f.chat.agentId, "rex");
  assert.equal(f.input.value, "Only for Rex", "explicit routing must not overwrite a recipient's own draft");
  f.go("ada"); assert.equal(f.input.value, "");
});

test("an offline send preserves the exact draft and existing turn; retry uses the same Send (INV-2107)", async () => {
  const f = chatComposerTest();
  const existingLive = { text: "Already responding" }, existingEntries = [{ text: "Already sent" }];
  f.chat.live = existingLive; f.chat.entries = existingEntries;
  f.input.value = "  Retry this  "; f.navigator.onLine = false;
  await f.press();
  assert.equal(f.posts.length, 0, "the fetch is never attempted when the browser is already offline");
  assert.equal(f.input.value, "  Retry this  ");
  assert.equal(f.status.textContent, "ui.next.chat.sendOffline");
  assert.equal(f.status.hidden, false);
  assert.equal(f.chat.live, existingLive);
  assert.equal(f.chat.entries, existingEntries);
  f.go("rex"); assert.equal(f.status.hidden, true);
  f.go("ada"); assert.equal(f.status.hidden, false);
  f.navigator.onLine = true;
  const retry = f.press(); await f.settle();
  await f.press();
  assert.equal(f.posts.length, 1);
  assert.equal(f.send.disabled, true);
  assert.equal(f.input.value, "  Retry this  ", "the draft stays until acceptance");
  f.posts[0]!.accept(); await retry;
  assert.equal(f.input.value, "");
  assert.equal(f.send.disabled, false);
  assert.equal(f.status.hidden, true);
  assert.deepEqual(f.loaded, ["ada"], "read the accepted prompt from the server rather than create a bubble");
  assert.equal(f.chat.live, existingLive);
  assert.equal(f.chat.entries, existingEntries);
});

test("a lost response is uncertain, and a late response cannot clear another chat's draft (INV-2107)", async () => {
  const f = chatComposerTest();
  f.input.value = "First message";
  const lost = f.press(); await f.settle();
  f.go("rex"); f.input.value = "Rex's draft";
  f.navigator.onLine = false;
  f.posts[0]!.reject(new TypeError("Failed to fetch")); await lost;
  assert.equal(f.input.value, "Rex's draft");
  assert.equal(f.status.hidden, true);
  f.go("ada"); assert.equal(f.input.value, "First message");
  assert.equal(f.status.textContent, "ui.next.chat.sendUnconfirmed", "offline now does not mean the earlier request never arrived");
  assert.equal(f.chat.live, null);
  assert.equal(f.chat.entries.length, 0);
  f.navigator.onLine = true;
  const refused = f.press(); await f.settle();
  f.posts[1]!.reject(Object.assign(new Error("This role cannot send"), { status: 403 })); await refused;
  assert.equal(f.input.value, "First message");
  assert.equal(f.status.textContent, "ui.next.chat.sendRefused: This role cannot send");
  const next = f.press(); await f.settle();
  f.input.value = "A newer Ada draft";
  f.go("rex");
  f.posts[2]!.accept(); await next;
  assert.equal(f.input.value, "Rex's draft");
  f.go("ada"); assert.equal(f.input.value, "A newer Ada draft");
});

test("a refused reply to a waiting card uses the same draft and delivery status (INV-2107)", async () => {
  const f = chatComposerTest();
  f.withCard(); f.input.value = "The file is ready";
  const reply = f.press(); await f.settle();
  assert.equal(f.posts[0]!.path, "/api/tasks/update");
  f.posts[0]!.reject(Object.assign(new Error("Cannot update the card"), { status: 403 })); await reply;
  assert.equal(f.input.value, "The file is ready");
  assert.equal(f.status.textContent, "ui.next.chat.sendRefused: Cannot update the card");
  assert.equal(f.chat.live, null);
  f.need.detached = "card";
  const detached = f.press(); await f.settle();
  assert.equal(f.posts[1]!.path, "/api/prompt");
  f.posts[1]!.reject(Object.assign(new Error("Cannot start new work"), { status: 409 })); await detached;
  f.withCard("rex-card", "rex"); f.go("rex");
  assert.equal(f.replyTarget()?.id, "rex-card");
  f.input.value = "Reply for Rex's card";
  const other = f.press(); await f.settle();
  assert.equal(f.posts[2]!.path, "/api/tasks/update");
  assert.deepEqual(f.posts[2]!.body, { id: "rex-card", note: "Reply for Rex's card" });
  f.posts[2]!.accept(); await other;
  f.go("ada"); assert.equal(f.input.value, "The file is ready");
  assert.equal(f.replyTarget(), null, "the first card remains detached for its unsent draft");
});

/** One function out of the page's own script, run with the globals it reads. */
function pageFunction(name: string, globals: Record<string, unknown>): (...args: unknown[]) => unknown {
  const script = pageScripts(NEXT_PAGE("en")).sort((a, b) => b.length - a.length)[0]!;
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page has ${name}`);
  let depth = 0, end = start;
  for (let i = script.indexOf("{", start); i < script.length; i++) {
    if (script[i] === "{") depth++;
    if (script[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return vm.runInNewContext(`(${script.slice(start, end)})`, globals) as (...args: unknown[]) => unknown;
}

test("opening Computers refreshes inventory even if the tab was already open", () => {
  const next = { view: "work" }, settings = { pane: "team" }, visits: string[] = [];
  const opened = { dataset: {} };
  const renderOpenedView = pageFunction("renderOpenedView", {
    next,
    render: () => {},
    refresh: () => visits.push("refresh " + next.view),
  });
  const selectView = pageFunction("selectView", { next, settings });
  const openView = pageFunction("navigateView", {
    selectView, settings, document: { body: opened }, renderOpenedView,
    writeViewAddress: (view: string) => visits.push("?view=" + view),
  });
  openView("boxes");
  openView("work");
  openView("boxes");
  openView("boxes");
  assert.deepEqual(visits, ["?view=boxes", "refresh boxes", "?view=work", "?view=boxes", "refresh boxes", "?view=boxes", "refresh boxes"]);
  assert.equal(settings.pane, "");
  assert.deepEqual(opened.dataset, { open: "1" });
});

test("personal computer creation has a request ID on HTTP without randomUUID", () => {
  let calls = 0;
  const requestId = pageFunction("personalComputerRequestId", {
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(++calls) },
  });
  const first = requestId(), second = requestId();
  assert.match(String(first), /^[A-Za-z0-9_-]{1,100}$/);
  assert.notEqual(first, second);
  assert.equal(calls, 2);
});

test("Mine Tokens guides an unsigned fresh install to bootstrap and handles an owner refusal", async () => {
  const mine = { setup: null as null | { admins: number; bootstrap: boolean }, needsPerson: false, issued: "", tokens: [] };
  const settings = { me: { identity: null as string | null } };
  const { MESSAGES } = await import("../i18n/messages.ts");
  const t = (key: string) => MESSAGES.en[key] ?? key;
  const globals = { mine, settings, el: fakeEl, t };
  const notice = pageFunction("tokenSetupNotice", globals) as () => Fake | null;
  const all = (node: Fake): Fake[] => [node, ...node.kids.flatMap(all)];
  const loadMine = pageFunction("loadMine", {
    mine, next: { view: "settings" }, render: () => {},
    getJson: (path: string) => Promise.resolve(path === "/api/mcp" ? { setup: { admins: 0, bootstrap: true }, tokens: [] } : {}),
  });
  loadMine(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(all(notice()!).find(node => node.href)?.href, "/bootstrap");
  assert.ok(all(notice()!).some(node => node.text.includes("bootstrap-code")));
  mine.setup!.bootstrap = false;
  assert.ok(all(notice()!).some(node => node.text.includes("repair the local roster")));
  assert.ok(all(notice()!).every(node => !node.href), "closed bootstrap is not linked");
  mine.setup!.admins = 1; assert.equal(notice(), null);
  mine.setup = { admins: 0, bootstrap: true }; settings.me.identity = "feishu:driver";
  assert.equal(notice(), null, "a signed-in driver does not need initialization");
  settings.me.identity = null; mine.setup = null;
  assert.equal(notice(), null, "unknown setup state does not invent a bootstrap path");
  let failure: unknown, loaded = 0;
  const tokensBlock = pageFunction("tokensBlock", {
    ...globals, tokenSetupNotice: notice, loadMine: () => { loaded++; }, failed: (error: unknown) => { failure = error; },
    postJson: () => Promise.reject({ data: { code: "token-needs-person" } }),
  }) as () => Fake;
  all(tokensBlock()).find(node => node.text === t("ui.next.mine.issue"))!.press!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mine.needsPerson, true); assert.equal(loaded, 1); assert.equal(failure, undefined);
  assert.ok(all(notice()!).some(node => node.text.includes("Sign in as a driver or administrator")));
  mine.setup = { admins: 0, bootstrap: true };
  assert.equal(all(notice()!).find(node => node.href)?.href, "/bootstrap", "a refusal keeps the available first-admin path");
});

test("welcome setup uses the latest box result even when setup is the last response", async () => {
  const settings = { setup: { installationId: "fresh", box: false }, me: { identity: null } };
  const boxes = { list: [], own: "", state: null };
  const setupCard = pageFunction("setupCard", {
    settings, chat: { box: "b1" }, agentsHere: () => [], canOperateInstallation: () => true, canDriveAgents: () => true,
    localStorage: { getItem: () => null }, t: String, el: fakeEl,
  });
  const boxStep = () => (setupCard() as Fake).kids[2]!;
  let finishSetup!: (setup: typeof settings.setup) => void;
  const delayedSetup = new Promise<typeof settings.setup>(resolve => { finishSetup = resolve; });
  const drawn: string[][] = [];
  const refresh = pageFunction("refresh", {
    next: { agents: {} }, settings, boxes, chat: {}, member: {}, panel: {}, rereadRole: () => {},
    getJson: (path: string) => path === "/api/setup" ? delayedSetup : Promise.resolve({ boxes: [{ id: "b1", connected: true }] }),
    render: () => { drawn.push(boxStep().kids.map(node => node.text)); },
    failed: (error: unknown) => { throw error; },
  });
  assert.deepEqual(boxStep().kids.map(node => node.text), ["○", "ui.next.setup.box", "ui.next.box.off", "ui.next.setup.go"]);
  const pending = refresh();
  await new Promise(resolve => setImmediate(resolve));
  finishSetup({ installationId: "fresh", box: true });
  await pending;
  assert.deepEqual(drawn, [["✓", "ui.next.setup.box", "ui.next.box.on"]], "the refresh redraws the card from the new setup response");
});

test("reopening Boxes settings refreshes its status and preserves the settings route", () => {
  const boxSet = { config: null as object | null };
  const writes: unknown[][] = [];
  let loads = 0;
  const next = {};
  const renderOpenedView = pageFunction("renderOpenedView", { next, render() {} });
  const settings = { pane: "" };
  const selectView = pageFunction("selectView", { next, settings, settingsPane: (key: unknown) => key });
  const navigateView = pageFunction("navigateView", {
    selectView, settings, document: { body: { dataset: {} } },
    writeViewAddress: (...args: unknown[]) => writes.push(args), renderOpenedView,
  });
  const open = pageFunction("openSettingsPane", {
    navigateView, boxSet, loadBoxSet: () => { loads++; }, canDriveAgents: () => true, settingsPanes: () => ["boxes"],
  });
  open("boxes");
  assert.equal(loads, 0, "the first render loads the previously unseen pane");
  boxSet.config = {};
  open("boxes");
  assert.equal(loads, 1, "reopening the pane refreshes the cached boxes");
  assert.deepEqual(writes, [["settings", "boxes"], ["settings", "boxes"]]);
});

test("member Settings has only personal panes; an installation pane cannot be opened by a deep link", () => {
  const settings = { pane: "model", me: { role: "driver" } };
  const fail = () => assert.fail("an installation setting was rendered for a member");
  const settingPanes = pageFunction("settingsPanes", {
    canOperateInstallation: () => settings.me.role === "admin", canDriveAgents: () => settings.me.role !== "viewer",
  });
  const navigations: string[][] = [];
  const openSettingsPane = pageFunction("openSettingsPane", {
    settingsPanes: settingPanes, canDriveAgents: () => settings.me.role !== "viewer",
    navigateView: (view: string, pane: string) => { navigations.push([view, pane]); settings.pane = pane; },
  });
  const renderSettings = pageFunction("renderSettings", {
    settings, settingsPanes: settingPanes, canOperateInstallation: () => false, openSettingsPane,
    NATIVE_PANES: { model: fail, mine: () => {} }, renderLongWork: fail, el: fakeEl, t: String,
  });
  const view = fakeEl("div");
  renderSettings(view);
  assert.deepEqual(view.kids[0]!.kids.map(row => row.kids[0]!.kids[0]!.text), ["ui.pane.mine", "ui.pane.memory"]);
  openSettingsPane("model");
  view.kids[0]!.kids[0]!.press!();
  const mine = fakeEl("div");
  renderSettings(mine);
  mine.kids[0]!.press!();
  settings.me.role = "viewer";
  openSettingsPane("");
  assert.deepEqual(navigations, [["settings", "mine"], ["settings", ""]]);
  const viewer = fakeEl("div");
  renderSettings(viewer);
  assert.equal(viewer.kids.length, 0);
});

test("the member setup checklist counts only the selected box; a viewer gets no operator tasks", () => {
  const chat = { box: "empty" }, settings = { setup: { installationId: "test", hasPersonalBox: true }, me: { identity: "person", role: "driver" } };
  const setupCard = pageFunction("setupCard", {
    settings, chat, canDriveAgents: () => settings.me.role === "driver", canOperateInstallation: () => false,
    agentsHere: () => chat.box === "shared" ? [{ id: "ada" }] : [], createSetupBox: () => {},
    localStorage: { getItem: () => null }, t: String, el: fakeEl,
  }) as () => Fake | null;
  assert.deepEqual(setupCard()!.kids.slice(1, 3).map(step => step.kids.map(part => part.text)), [
    ["✓", "ui.next.setup.personalBox"], ["○", "ui.next.setup.agent", "ui.next.setup.go"],
  ]);
  chat.box = "shared";
  assert.equal(setupCard(), null, "the completed steps are no longer in the way");
  settings.me.role = "viewer";
  chat.box = "empty";
  assert.equal(setupCard(), null);
});

test("a driver with no visible box can start personal-box creation from setup", () => {
  let created = false;
  const setupCard = pageFunction("setupCard", {
    settings: { setup: { installationId: "test", hasPersonalBox: false }, me: { identity: "person" } },
    chat: { box: "" }, canDriveAgents: () => true, canOperateInstallation: () => false,
    localStorage: { getItem: () => null }, t: String, el: fakeEl, agentsHere: () => [], createSetupBox: () => { created = true; },
  }) as () => Fake | null;
  const card = setupCard();
  assert.ok(card);
  assert.deepEqual(card.kids.slice(1, -1).map(step => step.kids[1]!.text), ["ui.next.setup.personalBox"]);
  card.kids[1]!.kids[2]!.press!();
  assert.ok(created);
});

test("creating a personal box from chat clears the previous transcript before refresh renders", async () => {
  const chat = {
    box: "shared", agentId: "ada", entries: [{ text: "shared transcript" }], live: { text: "live reply" },
    liveSurfaces: { form: {} }, loadedFor: "ada", loading: "ada", conversation: "topic", request: 2,
  };
  let refreshed = false;
  const create = pageFunction("createSetupBox", {
    chat, settings: {}, crypto: { randomUUID: () => "request" }, render: () => {},
    postJson: async () => ({ boxId: "personal", boxes: [{ id: "personal", status: "ready" }] }),
    failed: (error: unknown) => { throw error; }, refresh: () => { refreshed = true; },
  });
  create();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(refreshed);
  assert.equal(chat.box, "personal");
  assert.equal(chat.agentId, "");
  assert.equal(chat.entries.length, 0);
  assert.equal(chat.live, null);
  assert.deepEqual(Object.keys(chat.liveSurfaces), []);
  assert.equal(chat.loadedFor, "");
  assert.equal(chat.loading, "");
  assert.equal(chat.conversation, "main");
  assert.equal(chat.request, 3, "late progress for the previous agent is ignored");
});

test("new agent box picker shows the selected box and remembers a changed target", () => {
  const member = { boxId: "personal" };
  const pickBox = pageFunction("memberBoxField", {
    member, el: fakeEl, t: String, boxesKnown: () => [{ id: "shared", name: "Shared" }, { id: "personal", name: "Personal" }],
  }) as () => Fake;
  const field = pickBox(), select = field.kids[0]!;
  assert.equal(field.text, "ui.next.member.box");
  assert.deepEqual(select.kids.map(option => option.text), ["Shared", "Personal"]);
  assert.equal(select.value, "personal");
  select.value = "shared";
  select.press!();
  assert.equal(member.boxId, "shared");
  assert.equal(pickBox().kids[0]!.value, "shared");
});

test("\"@Bob …\" typed to Ada is said to Bob; a name mid-sentence, an unknown name and the agent's own are not", () => {
  const agents = { a: { id: "a", name: "Ada" }, b: { id: "b", name: "Bob" } };
  const addressed = pageFunction("addressed", { next: { agents }, chat: { agentId: "a" } });
  assert.deepEqual(JSON.parse(JSON.stringify(addressed("@bob  check the build"))), { agent: agents.b, text: "check the build" });
  assert.equal(addressed("ask @Bob about it"), null);
  assert.equal(addressed("@Nobody hello"), null);
  assert.equal(addressed("@Ada hello"), null, "already talking to Ada");
});

test("a press on an agent's card is the line the server parses it from", async () => {
  const { parseActionText } = await import("../host/show-ui.ts");
  const { MESSAGES } = await import("../i18n/messages.ts");
  for (const locale of ["zh", "en"] as const) {
    const line = MESSAGES[locale]["ui.next.card.actionLine"]!.replace("{name}", JSON.stringify("confirm")).replace("{id}", "installation").replace("{context}", ': {"n":1}');
    assert.deepEqual(parseActionText(line), { name: "confirm", surfaceId: "installation", context: { n: 1 } }, locale);
  }
});

test("a result waiting for the person says where it came from and what was reported, and its three buttons do three things", async () => {
  // 2026-11-12: four cards read "Bob delivered a result" over a title and three buttons. The work was asked for in
  // Feishu, the report was in the record, and Request changes and Open both opened the same panel.
  const el = fakeEl;
  const posted: unknown[] = [], opened: string[] = [], chat = { changing: "" };
  const files = [1, 2, 3, 4, 5, 6].map(n => ({ id: `f${n}`, name: `part-${n}.md` }));
  const t = (key: string, values?: { n?: number; name?: string }) => key + (values?.n ?? "") + (values?.name ? `(${values.name})` : "");
  const agentName = (id: string) => ({ mia: "Mia", ada: "Ada" })[id] ?? id;
  const originOf = pageFunction("originOf", { next: { agents: { mia: {}, ada: {} } }, MSG: { "ui.next.origin.feishu": "x", "ui.next.origin.web": "x" }, t, agentName, agoText: () => "3d" });
  assert.deepEqual(["feishu-zongheng:ou_1", "web", "ada", "mcp:k"].map(requester => originOf({ requester })),
    ["ui.next.origin.feishu", "ui.next.origin.web", "ui.next.origin.agent(Ada)", "ui.next.origin.other"], "the door it came through, or the agent that started it");
  const signOffLines = pageFunction("signOffLines", { el, t });
  const rich = (text: string, cls: string) => el("div", cls, text);
  const reportBlock = pageFunction("reportBlock", { el, t, rich }) as (report: unknown, keys: readonly string[]) => Fake;
  const need = { refusing: "", previews: {} };
  const fileRow = pageFunction("fileRow", { el, t, need, encodeURIComponent, PREVIEW_KIND: { md: "text" }, failed: () => {} });
  const embedInto = pageFunction("embedInto", { el, t, need, fileRow });
  const laterButton = pageFunction("laterButton", { el, t, nextLaterTimes: nextLogic.nextLaterTimes, postJson: () => Promise.resolve({}), toast: () => {}, failed: () => {} });
  const askBrief = pageFunction("askBrief", { el, t, rich, askProse });
  const resultGlobals = {
    embedInto, laterButton, askBrief,
    reportBlock, REPORT_BRIEF: DELIVERY_BRIEF, el, t, agentName, originOf, chat, signOffLines, agoText: () => "3d", rich, toast: () => {}, refreshSoon: () => {}, failed: () => {}, encodeURIComponent,
    render: () => {}, document: { querySelector: () => null },
    openPanel: (id: string) => opened.push(id), postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); },
  };
  const resultCard = pageFunction("resultCard", { ...resultGlobals, resultActs: pageFunction("resultActs", resultGlobals) });
  const row = { id: "t1", title: "October report", assigneeId: "mia", requester: "feishu:ou_1", createdAt: "2026-11-01T00:00:00.000Z", deliverables: files, report: { at: "2026-11-02T00:00:00.000Z", by: "ada", note: "Checked: **cannot be accepted as is**." }, signOffBecause: ["files", "remarked"] };
  const card = resultCard(row) as Fake;
  const chips = (from: Fake) => from.kids.find(kid => kid.cls === "embeds")!.kids[0]!.kids;
  assert.ok(card.kids.some(kid => kid.text === "October report · ui.next.origin.feishu · 3d"), "which work, and where the request came from, in one line");
  assert.deepEqual(card.kids.filter(kid => kid.text.startsWith("ui.next.because.")).map(kid => kid.text), ["ui.next.because.files6", "ui.next.because.remarked"], "why it waits for the person (INV-1904)");
  assert.ok(card.kids.some(kid => kid.cls === "report" && kid.text.includes("cannot be accepted")), "what was reported is on the card");
  assert.equal(chips(card).filter(kid => kid.cls === "chip-file").length, 4, "the files are names in one row, not a box each");
  assert.ok(chips(card).some(kid => kid.text === "ui.next.chat.moreFiles2"), "the rest are counted, not listed");
  assert.deepEqual(card.kids.slice(-2).map(kid => kid.cls), ["acts", "why"], "the card ends at its buttons and the line that says what each leads to");
  assert.equal(card.kids.at(-1)!.text, "ui.next.chat.reviewHint(Mia) ui.next.need.hint.later", "said on the card, not in a tooltip");
  const [accept, changes, details] = card.kids.at(-2)!.kids;
  accept!.press!(); details!.press!(); changes!.press!();
  await Promise.resolve();
  assert.deepEqual(opened, ["t1"], "Details opens the panel; Request changes does not");
  assert.equal(chat.changing, "t1");
  const asking = resultCard(row) as Fake, input = asking.kids.at(-2)!, [send] = asking.kids.at(-1)!.kids;
  send!.press!(); // nothing written: nothing sent
  input.value = "Drop the 536-tool claim."; send!.press!();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [["/api/tasks/update", { id: "t1", status: "done" }], ["/api/tasks/update", { id: "t1", status: "doing", note: "Drop the 536-tool claim." }]]);
  const bare = resultCard({ id: "t2", title: "Nothing left behind", assigneeId: "mia", requester: "web" }) as Fake;
  assert.ok(bare.kids.some(kid => kid.text === "ui.next.chat.noReport"), "an empty result says it is empty");
  // INV-1923: where the agent wrote what it needs, that is the card's title; where it did not, the fixed line and why it
  // waits stand, as above. The buttons of a result to look at are the same either way, with "later" beside them.
  assert.equal(card.kids[0]!.text, "ui.next.chat.review", "nothing written: the fixed line");
  const wrote = { kind: "check", title: "Check the DST branch before it ships", lang: "en", said: [{ key: "how", text: "Open src/export.ts line 41" }, { key: "meanwhile", text: "Fixing the same bug on import." }, { key: "unverified", text: "The live account." }] };
  const asked = resultCard({ ...row, ask: wrote }) as Fake;
  assert.equal(asked.kids[0]!.text, "Check the DST branch before it ships", "the agent's own title");
  assert.ok(!asked.kids.some(kid => kid.text.startsWith("ui.next.because.")), "its title says why it is here: the table's reasons are not stacked under it");
  // With no delivery to read, the agent's sentences are the card: one running paragraph without the names they were written
  // under, and what stays the person's to check set apart from it.
  assert.equal(asked.kids.find(kid => kid.cls === "said")!.text, "Open src/export.ts line 41. Meanwhile: Fixing the same bug on import.");
  assert.deepEqual(asked.kids.find(kid => kid.cls === "yours")!.kids.map(kid => kid.text), ["ui.next.ask.unverified", "The live account."]);
  assert.ok(!asked.kids.some(kid => kid.cls === "parts"), "no labelled breakdown on the card: that is in the work's panel");
  assert.deepEqual(asked.kids.at(-2)!.kids.map(kid => kid.text), ["ui.next.act.accept", "ui.next.act.changes", "ui.next.act.details", "ui.next.act.snooze"]);
  // INV-1922: a result written as a delivery is drawn by its parts. The card shows the short form; what was not
  // verified is on it without a click, and a delivery that never said is told apart from one that said "none".
  const { lastReport } = await import("./task-board-record.ts");
  const note = "The export keeps the time zone.\nMain change: src/export.ts:41, the DST branch.\nOther changes: renamed a helper.\nVerified: 12 tests on 3f2a9c1.\nNot done or limits: not run on the live account.\nNext: you confirm one export.";
  const delivered = lastReport({ createdAt: "2026-11-01T00:00:00.000Z", history: [{ at: "2026-11-02T00:00:00.000Z", by: "mia", note: `${note}${" and more".repeat(200)}` }] } as never)!;
  const parts = (block: Fake) => block.kids.map(kid => [kid.dataset.part, kid.kids.map(inner => inner.text).join(" | ")]);
  const onCard = (resultCard({ ...row, report: delivered }) as Fake).kids.find(kid => kid.cls === "parts")!;
  assert.deepEqual(parts(onCard).map(([key]) => key), ["result", "main", "limits", "next"], "the card is the short form; the rest is one click away");
  assert.deepEqual(parts(onCard)[2], ["limits", "ui.next.report.limits | not run on the live account."], "read from the whole note, so a long one does not lose it to the cut");
  assert.deepEqual(parts(reportBlock(delivered, DELIVERY_SECTIONS)).map(([key]) => key), [...DELIVERY_SECTIONS], "the panel shows every part");
  // A delivery that also asks is one card: the request's sentences are not stacked on the delivery's parts, which say the same.
  const both = resultCard({ ...row, report: delivered, ask: wrote }) as Fake;
  assert.deepEqual([both.kids[0]!.text, both.kids.filter(kid => kid.cls === "parts").length, both.kids.filter(kid => kid.cls === "said" || kid.cls === "yours").length], ["Check the DST branch before it ships", 1, 0]);
  assert.deepEqual(parts(both.kids.find(kid => kid.cls === "parts")!)[2], ["limits", "ui.next.report.limits | not run on the live account."], "and what was not verified is still on it");
  const silent = lastReport({ createdAt: "2026-11-01T00:00:00.000Z", history: [{ at: "2026-11-02T00:00:00.000Z", by: "mia", note: "Fixed.\nMain change: src/export.ts\nNext: you confirm." }] } as never)!;
  assert.deepEqual(parts(reportBlock(silent, DELIVERY_BRIEF))[2], ["limits", "ui.next.report.limits | ui.next.report.unstated"], "left out is said, not hidden");
  assert.equal(reportBlock({ note: "Checked: fine." }, DELIVERY_BRIEF).cls, "report", "a note not written as a delivery is shown as it was written");
  // The page names a part by the word a member is asked to write it under: one name per part, in both languages.
  const { MESSAGES } = await import("../i18n/messages.ts");
  for (const key of DELIVERY_SECTIONS.slice(1)) for (const locale of ["zh", "en"] as const) assert.equal(MESSAGES[locale][`ui.next.report.${key}`], deliveryLabel(key, locale), key);
});

test("a draft waiting to be sent and a proposal to close are decided on their inbox rows", async () => {
  interface Fake { text: string; kids: Fake[]; childNodes: Fake[]; style: Record<string, string>; press?: () => void; appendChild(kid: Fake): void; addEventListener(name: string, run: () => void): void; replaceChildren(): void; querySelectorAll(): Fake[] }
  const el = (_tag: string, _cls = "", text = ""): Fake => {
    const kids: Fake[] = [], node: Fake = { text, kids, childNodes: kids, style: {}, appendChild(kid) { node.kids.push(kid); }, addEventListener(_name, run) { node.press = run; }, replaceChildren() {}, querySelectorAll: () => [] };
    return node;
  };
  const posted: unknown[] = [];
  // Work that waits on the person is answered on its row, with the buttons its card has (INV-2189): drawn by the same two functions.
  const waiting = [{ id: "t5", status: "blocked", ask: { kind: "do" } }, { id: "t6", status: "review", reading: { phase: "review" } }];
  const inboxRow = pageFunction("inboxRow", {
    el, t: (key: string) => key, owedText: () => "", initial: () => "A", isTask: () => true, openPanel: () => {}, openChat: () => {}, failed: () => {}, settle: () => {}, inboxPlace: () => null,
    postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); },
    next: { rows: waiting }, nextNeedOf: nextLogic.nextNeedOf,
    needActs: (box: Fake, row: { id: string }) => box.appendChild(el("button", "act", "needActs " + row.id)), resultActs: (box: Fake, row: { id: string }) => box.appendChild(el("button", "act", "resultActs " + row.id)),
  });
  const buttons = (kind: string, ref = "r1") => (inboxRow({ kind, ref, title: "x" }) as Fake).kids.slice(1).flatMap(kid => kid.kids).flatMap(kid => (kid.kids.length ? kid.kids : [kid]));
  buttons("outbox")[0]!.press!(); buttons("close-proposal")[0]!.press!();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [["/api/outbox/decide", { id: "r1", decision: "approve" }], ["/api/tasks/oppose-close", { id: "r1" }]]);
  assert.equal(buttons("review").length, 0, "a row with nothing to decide on it has no buttons");
  assert.deepEqual([buttons("question", "t5").map(kid => kid.text), buttons("review", "t6").map(kid => kid.text)], [["needActs t5"], ["resultActs t6"]], "what its card asks, answered here");
  // A row that is not about a piece of work goes where it is dealt with, from its button and from the row itself.
  const opened: string[] = [];
  const placed = pageFunction("inboxRow", {
    el, t: (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : ""), owedText: () => "", initial: () => "A", isTask: (ref: string) => /^t\d+$/.test(ref), openPanel: (id: string) => opened.push("panel " + id), failed: () => {}, settle: () => {}, postJson: () => Promise.resolve({}),
    inboxPlace: pageFunction("inboxPlace", {
      INBOX_PLACES: { "box-update": ["settings", "boxes"], "routine-paused": ["auto", ""] }, INBOX_AGENT_KINDS: ["spend-limit"], next: { agents: { mia: {} } }, agentName: () => "Mia",
      t: (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : ""),
      openSettingsPane: (pane: string) => opened.push("settings " + pane), navigateView: (view: string) => opened.push(view), openChat: (id: string) => opened.push("chat " + id),
    }),
  }) as (item: unknown) => Fake;
  const update = placed({ kind: "box-update", ref: "box", title: "The box can be updated" });
  const go = update.kids.slice(1).flatMap(kid => kid.kids)[0]!;
  assert.equal(go.text, "ui.next.inbox.go(ui.pane.boxes)", "the button names the place");
  go.press!(); update.kids[0]!.press!();
  placed({ kind: "routine-paused", ref: "t12", title: "x" }).kids[0]!.press!(); // a routine whose slug looks like a work id still goes to Automation
  placed({ kind: "spend-limit", ref: "mia", title: "x" }).kids[0]!.press!();
  assert.deepEqual(opened, ["settings boxes", "settings boxes", "auto", "chat mia"]);
});

test("a turn's process is one line saying how long it took, a teammate's messages one line saying who and how many; a click opens all of it", () => {
  // INV-1924: the default level is what was said and a line per process; the steps, their inputs and the teammates' words are a click away.
  const t = (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : "");
  const document = { createTextNode: (text: string) => fakeEl("#text", "", text) };
  const workedFor = pageFunction("workedFor", { t, Date, Math }) as (from: string, to: string) => string;
  const shared = { t, el: fakeEl, document, clip: pageFunction("clip", { String }), workedFor, withMembers: pageFunction("withMembers", { t }), bubble: (entry: { text: string }) => fakeEl("div", "msg", entry.text) };
  const drawEntries = pageFunction("drawEntries", { ...shared, fold: pageFunction("fold", shared) }) as (target: Fake, entries: unknown[]) => unknown;
  const long = "Checked the DST branch. ".repeat(20).trim();
  const entries = [
    { kind: "text", role: "user", text: "Fix the export time zone.", at: "2026-11-20T09:00:00Z" },
    { kind: "text", role: "assistant", opening: true, text: "Looking now.", at: "2026-11-20T09:00:04Z" },
    { kind: "tools", at: "2026-11-20T09:01:20Z", tools: [{ name: "bash", phrase: { en: "running a command" }, detail: "npm test -- export" }] },
    { kind: "text", role: "assistant", aside: true, text: "one failing", at: "2026-11-20T09:03:00Z" },
    { kind: "tools", at: "2026-11-20T09:05:00Z", tools: [{ name: "edit_file", phrase: { en: "editing src/export.ts" }, detail: "offset = zoneOffset(at)" }] },
    { kind: "text", role: "assistant", text: "Fixed; Bob is checking.", at: "2026-11-20T09:07:52Z" },
    { kind: "peer", messages: [{ from: "Bob", text: long }, { from: "Bob", text: "One nit." }] },
    { kind: "text", role: "assistant", text: "Bob confirmed.", at: "2026-11-20T09:09:00Z" },
  ];
  const thread = fakeEl("div", "thread");
  drawEntries(thread, entries);
  const said = (node: Fake): string => node.text + node.kids.map(said).join("");
  assert.deepEqual(thread.kids.map(node => node.cls === "fold" ? node.kids[0]!.text : node.text),
    ["Fix the export time zone.", "Looking now.", "ui.next.chat.worked(8)", "Fixed; Bob is checking.", "ui.next.chat.with(Bob|2)", "Bob confirmed."],
    "both runs of steps and the aside between them are one line timed from the last thing said to the next; the teammate's two messages one more");
  const [steps, peer] = thread.kids.filter(node => node.cls === "fold");
  assert.ok(!thread.kids.filter(node => node.cls !== "fold").some(node => said(node).includes("npm test")), "no step's input is drawn outside its fold");
  assert.ok(said(steps!).includes("running a command") && said(steps!).includes("editing src/export.ts"), "opened, the fold has every step");
  assert.ok(said(peer!).includes(long) && said(peer!).includes("One nit."), "opened, the teammate's words are whole, not clipped");

  assert.equal(workedFor("2026-11-20T09:00:00Z", "2026-11-20T09:00:40Z"), "ui.next.chat.workedBrief");
  assert.equal(workedFor("2026-11-20T09:00:00Z", "2026-11-20T10:30:00Z"), "ui.next.chat.workedHours(1.5)");
  // A run a teammate's reply started is timed from that reply, and a card between two runs splits the time between them (Devin Review on #752).
  const card = fakeEl("div", "card", "the card");
  const split = fakeEl("div", "thread");
  (pageFunction("drawEntries", { ...shared, fold: pageFunction("fold", shared), feedSurface: () => card }) as typeof drawEntries)(split, [
    { kind: "text", role: "assistant", text: "Asked Bob.", at: "2026-11-20T09:00:00Z" },
    { kind: "peer", messages: [{ from: "Bob", text: "go ahead" }], at: "2026-11-20T09:10:00Z" },
    { kind: "tools", at: "2026-11-20T09:10:30Z", tools: [{ name: "bash" }] },
    { kind: "tools", at: "2026-11-20T09:12:00Z", tools: [{ name: "ShowUI", surface: { surfaceId: "s", messages: [] } }] },
    { kind: "tools", at: "2026-11-20T09:13:00Z", tools: [{ name: "bash" }] },
    { kind: "text", role: "assistant", text: "Done.", at: "2026-11-20T09:15:00Z" },
  ]);
  assert.deepEqual(split.kids.map(node => node.cls === "fold" ? node.kids[0]!.text : node.text),
    ["Asked Bob.", "ui.next.chat.with(Bob|1)", "ui.next.chat.worked(2)", "the card", "ui.next.chat.worked(3)", "Done."], "not the ten minutes waiting for Bob, and not the first run twice");
  const untimed = fakeEl("div", "thread");
  drawEntries(untimed, [{ kind: "tools", tools: [{ name: "bash" }, { name: "read_file" }] }, { kind: "text", role: "assistant", text: "done" }]);
  assert.equal(untimed.kids[0]!.kids[0]!.text, "ui.next.chat.steps(2)", "a run nobody timed (a live one) still says how many steps");
});

test("a conversation exported is what was said, by whom, in order; steps and asides stay behind", () => {
  const threadMarkdown = pageFunction("threadMarkdown", {});
  const entries = [
    { kind: "text", role: "user", text: "Summarise October.", at: "2026-11-02T09:15:00Z" },
    { kind: "tools", tools: [{ name: "read_file" }] },
    { kind: "text", role: "assistant", aside: true, text: "reading the tickets" },
    { kind: "text", role: "assistant", text: "Five themes.\n\n- login\n" },
  ];
  assert.equal(threadMarkdown(entries, "Mia", "You"), "## You · 2026-11-02 09:15\n\nSummarise October.\n\n## Mia\n\nFive themes.\n\n- login\n");
  const threadFinds = pageFunction("threadFinds", {});
  assert.deepEqual(entries.map(entry => threadFinds(entry, "the")), [false, false, false, true], "found in what was said, whatever its case; never in a step or an aside");
});

test("\"/\" opening a message asks for a skill, \"@\" at a word asks for a colleague, and a path or an address asks for nothing", () => {
  const composerQuery = pageFunction("composerQuery", {}), composerPick = pageFunction("composerPick", {});
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
  assert.deepEqual(plain(composerQuery("/res", 4)), { kind: "skill", query: "res" });
  assert.equal(composerQuery("see /home/box/work", 18), null, "mid-sentence a slash is a path");
  assert.equal(composerQuery("/research brief on", 18), null, "a skill name is one word: after a space it is a message");
  assert.deepEqual(plain(composerQuery("ask @bo about it", 7)), { kind: "mention", query: "bo" }, "at the caret, not at the end");
  assert.equal(composerQuery("mail a@b.com", 12), null);
  assert.deepEqual(plain(composerPick("ask @bo about it", 7, "mention", "Bob", "")), { value: "ask @Bob  about it", caret: 9 });
  assert.deepEqual(plain(composerPick("/res", 4, "skill", "research-brief", "Use the research-brief skill.")), { value: "Use the research-brief skill.", caret: 29 });
});

test("the share of input served from cache is of everything read, and unknown when nothing was", () => {
  const cacheHit = pageFunction("cacheHit", {});
  assert.equal(cacheHit({ inputTokens: 250, cacheReadTokens: 750 }), 75);
  assert.equal(cacheHit({ inputTokens: 0, cacheReadTokens: 0 }), undefined);
  assert.equal(cacheHit(undefined), undefined);
});

test("a configuration version is said by what it changed, and a restored one by where it went back to", () => {
  const versionLine = pageFunction("versionLine", { t: (key: string, values?: { n?: number }) => key + (values?.n ?? "") });
  assert.equal(versionLine({ n: 3, changes: [{ field: "model" }, { field: "tools" }] }), "model, tools");
  assert.equal(versionLine({ n: 1, changes: [] }), "ui.next.config.first");
  assert.equal(versionLine({ n: 4, restoredFrom: 2, changes: [{ field: "model" }] }), "ui.next.config.backTo2 · model");
});

test("a tool is allowed, asked about or off; a floor removes the choices below it, and a save sends only what differs from the group", () => {
  const toolStateOf = pageFunction("toolStateOf", {}), toolsSaved = pageFunction("toolsSaved", {});
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const perms = { groups: { web: "ask" }, tools: { bash: "ask" } }, floors = { browser_upload: { effect: "ask" }, RunOnHost: { effect: "deny" } }, never = ["AskUser"];
  const state = (name: string, group: string, tools: string[] | null) => plain(toolStateOf(name, group, tools, perms, floors, never)) as { value: string; choices: string[]; inherited: string };
  assert.deepEqual([state("bash", "code", null).value, state("WebFetch", "web", null).value, state("read_file", "code", null).value], ["ask", "ask", "allow"], "its own setting, its group's, the default");
  assert.equal(state("read_file", "code", ["bash"]).value, "off", "left out of the agent's list");
  assert.deepEqual(state("browser_upload", "web", null).choices, ["ask", "off"], "the organisation's floor cannot be gone below");
  const forced = plain(toolStateOf("RunOperation", "other", null, perms, { RunOperation: { effect: "ask" } }, never)) as { inherited: string };
  assert.equal(forced.inherited, "ask", "and what it forces is not saved as the agent's own choice");
  assert.deepEqual(state("RunOnHost", "other", null).choices, ["off"]);
  assert.deepEqual(state("AskUser", "team", null).choices, ["allow", "off"], "asking before asking is not a choice");
  const rows = [{ name: "bash", group: "code", value: "allow", inherited: "allow" }, { name: "WebFetch", group: "web", value: "ask", inherited: "ask" }, { name: "edit_file", group: "code", value: "ask", inherited: "allow" }, { name: "computer", group: "desk", value: "off", inherited: "allow" }];
  assert.deepEqual(plain(toolsSaved(rows, ["bash", "ext__tool"], perms)), { tools: ["bash", "WebFetch", "edit_file", "ext__tool"], toolPermissions: { groups: { web: "ask" }, tools: { edit_file: "ask" } } }, "a tool the page does not list is kept");
});

test("every template on offer is one row with what a press sends, and is found by its name or its note", () => {
  const shelfRows = pageFunction("shelfRows", {}), shelfFound = pageFunction("shelfFound", {});
  const rows = JSON.parse(JSON.stringify(shelfRows({
    marketplace: [{ slug: "support-desk", name: "Support desk", title: "Answers tickets" }],
    mine: [{ agentId: "a1", agentName: "Mia", version: 3, name: "Weekly reporter" }],
    catalog: [{ kind: "expert", slug: "analyst", name: "Analyst", title: "Reads the numbers" }, { kind: "crew", slug: "content", name: "Content crew", summary: "Five roles", members: [{ name: "Scout" }, { name: "Writer" }] }],
  }))) as { group: string; name: string; note: string; send: unknown }[];
  assert.deepEqual(rows.map(row => [row.group, row.send]), [["ready", { templateSlug: "support-desk" }], ["mine", { agentId: "a1", version: 3 }], ["role", { catalogSlug: "analyst" }], ["crew", { catalogSlug: "content" }]]);
  assert.equal(rows[3]!.note, "Five roles · Scout, Writer", "a crew says who is in it");
  assert.deepEqual((shelfFound(rows, " WRITER ") as { name: string }[]).map(row => row.name), ["Content crew"]);
  assert.equal((shelfFound(rows, "") as unknown[]).length, 4);
});

test("the agent list narrows to a team; agents in none are their own choice, and a team nobody here is in narrows nothing", () => {
  const teamsOf = pageFunction("teamsOf", {}), inTeam = pageFunction("inTeam", { teamsOf });
  const agents = [{ name: "Ada", tags: ["ops", "editorial"] }, { name: "Bob", tags: ["ops"] }, { name: "Vic", tags: [] }, { name: "Mia" }];
  const names = (rows: unknown) => (rows as { name: string }[]).map(row => row.name);
  assert.deepEqual(JSON.parse(JSON.stringify(teamsOf(agents))), ["editorial", "ops", "-"]);
  assert.deepEqual(JSON.parse(JSON.stringify(teamsOf([{ name: "Vic", tags: [] }]))), [], "no team, no control");
  assert.deepEqual(names(inTeam(agents, "ops")), ["Ada", "Bob"]);
  assert.deepEqual(names(inTeam(agents, "-")), ["Vic", "Mia"]);
  assert.deepEqual(names(inTeam(agents, "gone")), ["Ada", "Bob", "Vic", "Mia"], "a remembered team from another computer does not empty the list");
});

test("an activity event is a line saying who did what; a command in the audit record is shown as it was run", () => {
  const activityLine = pageFunction("activityLine", {}), auditLine = pageFunction("auditLine", {});
  const words = { you: "You", started: "started a turn", failed: "failed:", interrupted: "was interrupted", asked: "asked:", card: "showed a card:" };
  const line = (event: Record<string, unknown>) => JSON.parse(JSON.stringify(activityLine(event, "zh", (id: string) => (id === "a1" ? "Mia" : ""), words)));
  assert.deepEqual(line({ type: "tool_start", agentName: "Mia", tool: "read_file", phrase: { en: "is reading a file", zh: "正在读文件" } }), { who: "Mia", text: "正在读文件", tone: "" });
  assert.deepEqual(line({ type: "tool_start", agentName: "Mia", tool: "read_file" }), { who: "Mia", text: "→ read_file", tone: "" }, "an older event has no phrase");
  assert.deepEqual(line({ type: "turn_failed", agentId: "a1", error: "no key" }), { who: "Mia", text: "failed: no key", tone: "bad" });
  assert.equal(line({ type: "message_sent", agentId: "a1" }), null, "what passes between agents is not in the feed");
  assert.equal(auditLine({ type: "exec", detail: { user: "box", pwd: "/home/box/work", cmd: "npm test" } }), "box /home/box/work $ npm test");
  assert.equal(auditLine({ type: "window_focus", window: "Chromium — Billing" }), "Chromium — Billing");
});

test("a managed row says its state, where it came from and when it next acts, and nothing for what it does not have", () => {
  const words: Record<string, string> = { "ui.wg.running": "Running" };
  const manageWord = pageFunction("manageWord", { MSG: words, t: (key: string) => words[key] });
  const manageNote = pageFunction("manageNote", { manageWord });
  assert.equal(manageNote({ state: "waiting", source: "routine", condition: "paused by an admin" }), "waiting · routine · paused by an admin");
  assert.equal(manageNote({ state: "running", source: "" }), "Running", "a code the page has words for is said in them");
});

test("a file is shown in place as a picture or as text, and one that cannot be shown says so", () => {
  const previewKind = pageFunction("previewKind", {});
  assert.deepEqual(["chart.PNG", "notes.md", "data.jsonl", "report.pdf", "archive.tar.gz", "Makefile"].map(name => previewKind(name)), ["image", "text", "text", "other", "other", "text"]);
});

test("saving the model sends a key only when one was typed, clears what was emptied, and touches web search only when it changed", () => {
  const modelBody = pageFunction("modelBody", {});
  const form = { provider: "minimax", model: " MiniMax-M3 ", baseUrl: "https://x", key: "", vision: "auto", summaryModel: "", searchProvider: "brave", searchKey: "", searchWas: "brave" };
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(modelBody(form)), { provider: "minimax", model: "MiniMax-M3", baseUrl: null, vision: "auto", summaryModel: null }, "an address belongs to a custom provider only");
  assert.deepEqual(plain(modelBody({ ...form, provider: "custom", key: " k1 ", model: "" })), { provider: "custom", model: null, baseUrl: "https://x", vision: "auto", summaryModel: null, key: "k1" });
  assert.deepEqual(plain(modelBody({ ...form, searchProvider: "" })).searchProvider, "", "choosing no search service is sent, so the server clears it");
  assert.deepEqual(plain(modelBody({ ...form, searchKey: "s1" })), { provider: "minimax", model: "MiniMax-M3", baseUrl: null, vision: "auto", summaryModel: null, searchProvider: "brave", searchKey: "s1" });
});

test("a saved channel says what happens next: it is connecting, or it needs a restart", () => {
  const doorSaved = pageFunction("doorSaved", { t: (key: string) => key });
  assert.deepEqual([doorSaved({ started: true, restartNeeded: false }), doorSaved({ started: false, restartNeeded: true }), doorSaved({})], ["ui.next.doors.connecting", "ui.next.doors.restart", "ui.next.settings.saved2"]);
});

test("a role change sends the whole roster with one role changed; a limit left empty is no limit of its own, and nonsense is not sent", () => {
  const rosterWith = pageFunction("rosterWith", {}), limitValue = pageFunction("limitValue", {}), listOf = pageFunction("listOf", {});
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const people = [{ id: "p1", name: "Chris", role: "admin", identities: ["web:chris"], anchors: {} }, { id: "p2", name: "Dana", role: "viewer" }];
  assert.deepEqual(plain(rosterWith(people, "p2", "driver")), [{ id: "p1", name: "Chris", role: "admin", identities: ["web:chris"] }, { id: "p2", name: "Dana", role: "driver", identities: [] }]);
  assert.deepEqual([plain(limitValue("")), plain(limitValue(" 2.5 ")), plain(limitValue("0")), plain(limitValue("-1")), plain(limitValue("lots"))], [{ ok: true, value: null }, { ok: true, value: 2.5 }, { ok: true, value: 0 }, { ok: false }, { ok: false }]);
  assert.deepEqual(plain(listOf(" a, ,b ,")), ["a", "b"]);
});

test("an image is said to be current, ready, to be downloaded, or not this version's; a quota is a whole number from 0 to 99 or nothing", () => {
  const imageWord = pageFunction("imageWord", {}), quotaValue = pageFunction("quotaValue", {});
  assert.deepEqual([null, { runningId: "a", expectedId: "a", available: true }, { runningId: "a", expectedId: "b", available: true }, { runningId: "a", expectedId: "b", available: false, needsPull: true }, { runningId: "a", available: false }].map(state => imageWord(state)), ["unknown", "current", "ready", "pull", "behind"]);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(["", "3", "99", "100", "1.5", "-1", "two"].map(text => plain(quotaValue(text))), [{ ok: true, value: null }, { ok: true, value: 3 }, { ok: true, value: 99 }, { ok: false }, { ok: false }, { ok: false }, { ok: false }]);
});

test("a supervision run's ceilings are read strictly, and the desktop app's panes are offered only where its shell is", () => {
  const supervisionNumbers = pageFunction("supervisionNumbers", {});
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(supervisionNumbers({ maxMinutes: "30", maxModelCalls: "40", budget: "" })), { maxMinutes: 30, maxModelCalls: 40, budget: "" });
  assert.deepEqual([{ maxMinutes: "0", maxModelCalls: "40", budget: "" }, { maxMinutes: "30", maxModelCalls: "1.5", budget: "" }, { maxMinutes: "30", maxModelCalls: "40", budget: "-2" }].map(form => plain(supervisionNumbers(form)).bad), ["maxMinutes", "maxModelCalls", "budget"]);
  const panes = (shell: unknown) => plain(pageFunction("shellPanes", { appShell: () => shell ?? {} })());
  assert.deepEqual([panes(undefined), panes({ machine: {} }), panes({ machine: {}, organisations: {} })], [[], ["machine"], ["machine", "organisations"]]);
});

test("a computer that is not there says why in words a person can act on: no Docker, Docker stopped, or simply offline", () => {
  const why = (docker: unknown, own = "b1") => pageFunction("boxWhy", { boxes: { own, state: docker === undefined ? null : { docker } } })({ id: "b1" });
  assert.deepEqual([why({ state: "no-binary" }), why({ state: "no-engine" }), why(undefined), why({ state: "no-binary" }, "other")], ["missing", "stopped", "offline", "offline"]);
});

test("an agent's topics stay its own: a refresh keeps the older ones, a stale read gives way, search sees them in time order (INV-1896)", async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const pending: { url: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const getJson = (url: string) => new Promise((resolve, reject) => { pending.push({ url, resolve, reject }); });
  const row = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, lastAt: at, firstLine: `asked in ${id}`, ...extra });
  const chat = { agentId: "bob", conversation: "main", conversations: [] as { id: string }[], conversationsTotal: 0, topicsFor: "bob", topics: {} as Record<string, { entries?: unknown[] }>,
    topicExtra: [], topicAsked: 0, olderPending: false, focus: "", entries: [] as unknown[] };
  const globals = { chat, next: { view: "chat", agents: {} }, getJson, encodeURIComponent, render: () => {}, topicsOf: () => {}, topicsSeen: () => {}, postJson: () => Promise.resolve({}), refreshSoon: () => {}, failed: () => {} };

  const load = pageFunction("loadConversations", globals);
  chat.conversations = [row("main", "1"), row("t9", "2"), row("t8", "1")]; // t8 came from an older page the person asked for
  load("bob", 0);
  pending.shift()!.resolve({ conversations: [row("main", "3"), row("t10", "3"), row("t9", "2")], total: 40 });
  await settle();
  assert.deepEqual(chat.conversations.map(item => item.id), ["main", "t10", "t9", "t8"], "the newest page is refreshed and the older topic stays");
  load("bob", 4); load("bob", 4);
  assert.equal(pending.length, 1, "an older page is asked for once while it is on its way");
  pending.shift()!.resolve({ conversations: [row("t8", "1"), row("t7", "0")], total: 40 });
  await settle();
  assert.deepEqual(chat.conversations.map(item => item.id), ["main", "t10", "t9", "t8", "t7"], "and what it brings is added once");

  const open = pageFunction("openTopic", globals);
  open("t9", true); open("t9", true); // a turn ended while the first read was on its way
  const [first, second] = [pending.shift()!, pending.shift()!];
  second.resolve([{ kind: "text", role: "assistant", text: "after the turn" }]); await settle();
  first.resolve([{ kind: "text", role: "assistant", text: "before the turn" }]); await settle();
  assert.deepEqual(chat.topics.t9!.entries, [{ kind: "text", role: "assistant", text: "after the turn" }], "the older read does not overwrite the newer");
  chat.focus = "t7"; open("t7", true);
  pending.shift()!.reject(new Error("offline")); await settle();
  assert.equal(chat.focus, "", "a topic asked for by a link that cannot be read is not asked for again on its own");
  assert.equal(chat.topics.t7, undefined);

  const doorOf = pageFunction("doorOf", {}), marked = pageFunction("marked", {});
  const entries = pageFunction("conversationEntries", { chat, doorOf, marked, topicTime: pageFunction("topicTime", { String }) });
  chat.conversations = [row("main", "z"), row("feishu-room-t1", "2026-11-16T02:00:00Z", { lastReply: { text: "answered", at: "2026-11-16T02:00:00Z" } })];
  chat.topics = {};
  chat.entries = [{ kind: "text", role: "user", text: "early", at: "2026-11-16T01:00:00Z" }, { kind: "text", role: "user", text: "late", at: "2026-11-16T03:00:00Z" }];
  assert.deepEqual(JSON.parse(JSON.stringify((entries() as { text: string; source?: string }[]).map(entry => [entry.text, entry.source ?? null]))),
    [["early", null], ["asked in feishu-room-t1", "feishu"], ["answered", null], ["late", null]], "a topic stands at its time, marked with its chat");
});

test("the box update's backup is unticked unless the server says otherwise, and a tick is sent (INV-1906)", async () => {
  // 2026-11-17: the rebuilt page ticked it by default, against box-update.ts; an update spent two minutes and 1 GB copying volumes it never touches.
  interface Fake { tag: string; cls: string; text: string; kids: Fake[]; type?: string; checked?: boolean; className?: string; textContent?: string; press?: () => void; appendChild(kid: Fake): void; addEventListener(name: string, run: () => void): void }
  const el = (tag: string, cls = "", text = ""): Fake => {
    const node: Fake = { tag, cls, text, kids: [], appendChild(kid) { node.kids.push(kid); }, addEventListener(_name, run) { node.press = run; } };
    return node;
  };
  const all = (node: Fake): Fake[] => [node, ...node.kids.flatMap(all)];
  const posted: unknown[] = [];
  let boxSet: Record<string, unknown> = {};
  const draw = (image: Record<string, unknown>) => {
    boxSet.image = image; boxSet.confirming = boxSet.confirming ?? "";
    const imageBlock = pageFunction("imageBlock", {
      el, t: (key: string) => key, fact: (a: string, b: string) => el("div", "", a + b), imageWord: () => "available", boxSet,
      document: { createTextNode: (text: string) => el("#text", "", text) }, String, Date,
      postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); }, loadBoxSet: () => {}, failed: () => {}, render: () => {},
    });
    return all(imageBlock() as Fake);
  };
  const nodes = draw({ state: { runningRef: "fakechris/lumenbox:0.4.3", expectedRef: "fakechris/lumenbox:0.4.4" }, backupByDefault: false });
  const box = nodes.find(node => node.type === "checkbox")!;
  assert.ok(!nodes.some(node => node.text === "ui.next.boxset.available"), "no update notice without availability");
  const available = draw({ state: { available: true, needsPull: true }, backupByDefault: false });
  assert.ok(available.some(node => node.text === "ui.next.boxset.available"), "the available update is announced even if the image needs downloading");
  assert.ok(available.some(node => node.text === "ui.next.boxset.whenIdle"), "the announcement has an Apply update action in its section");
  assert.equal(box.checked, false, "unticked: an update leaves the volumes alone");
  assert.ok(nodes.some(node => node.text.includes("ui.next.boxset.backupWhy")), "the cost of ticking it is said beside it");
  box.checked = true; box.press!(); // the change event: the choice is kept by the page, not by this checkbox
  nodes.find(node => node.text === "ui.next.boxset.whenIdle")!.press!();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [["/api/box/image/update", { whenIdle: true, backup: true }]]);
  // "Update now" asks twice, through a redraw: the tick made before it is still there (Devin on #736).
  const redrawn = draw({ state: {}, backupByDefault: false });
  assert.equal(redrawn.find(node => node.type === "checkbox")!.checked, true, "the person's tick outlives the redraw");
  boxSet = {};
  assert.equal(draw({ state: {}, backupByDefault: true }).find(node => node.type === "checkbox")!.checked, true, "the server's default, whatever it is");
});

test("a request the agent wrote is the card: its title, its sentences, and the buttons that fit what is in the way", async () => {
  // INV-1923: "needs you" was one sentence per category and the same buttons whatever was in the way. The agent now writes
  // the card; what is in the way decides the buttons; and where it wrote nothing the note and the fixed sentence stand.
  const el = fakeEl, posted: [string, Record<string, unknown>][] = [], need: { refusing: string; previews: Record<string, unknown>; page: Record<string, string>; detached: string } = { refusing: "", previews: {}, page: {}, detached: "" };
  const t = (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : "");
  const rich = (text: string, cls: string) => el("div", cls, text), agentName = () => "Mia", panel = { taskId: "" };
  const postJson = (path: string, body: Record<string, unknown>) => { posted.push([path, body]); return Promise.resolve({}); };
  const press = async (node: Fake) => { node.press!(); await new Promise(resolve => setImmediate(resolve)); }; // and what follows the post has run
  const shared = { el, t, rich, need, agentName, panel, postJson, toast: () => {}, failed: () => {}, render: () => {}, refreshSoon: () => {}, loadPanel: () => {}, renderPanel: () => {}, encodeURIComponent };
  const askBlock = pageFunction("askBlock", { ...shared, ASK_ORDER: ASK_SENTENCES }), askBrief = pageFunction("askBrief", { ...shared, askProse });
  const receiptLine = pageFunction("receiptLine", { ...shared, clip: (text: string) => text, agoText: () => "3m", receiptWho: () => "on this page", openPanel: () => {} });
  const fileRow = pageFunction("fileRow", { ...shared, PREVIEW_KIND: { png: "image" } });
  const embedInto = pageFunction("embedInto", { ...shared, fileRow });
  const laterButton = pageFunction("laterButton", { ...shared, nextLaterTimes: nextLogic.nextLaterTimes });
  const sayNeed = pageFunction("sayNeed", shared);
  const needActs = pageFunction("needActs", { ...shared, nextNeedOf: nextLogic.nextNeedOf, laterButton, sayNeed });
  const needInto = pageFunction("needInto", { ...shared, nextNeedOf: nextLogic.nextNeedOf, askBlock, askBrief, receiptLine, embedInto, needActs });
  const needCard = pageFunction("needCard", { ...shared, needInto, openPanel: () => {} }) as (row: unknown) => Fake;
  const sent = (): [string, Record<string, unknown>] => JSON.parse(JSON.stringify(posted.pop())); // the page's own objects, as plain ones
  const buttons = (card: Fake) => card.kids.find(kid => kid.cls === "acts")!.kids;
  const base = { assigneeId: "mia", conversation: "feishu-1", status: "blocked", updatedAt: "2026-11-19T10:00:00.000Z", reading: { phase: "needs" } };
  const note = "Please do: Sign in to the vendor portal and download the October invoice\nWhat happened: Reconciliation stopped at step 3.\nWhy you: The code goes to your phone.\nHow: Open https://vendor.example/login and drop the PDF in inbox/.\nMeanwhile: Reconciling September.\nStill yours to check: The invoice header.";

  // Something only the person can do elsewhere.
  const act = { ...base, id: "t1", title: "Reconcile October", ask: splitAsk(note).ask, deliverables: [{ id: "d1", name: "step-3.png" }, { id: "d2", name: "ledger.xlsx" }], reading: { phase: "needs", checks: { result: "failed" }, evidence: ["vendor portal: 403 after login"] } };
  assert.equal(nextLogic.nextNeedOf(act), "act");
  const acting = needCard(act);
  assert.equal(acting.kids[0]!.text, "Sign in to the vendor portal and download the October invoice", "the title is the action, in the agent's words");
  assert.equal(acting.kids[1]!.text, "Reconcile October", "and which work it is about is one press away");
  // The default level is what to know or decide: the sentences as one paragraph without the names the agent wrote them
  // under, what stays the person's to check set apart, the files as one row of names, the buttons. Nothing under the buttons.
  assert.equal(acting.kids.find(kid => kid.cls === "said")!.text, "Reconciliation stopped at step 3. The code goes to your phone. Open https://vendor.example/login and drop the PDF in inbox/. Meanwhile: Reconciling September.", "one running paragraph, what it keeps doing included");
  assert.deepEqual(acting.kids.find(kid => kid.cls === "yours")!.kids.map(kid => kid.text), ["ui.next.ask.unverified", "The invoice header."], "what stays yours to check is not folded into it");
  assert.ok(!acting.kids.some(kid => kid.cls === "parts"), "no label over each sentence on the card");
  const strip = acting.kids.find(kid => kid.cls === "embeds")!.kids[0]!.kids;
  assert.deepEqual(strip.map(kid => [kid.text, kid.cls === "chip-file" ? kid.attrs["aria-expanded"] ?? "download" : "said"]), [["step-3.png", "false"], ["ledger.xlsx", "download"], ["ui.next.need.check.failed", "said"]], "a picture opens where it stands, a sheet is downloaded, and the check's conclusion closes the row");
  assert.deepEqual(acting.kids.slice(-2).map(kid => kid.cls), ["acts", "why"], "the card ends at its buttons and one line saying what each leads to");
  assert.equal(acting.kids.at(-1)!.text, "ui.next.need.hint.act(Mia) ui.next.need.hint.later", "what pressing does is read, not hovered for");
  assert.deepEqual(buttons(acting).map(kid => kid.text), ["ui.next.need.done", "ui.next.need.skip", "ui.next.act.snooze"]);
  // The work's panel is where the breakdown is: the same sentences under their names, by the same code.
  const inPanel = el("div"); needInto(inPanel, act, true);
  assert.deepEqual(inPanel.kids.find(kid => kid.cls === "parts")!.kids.map(kid => kid.dataset.part), [...ASK_SENTENCES], "what happened, why you, how, meanwhile, and what stays yours to check");
  // A press is written on the work it answers: one write, which the host tells the agent (person-word.ts). It need not say what it is about.
  await press(buttons(acting)[0]!);
  assert.deepEqual(sent(), ["/api/tasks/update", { id: "t1", note: "ui.next.need.say.done" }]);
  // Answered, and until the agent moves: one line in place of the request and its buttons, which opens the work.
  const settled = el("div"); needInto(settled, { ...act, receipt: { what: "answered", title: act.ask!.title, by: "web", at: "2026-11-19T10:05:00.000Z", text: "I've done it." } }, true);
  assert.deepEqual([settled.kids.length, settled.kids[0]!.cls, settled.kids[0]!.kids.map(kid => kid.text).join(" ")], [1, "receipt", `✓ ui.next.receipt.answered(${act.ask!.title})ui.next.receipt.said(I've done it.) on this page · 3m`]);
  await press(buttons(needCard(act))[1]!);
  assert.equal(sent()[1].note, "ui.next.need.say.skip");

  // A go-ahead: the two outcomes in the agent's words, and a refusal that may say why.
  const release = { ...base, id: "t2", title: "Renewal notices", ask: splitAsk("Please approve: Send the renewal notice to 214 customers\nWhy you: It goes out under your name.").ask, history: [{ options: ["Send it", "Don't send"] }] };
  assert.equal(nextLogic.nextNeedOf(release), "release");
  assert.deepEqual(buttons(needCard(release)).map(kid => kid.text), ["Send it", "Don't send", "ui.next.act.snooze"], "the buttons say what will happen");
  await press(buttons(needCard(release))[1]!);
  assert.equal(need.refusing, "t2");
  const refusing = needCard(release), why = refusing.kids.find(kid => kid.placeholder === "ui.next.need.whyNot")!;
  await press(buttons(refusing)[0]!);
  assert.deepEqual(sent(), ["/api/tasks/update", { id: "t2", note: "Don't send" }], "refused without a reason");
  need.refusing = "t2"; why.value = "the price list is not final";
  await press(buttons(refusing)[0]!);
  assert.equal(sent()[1].note, "Don't sendui.next.need.say.reason(the price list is not final)", "the reason goes with the refusal");
  const plain = { ...release, history: [{}] };
  assert.deepEqual(buttons(needCard(plain)).map(kid => kid.text), ["ui.next.act.approve", "ui.next.act.deny", "ui.next.act.snooze"], "no outcomes named: the plain pair");
  await press(buttons(needCard(plain))[0]!);
  assert.equal(sent()[1].note, "ui.next.act.approve");

  // Nothing written by the agent: its note, or the fixed sentence, and the answers it offered, as before.
  const silent = { ...base, id: "t3", title: "Pick a region", history: [{ note: "Which region should the bucket live in?", options: ["eu-west-1", "us-east-1"] }] };
  assert.equal(nextLogic.nextNeedOf(silent), "answer");
  const fallback = needCard(silent);
  assert.equal(fallback.kids[0]!.text, "ui.next.need.head(Mia)");
  assert.ok(fallback.kids.some(kid => kid.text === "Which region should the bucket live in?"), "the note as it was written");
  assert.ok(needCard({ ...silent, history: [{ options: ["eu-west-1"] }] }).kids.some(kid => kid.text === "ui.wr.reason.needs"), "and with no note, the fixed sentence");
  assert.deepEqual(buttons(fallback).map(kid => kid.text), ["eu-west-1", "us-east-1", "ui.next.act.snooze"]);
  await press(buttons(fallback)[1]!);
  assert.equal(sent()[1].note, "us-east-1", "an answer is said as it reads");

  // What decides the family, and what is not a request at all.
  assert.equal(nextLogic.nextNeedOf({ status: "review", reading: { phase: "review" }, ask: { kind: "approve" } }), "delivery", "a result to look at keeps confirm and send back, whatever its title was named");
  assert.equal(nextLogic.nextNeedOf({ status: "blocked", reading: { phase: "needs" }, history: [{}] }), undefined, "work parked by a failure has nothing to press");
  assert.equal(nextLogic.nextNeedOf({ status: "doing", reading: { phase: "working" }, ask: { kind: "act" } }), undefined);

  // "Later" is a few ready times, and the one pressed is when the work is asked about again.
  const later = buttons(needCard(silent)).at(-1)!;
  await press(later);
  const times = later.swapped!.kids;
  assert.ok(times.length >= 2 && times.every(kid => kid.text.startsWith("ui.next.later.")));
  await press(times.at(-1)!);
  const [path, body] = sent();
  assert.deepEqual([path, body.id, new Date(String(body.snoozeUntil)).getDay(), new Date(String(body.snoozeUntil)).getHours()], ["/api/tasks/update", "t3", 1, 9], "next Monday, nine in the morning");
  const friday = nextLogic.nextLaterTimes(new Date(2026, 10, 20, 10, 0)), sundayNight = nextLogic.nextLaterTimes(new Date(2026, 10, 22, 21, 0));
  assert.deepEqual(friday.map(time => [time.key, new Date(time.at).getDate(), new Date(time.at).getHours()]), [["tonight", 20, 18], ["tomorrow", 21, 9], ["monday", 23, 9]]);
  assert.deepEqual(sundayNight.map(time => [time.key, new Date(time.at).getDate()]), [["tomorrow", 23], ["monday", 30]], "no evening left, and tomorrow is not offered twice");

  // Several things waiting from one agent are one entry above its conversation, turned through one at a time: not a card each.
  const result = { id: "t0", assigneeId: "mia", conversation: "feishu-1", status: "review", updatedAt: "2026-11-19T09:00:00.000Z", reading: { phase: "review" }, title: "Export" };
  const elsewhere = { ...act, id: "t8", conversation: "main" }, answered = { ...release, id: "t9", receipt: { what: "answered", title: "Renewal", by: "web", at: "2026-11-19T10:30:00.000Z", text: "Send it" } };
  const page = { rows: [release, act, result, elsewhere, answered, { ...silent, snoozeUntil: "2999-01-01T00:00:00.000Z" }] as Record<string, unknown>[], agents: { mia: { id: "mia", name: "Mia" } }, view: "chat" };
  const talk = { agentId: "mia", conversation: "feishu-1", find: "" }, held = [el("div", "card-need", "consent")];
  const putOff = pageFunction("putOff", {}), world = { ...shared, next: page, chat: talk, nextNeedOf: nextLogic.nextNeedOf, putOff, pendingCards: () => held };
  const waitsOnPerson = pageFunction("waitsOnPerson", world), waitsHere = pageFunction("waitsHere", { ...world, waitsOnPerson }), dockEntries = pageFunction("dockEntries", { ...world, waitsHere }), dockShown = pageFunction("dockShown", { ...world, dockEntries });
  const needDock = pageFunction("needDock", { ...world, dockShown, needCard, resultCard: (row: { id: string }) => el("div", "card-plain", row.id) }) as (agent: unknown) => Fake | null;
  const first = needDock(page.agents.mia)!;
  assert.deepEqual([first.dataset.dock, first.kids[0]!.kids[0]!.text], ["t0", "ui.next.need.page(1|4)"], "longest-waiting first, and it says how many: the result, two requests and a consent it holds; not the one put off, the one answered, or another conversation's");
  assert.equal(first.kids.length, 2, "one card on show");
  assert.equal(first.kids[0]!.kids[2]!.text, "ui.next.need.next(2|4) ›", "the way to the next one is a button that says where it goes, not a bare arrow");
  await press(first.kids[0]!.kids[2]!);
  assert.equal(needDock(page.agents.mia)!.dataset.dock, "t2", "the next one, in the same place");
  page.rows = page.rows.filter(row => row.id !== "t0"); // the result was settled meanwhile
  assert.deepEqual([needDock(page.agents.mia)!.dataset.dock, needDock(page.agents.mia)!.kids[0]!.kids[0]!.text], ["t2", "ui.next.need.page(1|3)"], "the entry is redrawn in place: still on what the person was reading");
  page.rows = [act]; held.length = 0;
  assert.equal(needDock(page.agents.mia)!.kids.length, 1, "one thing waiting needs no paging");
  // A reply typed while a card is on show is that card's: written on the work, unless the person detaches it.
  const replyTarget = pageFunction("replyTarget", { ...world, dockShown });
  const sendReply = pageFunction("sendReply", { ...world, replyTarget, sayNeed });
  assert.equal((replyTarget() as { id: string }).id, "t1");
  await sendReply("The PDF is in inbox/.");
  assert.deepEqual(sent(), ["/api/tasks/update", { id: "t1", note: "The PDF is in inbox/." }]);
  need.detached = "t1";
  assert.deepEqual([replyTarget(), sendReply("unrelated")], [null, null], "detached: an ordinary message");
  need.detached = ""; page.rows = [];
  assert.deepEqual([needDock(page.agents.mia), sendReply("hello")], [null, null], "nothing waiting: nothing above the conversation, and a message is a message");
  // What was settled is one line among what was said, by time; a day later it is history.
  const fresh = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  page.rows = [{ ...answered, id: "t9", receipt: { ...answered.receipt, at: fresh(30) } }, { ...answered, id: "t10", receipt: { ...answered.receipt, what: "returned", at: fresh(5) } }, { ...answered, id: "t11", receipt: { ...answered.receipt, at: fresh(60 * 30) } }];
  const among = (pageFunction("receiptsAmong", { ...world, receiptLine, RECEIPT_KEEP: 86_400_000 }) as () => { before(entry: unknown): Fake[]; rest(): Fake[] })();
  assert.deepEqual([among.before({ at: fresh(40) }).length, [...among.before({ at: fresh(10) })].map(line => line.dataset.receipt), [...among.rest()].map(line => line.kids[0]!.text)], [0, ["t9"], ["↩"]]);

  // The page names a sentence by the word the agent is asked to write it under.
  const { MESSAGES } = await import("../i18n/messages.ts");
  for (const key of ASK_SENTENCES) for (const locale of ["zh", "en"] as const) assert.equal(MESSAGES[locale][`ui.next.ask.${key}`], askLabel(key, locale), key);
});

test("a row's one line: what the member asks of the person, else what it says it is doing, else the fixed words (INV-1926)", async () => {
  // The row read "Working", a job title, or a category from a table ("Linked execution is advancing this work").
  const t = (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : "");
  const { MESSAGES } = await import("../i18n/messages.ts");
  const MSG = MESSAGES.en, page: { rows: Record<string, unknown>[]; mine: unknown[]; agents: Record<string, unknown> } = { rows: [], mine: [], agents: {} };
  const base = { t, MSG, next: page, putOff: pageFunction("putOff", {}), nextNeedOf: nextLogic.nextNeedOf, nextStateOf: nextLogic.nextStateOf, NOW_FRESH_MS: 15 * 60_000, owedText: () => "" };
  const waitsOnPerson = pageFunction("waitsOnPerson", base), askLine = pageFunction("askLine", base), nowLine = pageFunction("nowLine", base);
  const memberLine = pageFunction("memberLine", { ...base, waitsOnPerson, askLine, nowLine }), reasonOf = pageFunction("reasonOf", { ...base, nowOnRow: pageFunction("nowOnRow", { ...base, nowLine }) });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString(), said = "Matching the October statement against the ledger";
  const mia = { id: "mia", name: "Mia", title: "Operations", running: true, facts: { unreadCount: 0, now: { text: said, at: ago(2), conversation: "main", taskId: "t1" } as Record<string, unknown> } };
  const working = { id: "t1", assigneeId: "mia", conversation: "main", status: "doing", title: "Reconcile October", updatedAt: ago(30), reading: { phase: "working", reason: "working" } };
  const other = { ...working, id: "t5", title: "Renewal notices" };
  page.agents = { mia }; page.rows = [working, other];
  // Working, and it said what on: its words, on the row of the work its turn is on and nowhere else.
  assert.deepEqual([memberLine(mia), reasonOf(working), reasonOf(other)], [said, said, "ui.next.line.reason.working"]);
  // It needs the person: what it asks comes first, on its row and on the work.
  const asking = { ...working, id: "t2", status: "blocked", updatedAt: ago(10), reading: { phase: "needs", reason: "needs" }, ask: splitAsk("Please do: Sign in to the vendor portal\nWhy you: The code goes to your phone.").ask };
  page.rows = [working, other, asking];
  assert.deepEqual([memberLine(mia), reasonOf(asking)], ["Sign in to the vendor portal", "Sign in to the vendor portal"]);
  page.rows = [working, other, { ...asking, snoozeUntil: "2999-01-01T00:00:00.000Z" }];
  assert.equal(memberLine(mia), said, "put off: it asks nothing until then");
  page.rows = [{ ...working, id: "t3", status: "review", reading: { phase: "review", reason: "review" } }];
  assert.equal(memberLine(mia), "ui.next.line.reason.review", "a result with no title of its own: delivered, waiting for you to confirm");
  // Stale: words written twenty minutes ago are not what it is doing now; an idle member has no words from the server at all.
  page.rows = [working, other]; mia.facts.now.at = ago(20);
  assert.deepEqual([memberLine(mia), reasonOf(working)], ["ui.next.agent.working", "ui.next.line.reason.working"]);
  assert.equal(memberLine({ ...mia, running: false, facts: { unreadCount: 0 } }), "Operations", "idle and asking nothing: as it was");
  // Words with no work named go on the one piece it is doing in that conversation, and are not guessed between two.
  mia.facts.now = { text: "Drafting the notice", at: ago(1), conversation: "main" };
  page.rows = [working];
  assert.equal(reasonOf(working), "Drafting the notice");
  page.rows = [working, other];
  assert.equal(reasonOf(working), "ui.next.line.reason.working");
  // The fixed words say where it is stuck; a gate's own description is not the row's line, a question is.
  assert.equal(reasonOf({ ...other, status: "blocked", reading: { phase: "waiting", reason: "waiting", blocker: { kind: "dependency", tools: [] } } }), "ui.next.line.blocker.dependency");
  const idle = (awaiting: unknown) => memberLine({ ...mia, running: false, facts: { unreadCount: 0, awaiting } });
  assert.deepEqual([idle({ kind: "question", reason: "Which region?" }), idle({ kind: "approval", reason: "bash: rm -rf build" })], ["Which region?", "ui.next.line.await.approval"]);
  // One line, the whole of it on hover.
  const long = "x".repeat(300), node = pageFunction("lineNode", { el: fakeEl })("why", long) as Fake & { title?: string };
  assert.deepEqual([node.cls, node.text.length, node.title], ["why", 300, long]);
  // Every fixed word is in both languages, and none of them is the bookkeeping the table used to say.
  const keys = Object.keys(MESSAGES.en).filter(key => key.startsWith("ui.next.line."));
  assert.ok(keys.length > 20);
  for (const key of keys) {
    assert.ok(MESSAGES.zh[key] && MESSAGES.zh[key] !== MESSAGES.en[key], `${key} in Chinese`);
    assert.doesNotMatch(MESSAGES.en[key]!, /execution|linked|retained|authori[sz]ed|scope/i, key);
  }
});

test("a reload stays on the computer and agent the person was on, and a new sign-in comes back to them (INV-2064)", () => {
  const stored = new Map<string, string>();
  const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  const location = { href: "http://box/?ui=next&view=work" };
  const history = { replaceState: (_s: unknown, _t: string, url: URL) => { location.href = String(url); } };
  const body = { dataset: {} as Record<string, string> };
  const globals = (chat: Record<string, unknown>, view = "chat") => ({ PLACE_KEY: "lumen-place", next: { view }, chat, localStorage, location, history, document: { body }, JSON, URL });
  body.dataset.open = "1";
  pageFunction("rememberPlace", globals({ box: "shared", agentId: "ada" }))();
  assert.equal(location.href, "http://box/?ui=next&view=work&agent=ada", "an open conversation is named in the address; the rest of the address stays");
  pageFunction("rememberPlace", globals({ box: "mine", agentId: "aria" }, "work"))();
  assert.equal(location.href, "http://box/?ui=next&view=work&agent=ada", "another view keeps its own address and does not move the place");
  delete body.dataset.open;
  pageFunction("rememberPlace", globals({ box: "shared", agentId: "ada" }))();
  assert.equal(location.href, "http://box/?ui=next&view=work", "a narrow screen showing the list is not in the conversation, so Back does not reopen it");
  const signedInAgain = { box: "", agentId: "" };
  pageFunction("recallPlace", globals(signedInAgain))();
  assert.deepEqual(signedInAgain, { box: "shared", agentId: "ada" }, "with no address, the remembered computer and agent are where the page opens");
  assert.equal(body.dataset.open, undefined, "chosen, not opened: a narrow screen still lands on the list");
  pageFunction("rememberPlace", globals({ box: "mine", agentId: "" }))();
  const fresh = { box: "", agentId: "" };
  pageFunction("recallPlace", globals(fresh))();
  assert.deepEqual(fresh, { box: "mine", agentId: "" }, "a computer chosen with no agent on it is a place too");
});

test("a viewer's composer says they can watch and not act, and takes nothing; nobody else's is shut (INV-2047)", async () => {
  const nodes: Record<string, { textContent: string; hidden: boolean; disabled: boolean }> = {
    "composer-watch": { textContent: "", hidden: true, disabled: false },
    "composer-text": { textContent: "", hidden: false, disabled: false },
    "composer-send": { textContent: "", hidden: false, disabled: false },
  };
  const settings: { me: null | { role?: string } } = { me: null };
  const watchOnly = pageFunction("watchOnly", { settings }) as () => boolean;
  const draw = pageFunction("renderWatchOnly", { $: (id: string) => nodes[id], t: (key: string) => key, watchOnly });
  const canSend = pageFunction("composerCanSend", { watchOnly, refreshModelReadiness: () => Promise.resolve(true) }) as () => Promise<boolean>;
  draw();
  assert.equal(nodes["composer-text"]!.disabled, false, "while the role is not yet known, nothing is shut");
  settings.me = { role: "viewer" };
  draw();
  assert.deepEqual([nodes["composer-text"]!.disabled, nodes["composer-send"]!.disabled, nodes["composer-watch"]!.hidden, nodes["composer-watch"]!.textContent],
    [true, true, false, "ui.next.composer.watchOnly"], "a viewer is told before typing, not after sending");
  assert.equal(await canSend(), false, "and nothing a viewer typed is sent to be refused");
  settings.me = { role: "driver" };
  draw();
  assert.deepEqual([nodes["composer-text"]!.disabled, nodes["composer-watch"]!.hidden], [false, true], "made a driver, the composer opens");
  assert.equal(await canSend(), true);
});

test("the work panel's foot says what a person can decide, as buttons that say what they lead to; there is no status to pick (INV-2189)", () => {
  // A status picker (open, doing, blocked, review, done, dropped) was the panel's way to decide, and nobody knew why they would use it.
  const changes: Record<string, unknown>[] = [];
  const stopBlock = pageFunction("stopBlock", {
    el: fakeEl, t: (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : ""), agentName: () => "Mia", encodeURIComponent, Date,
    updateTask: (change: Record<string, unknown>) => changes.push(change), nextLaterTimes: nextLogic.nextLaterTimes, nextNeedOf: nextLogic.nextNeedOf, getJson: () => new Promise(() => {}), postJson: () => Promise.resolve({}),
  }) as (task: unknown) => Fake;
  const foot = stopBlock({ id: "t1", status: "blocked", assigneeId: "mia", conversation: "main" });
  const acts = foot.kids.find(kid => kid.cls === "acts")!;
  assert.deepEqual(acts.kids.map(kid => [kid.text, kid.cls]), [["ui.next.act.markDone", "act"], ["ui.next.act.snooze", "act"], ["ui.next.act.stop", "act-danger"]]);
  assert.equal(foot.kids.find(kid => kid.cls === "why")!.text, "ui.next.panel.footHint(Mia)", "and one line says what each leads to");
  acts.kids[0]!.press!();
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ status: "done" }], "the person's word that it is finished");
  const asking = stopBlock({ id: "t4", status: "blocked", assigneeId: "mia", ask: { kind: "do" } }).kids.find(kid => kid.cls === "acts")!;
  assert.deepEqual(asking.kids.map(kid => kid.text), ["ui.next.act.markDone", "ui.next.act.stop"], "put off is offered once, by the request above");
  const review = stopBlock({ id: "t2", status: "review", assigneeId: "mia" }).kids.find(kid => kid.cls === "acts")!;
  assert.ok(!review.kids.some(kid => kid.text === "ui.next.act.markDone"), "a delivered result is confirmed on its own card");
  assert.deepEqual(stopBlock({ id: "t3", status: "done", assigneeId: "mia" }).kids.map(kid => kid.cls), ["foot-links"], "finished work has only its links");
});
