import { test } from "node:test";
import assert from "node:assert/strict";
import { answerAfterSendBack } from "./sent-back.ts";

test("a closing note keeps the answer it is about; an answer given again is not doubled", () => {
  const draft = "The claim holds, the three numbers do not. ".repeat(8);
  assert.equal(answerAfterSendBack(draft, "Fixed the quotation marks."), `${draft.trim()}\n\nFixed the quotation marks.`, "the person gets the answer, then the note");
  const again = draft.replace("claim", "finding");
  assert.equal(answerAfterSendBack(draft, again), again, "a whole answer replaces the draft: that is what the gate asked for");
  assert.equal(answerAfterSendBack(undefined, "Done."), "Done.", "nothing was sent back");
});
