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
