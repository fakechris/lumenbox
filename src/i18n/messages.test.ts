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
  assert.ok(keys.length > 40, "the bundle is the whole chat vocabulary, not a sample");
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), keys, `${locale} has a different key set`);
    for (const key of keys) {
      assert.deepEqual(
        placeholdersOf(MESSAGES[locale][key]!),
        placeholdersOf(MESSAGES.zh[key]!),
        `${locale}.${key} does not fill the same blanks`
      );
      assert.notEqual(MESSAGES[locale][key]!.trim(), "", `${locale}.${key} is empty`);
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
