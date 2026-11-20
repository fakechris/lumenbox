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
import { ASK_SENTENCES, askLabel, splitAsk } from "../host/person-ask.ts";

/** The inline scripts of a page, in order. */
const pageScripts = (page: string): string[] => [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);

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
  const need = { answered: {}, refusing: "", previews: {} };
  const fileRow = pageFunction("fileRow", { el, t, need, encodeURIComponent, PREVIEW_KIND: { md: "text" }, failed: () => {} });
  const embedInto = pageFunction("embedInto", { el, t, need, fileRow });
  const laterButton = pageFunction("laterButton", { el, t, nextLaterTimes: nextLogic.nextLaterTimes, postJson: () => Promise.resolve({}), toast: () => {}, failed: () => {} });
  const askBlock = pageFunction("askBlock", { el, t, rich, ASK_ORDER: ASK_SENTENCES });
  const resultCard = pageFunction("resultCard", {
    embedInto, laterButton, askBlock,
    reportBlock, REPORT_BRIEF: DELIVERY_BRIEF, el, t, agentName, originOf, chat, signOffLines, agoText: () => "3d", rich, toast: () => {}, refreshSoon: () => {}, failed: () => {}, encodeURIComponent,
    render: () => {}, document: { querySelector: () => null },
    openPanel: (id: string) => opened.push(id), postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); },
  });
  const row = { id: "t1", title: "October report", assigneeId: "mia", requester: "feishu:ou_1", createdAt: "2026-11-01T00:00:00.000Z", deliverables: files, report: { at: "2026-11-02T00:00:00.000Z", by: "ada", note: "Checked: **cannot be accepted as is**." }, signOffBecause: ["files", "remarked"] };
  const card = resultCard(row) as Fake;
  assert.ok(card.kids.some(kid => kid.text === "ui.next.origin.feishu · 3d"), "where the request came from");
  assert.deepEqual(card.kids.filter(kid => kid.text.startsWith("ui.next.because.")).map(kid => kid.text), ["ui.next.because.files6", "ui.next.because.remarked"], "why it waits for the person (INV-1904)");
  assert.ok(card.kids.some(kid => kid.cls === "report" && kid.text.includes("cannot be accepted")), "what was reported is on the card");
  assert.equal(card.kids.filter(kid => kid.cls === "file").length, 4);
  assert.ok(card.kids.some(kid => kid.text === "ui.next.chat.moreFiles2"), "the rest are counted, not listed");
  assert.equal(card.kids.at(-1)!.text, "ui.next.chat.reviewHint(Mia)", "the buttons are explained");
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
  // INV-1923: where the agent wrote what it needs, that is the card's title and its first sentences; where it did not,
  // the fixed line stands, as above. The buttons of a result to look at are the same either way, with "later" beside them.
  assert.equal(card.kids[0]!.text, "ui.next.chat.review", "nothing written: the fixed line");
  const asked = resultCard({ ...row, ask: { kind: "check", title: "Check the DST branch before it ships", said: [{ key: "meanwhile", text: "Fixing the same bug on import." }] } }) as Fake;
  assert.equal(asked.kids[0]!.text, "Check the DST branch before it ships", "the agent's own title");
  assert.deepEqual(asked.kids.find(kid => kid.cls === "parts")!.kids.map(kid => [kid.dataset.part, kid.kids.map(inner => inner.text).join(" | ")]), [["meanwhile", "ui.next.ask.meanwhile | Fixing the same bug on import."]]);
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
  const inboxRow = pageFunction("inboxRow", {
    el, t: (key: string) => key, owedText: () => "", initial: () => "A", isTask: () => true, openPanel: () => {}, openChat: () => {}, failed: () => {}, settle: () => {},
    postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); },
  });
  const buttons = (kind: string) => (inboxRow({ kind, ref: "r1", title: "x" }) as Fake).kids.slice(1).flatMap(kid => kid.kids);
  buttons("outbox")[0]!.press!(); buttons("close-proposal")[0]!.press!();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [["/api/outbox/decide", { id: "r1", decision: "approve" }], ["/api/tasks/oppose-close", { id: "r1" }]]);
  assert.equal(buttons("review").length, 0, "a row with nothing to decide on it has no buttons");
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
  const el = fakeEl, posted: [string, Record<string, unknown>][] = [], need: { answered: Record<string, unknown>; refusing: string; previews: Record<string, unknown> } = { answered: {}, refusing: "", previews: {} };
  const t = (key: string, values?: Record<string, unknown>) => key + (values ? `(${Object.values(values).join("|")})` : "");
  const rich = (text: string, cls: string) => el("div", cls, text), agentName = () => "Mia", panel = { taskId: "" };
  const postJson = (path: string, body: Record<string, unknown>) => { posted.push([path, body]); return Promise.resolve({}); };
  const press = async (node: Fake) => { node.press!(); await new Promise(resolve => setImmediate(resolve)); }; // and what follows the post has run
  const shared = { el, t, rich, need, agentName, panel, postJson, toast: () => {}, failed: () => {}, render: () => {}, refreshSoon: () => {}, loadPanel: () => {}, renderPanel: () => {}, encodeURIComponent };
  const askBlock = pageFunction("askBlock", { ...shared, ASK_ORDER: ASK_SENTENCES });
  const fileRow = pageFunction("fileRow", { ...shared, PREVIEW_KIND: { png: "image" } });
  const embedInto = pageFunction("embedInto", { ...shared, fileRow });
  const laterButton = pageFunction("laterButton", { ...shared, nextLaterTimes: nextLogic.nextLaterTimes });
  const sayNeed = pageFunction("sayNeed", shared);
  const needInto = pageFunction("needInto", { ...shared, nextNeedOf: nextLogic.nextNeedOf, askBlock, embedInto, laterButton, sayNeed });
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
  assert.deepEqual(acting.kids.find(kid => kid.cls === "parts")!.kids.map(kid => kid.dataset.part), [...ASK_SENTENCES], "what happened, why you, how, meanwhile, and what stays yours to check");
  assert.ok(acting.kids.find(kid => kid.cls === "parts")!.kids[3]!.kids.some(kid => kid.text === "Reconciling September."), "what it keeps doing is on the card");
  assert.deepEqual(acting.kids.filter(kid => kid.cls === "file").map(kid => [kid.text, kid.attrs["aria-expanded"] ?? "download"]), [["step-3.png", "false"], ["ledger.xlsx", "download"]], "a picture opens where it stands; a sheet is downloaded");
  assert.ok(acting.kids.some(kid => kid.text === "ui.next.need.check.failed") && acting.kids.some(kid => kid.text === "vendor portal: 403 after login"), "the check's conclusion and the evidence named");
  assert.deepEqual(buttons(acting).map(kid => kid.text), ["ui.next.need.done", "ui.next.need.skip", "ui.next.act.snooze"]);
  await press(buttons(acting)[0]!);
  assert.deepEqual(sent(), ["/api/prompt", { agent: "mia", conversation: "feishu-1", text: "ui.next.need.say.done(Sign in to the vendor portal and download the October invoice)" }], "said to the agent, in the conversation the work belongs to");
  const settled = needCard(act);
  assert.ok(!settled.kids.some(kid => kid.cls === "acts") && settled.kids.at(-1)!.text.startsWith("ui.next.need.said("), "answered: what was said stands in place of the buttons");
  assert.ok(needCard({ ...act, updatedAt: "2026-11-19T11:00:00.000Z" }).kids.some(kid => kid.cls === "acts"), "until the agent moves; a new request is asked afresh");
  need.answered = {};
  await press(buttons(needCard(act))[1]!);
  assert.match(String(sent()[1].text), /^ui\.next\.need\.say\.skip\(/);
  need.answered = {};

  // A go-ahead: the two outcomes in the agent's words, and a refusal that may say why.
  const release = { ...base, id: "t2", title: "Renewal notices", ask: splitAsk("Please approve: Send the renewal notice to 214 customers\nWhy you: It goes out under your name.").ask, history: [{ options: ["Send it", "Don't send"] }] };
  assert.equal(nextLogic.nextNeedOf(release), "release");
  assert.deepEqual(buttons(needCard(release)).map(kid => kid.text), ["Send it", "Don't send", "ui.next.act.snooze"], "the buttons say what will happen");
  await press(buttons(needCard(release))[1]!);
  assert.equal(need.refusing, "t2");
  const refusing = needCard(release), why = refusing.kids.find(kid => kid.placeholder === "ui.next.need.whyNot")!;
  await press(buttons(refusing)[0]!);
  assert.deepEqual(sent()[1].text, "ui.next.need.say.choice(Don't send|Send the renewal notice to 214 customers)", "refused without a reason");
  need.answered = {}; need.refusing = "t2"; why.value = "the price list is not final";
  await press(buttons(refusing)[0]!);
  assert.equal(sent()[1].text, "ui.next.need.say.choice(Don't send|Send the renewal notice to 214 customers) ui.next.need.say.reason(the price list is not final)", "the reason goes with the refusal");
  need.answered = {};
  const plain = { ...release, history: [{}] };
  assert.deepEqual(buttons(needCard(plain)).map(kid => kid.text), ["ui.next.act.approve", "ui.next.act.deny", "ui.next.act.snooze"], "no outcomes named: the plain pair");
  await press(buttons(needCard(plain))[0]!);
  assert.equal(sent()[1].text, "ui.next.need.say.choice(ui.next.act.approve|Send the renewal notice to 214 customers)");
  need.answered = {};

  // Nothing written by the agent: its note, or the fixed sentence, and the answers it offered, as before.
  const silent = { ...base, id: "t3", title: "Pick a region", history: [{ note: "Which region should the bucket live in?", options: ["eu-west-1", "us-east-1"] }] };
  assert.equal(nextLogic.nextNeedOf(silent), "answer");
  const fallback = needCard(silent);
  assert.equal(fallback.kids[0]!.text, "ui.next.need.head(Mia)");
  assert.ok(fallback.kids.some(kid => kid.text === "Which region should the bucket live in?"), "the note as it was written");
  assert.ok(needCard({ ...silent, history: [{ options: ["eu-west-1"] }] }).kids.some(kid => kid.text === "ui.wr.reason.needs"), "and with no note, the fixed sentence");
  assert.deepEqual(buttons(fallback).map(kid => kid.text), ["eu-west-1", "us-east-1", "ui.next.act.snooze"]);
  await press(buttons(fallback)[1]!);
  assert.equal(sent()[1].text, "us-east-1", "an answer is said as it reads");

  // What decides the family, and what is not a request at all.
  assert.equal(nextLogic.nextNeedOf({ status: "review", reading: { phase: "review" }, ask: { kind: "approve" } }), "delivery", "a result to look at keeps confirm and send back, whatever its title was named");
  assert.equal(nextLogic.nextNeedOf({ status: "blocked", reading: { phase: "needs" }, history: [{}] }), undefined, "work parked by a failure has nothing to press");
  assert.equal(nextLogic.nextNeedOf({ status: "doing", reading: { phase: "working" }, ask: { kind: "act" } }), undefined);

  // "Later" is a few ready times, and the one pressed is when the work is asked about again.
  need.answered = {};
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

  // The page names a sentence by the word the agent is asked to write it under.
  const { MESSAGES } = await import("../i18n/messages.ts");
  for (const key of ASK_SENTENCES) for (const locale of ["zh", "en"] as const) assert.equal(MESSAGES[locale][`ui.next.ask.${key}`], askLabel(key, locale), key);
});
