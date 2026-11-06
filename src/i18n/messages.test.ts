/**
 * The bundle (INV-544): both languages carry the same keys and the same placeholders, and
 * a missing one is caught here rather than by somebody reading a screen with `card.done`
 * printed on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES, tr } from "./messages.ts";
import { LOCALES } from "./locale.ts";

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort();

test("every language has every key, with the same placeholders in each", () => {
  const keys = Object.keys(MESSAGES.zh).sort();
  assert.ok(keys.length > 1000, "the bundle is the chat's and the page's whole vocabulary, not a sample");
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), keys, `${locale} has a different key set`);
    for (const key of keys) {
      assert.deepEqual(
        placeholdersOf(MESSAGES[locale][key]!),
        placeholdersOf(MESSAGES.zh[key]!),
        `${locale}.${key} does not fill the same blanks`
      );
      // Only an English inflection may be nothing in Chinese: "3 call" + "s".
      if (!(locale === "zh" && key.startsWith("ui.plural."))) assert.notEqual(MESSAGES[locale][key]!.trim(), "", `${locale}.${key} is empty`);
    }
  }
});

test("a message is filled, and an unknown key is not a blank screen", () => {
  assert.equal(tr("card.done", "zh"), "已完成");
  assert.equal(tr("card.done", "en"), "done");
  assert.equal(tr("task.accepted", "en", { task: "t12" }), "Right, t12 counts as done.");
  assert.equal(tr("task.accepted", "zh", { task: "t12" }), "好,t12 算完成了。");
  // A blank nobody filled stays visible rather than becoming an empty gap.
  assert.match(tr("ack.queued", "en", { who: "Ada" }), /\{ahead\}/);
  // An unknown key reads as itself, which is ugly and findable — the parity test above is
  // what stops it ever shipping.
  assert.equal(tr("nothing.like.this", "en"), "nothing.like.this");
  assert.equal(tr("card.done"), "已完成", "the default locale is what every chat string here already was");
});

test("every word the page names is in both languages, and a word inside a script cannot break out of its string (INV-1684)", async () => {
  const { keysIn } = await import("../web/page-locale.ts");
  const { uiSources, templatesIn } = await import("./ui-literals.ts");
  const inScript = new Set<string>();
  for (const { kind, raw: template } of uiSources().flatMap(source => templatesIn(source.text))) {
    for (const key of keysIn(template)) {
      for (const locale of LOCALES) assert.ok(key in MESSAGES[locale], `the page names {{${key}}}, which ${locale} does not have`);
    }
    const scripts = kind === "script" ? [template] : [...template.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]!);
    for (const script of scripts) for (const key of keysIn(script)) inScript.add(key);
  }
  assert.ok(inScript.size > 500, "the script's words are found");
  for (const key of inScript) {
    for (const locale of LOCALES) {
      // The page's script puts these into HTML as often as into text, so neither reading may differ.
      assert.doesNotMatch(MESSAGES[locale][key]!, /[<>"\\]/, `${locale}.${key} lands inside a script string: no < > " or backslash`);
    }
  }
});
