/**
 * The rebuilt page (INV-1825): that it is a page at all in both languages, that its script names no
 * element the markup lacks, and that the few decisions it makes for itself are the ones docs/99 §4 lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_PAGE } from "./page-locale.ts";
import { nextLogic } from "./next-logic-ui.ts";

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

test("the page somebody switched to is the one they come back to; with no choice it is the classic one", async () => {
  const { pageChoice, APP_PAGE } = await import("./page-locale.ts");
  const ask = (path: string, cookie?: string) => pageChoice({ headers: cookie ? { cookie } : {} } as never, new URL(path, "http://127.0.0.1"));
  assert.equal(ask("/").page, APP_PAGE, "no choice: classic");
  assert.equal(ask("/").remember, undefined);
  assert.equal(ask("/?ui=next").page, NEXT_PAGE);
  assert.match(ask("/?ui=next").remember!, /^lumen-ui=next; /);
  assert.equal(ask("/", "agentbox_ui=x; lumen-ui=next").page, NEXT_PAGE, "remembered across a plain reload");
  assert.equal(ask("/?ui=classic", "lumen-ui=next").page, APP_PAGE, "and switching back is one link");
  assert.match(ask("/?ui=classic", "lumen-ui=next").remember!, /^lumen-ui=classic; /);
  assert.equal(ask("/?ui=sideways").page, APP_PAGE, "an unknown choice is no choice");
  assert.equal(ask("/?ui=next", "lumen-ui=next").remember, undefined, "nothing to remember twice");
  assert.deepEqual([ask("/?ui=classic&once=1&task=t1", "lumen-ui=next").page, ask("/?ui=classic&once=1&task=t1", "lumen-ui=next").remember], [APP_PAGE, undefined], "one look at the other page changes nothing");
  assert.deepEqual([ask("/?import=abc", "lumen-ui=next").page, ask("/?import=abc", "lumen-ui=next").remember], [APP_PAGE, undefined], "a template link opens where its dialog is");
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

test("a delivered result is decided where the person was talking: Accept closes it, and a long file list is cut", async () => {
  interface Fake { cls: string; text: string; kids: Fake[]; dataset: Record<string, string>; href?: string; press?: () => void; appendChild(kid: Fake): void; addEventListener(name: string, run: () => void): void }
  const el = (_tag: string, cls = "", text = ""): Fake => {
    const node: Fake = { cls, text, kids: [], dataset: {}, appendChild(kid) { node.kids.push(kid); }, addEventListener(_name, run) { node.press = run; } };
    return node;
  };
  const posted: unknown[] = [], opened: string[] = [];
  const files = [1, 2, 3, 4, 5, 6].map(n => ({ id: `f${n}`, name: `part-${n}.md` }));
  const resultCard = pageFunction("resultCard", {
    el, t: (key: string, values?: { n?: number }) => key + (values?.n ?? ""), agentName: () => "Mia", toast: () => {}, refreshSoon: () => {}, failed: () => {}, encodeURIComponent,
    openPanel: (id: string) => opened.push(id), postJson: (path: string, body: unknown) => { posted.push([path, body]); return Promise.resolve({}); },
  });
  const card = resultCard({ id: "t1", title: "October report", assigneeId: "mia", deliverables: files }) as Fake;
  assert.equal(card.kids.filter(kid => kid.cls === "file").length, 4);
  assert.ok(card.kids.some(kid => kid.text === "ui.next.chat.moreFiles2"), "the rest are counted, not listed");
  const [accept, changes] = card.kids.at(-1)!.kids;
  accept!.press!(); changes!.press!();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [["/api/tasks/update", { id: "t1", status: "done" }]]);
  assert.deepEqual(opened, ["t1"], "what to change is written in the panel, beside the result");
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
