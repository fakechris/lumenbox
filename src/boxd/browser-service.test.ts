/**
 * Tests for the parts of driving a browser that do not need a browser.
 *
 * Most of this service is only meaningful against a real page, and is verified that way.
 * What is worth pinning here is the dialog decision, because it is the one place the
 * service answers a question on the agent's behalf — and answering "yes" by default to a
 * page that asks "delete everything?" is a mistake no test after the fact would undo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dialogAnswer, portForDisplay } from "./browser-service.ts";

test("a page asking permission is declined; a page stating a fact is not", () => {
  // The agent has not read the question at the moment this is answered — the page is
  // frozen waiting — so the only safe answer is the one that changes nothing.
  const confirm = dialogAnswer("confirm", "Delete everything?");
  assert.equal(confirm.accept, false);
  assert.match(confirm.note, /Delete everything\?/);
  // Reported rather than swallowed, or the agent sees a click that silently did nothing.
  assert.match(confirm.note, /declined/);
  assert.match(confirm.note, /Act again if you meant to agree/);

  const prompt = dialogAnswer("prompt", "Your name?");
  assert.equal(prompt.accept, false);

  // An alert has one button, so declining it is not a safer answer, just a stranger one.
  assert.equal(dialogAnswer("alert", "Saved.").accept, true);

  // Leaving the page is what the agent asked for when it navigated; declining would make
  // navigation silently fail on every site with an unsaved-changes guard.
  assert.equal(dialogAnswer("beforeunload", "").accept, true);
});

test("each desktop drives its own browser", () => {
  // Sharing a port would mean two agents driving one browser, which is the same bug as
  // two agents sharing a profile — and the profile split in box-chrome is keyed the same way.
  assert.equal(portForDisplay(0), 9222);
  assert.equal(portForDisplay(1), 9223);
  assert.notEqual(portForDisplay(1), portForDisplay(2));
});
