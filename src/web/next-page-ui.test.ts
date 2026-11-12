/**
 * The rebuilt page (INV-1825): that it is a page at all in both languages, that its script names no
 * element the markup lacks, and that the few decisions it makes for itself are the ones docs/99 §4 lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_PAGE } from "./page-locale.ts";
import { nextLogic } from "./next-logic-ui.ts";

const row = (phase: string, blocker?: string, status = "doing") => ({ status, reading: { phase, ...(blocker ? { blocker: { kind: blocker } } : {}) } });

test("the page fills in both languages, and its script parses", () => {
  for (const locale of ["zh", "en"] as const) {
    const page = NEXT_PAGE(locale);
    assert.doesNotMatch(page, /\{\{/, "no unfilled word");
    const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;
    assert.doesNotThrow(() => new vm.Script(script), "the page script is valid JavaScript");
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
