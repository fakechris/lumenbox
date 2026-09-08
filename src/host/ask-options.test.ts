/**
 * The answers an AskUser call carried, whatever shape the model sent them in. Objects and nested
 * arrays both shipped, and String() of those was what the person saw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optionLabel } from "./ask-options.ts";
import { questionOf } from "../web/transcript.ts";

test("an option is a label whether it came as a string, an object, or a nest", () => {
  assert.equal(optionLabel("chat first"), "chat first");
  assert.equal(optionLabel({ label: "mcp", description: "direct" }), "mcp");
  assert.equal(optionLabel({ item: ["cli — the binary", { label: "ignored" }] }), "cli — the binary");
  assert.equal(optionLabel([["rust by default", ["typescript"]]]), "rust by default");
  assert.equal(optionLabel("   "), undefined);
  assert.equal(optionLabel(42), undefined);
});

test("questionOf gives the page the question and its buttons", () => {
  assert.deepEqual(questionOf({ question: "Which one?", options: ["A", { label: "B" }, [["C"]]] }), {
    question: "Which one?",
    options: ["A", "B", "C"],
  });
  assert.deepEqual(questionOf({ question: "Free text?" }), { question: "Free text?" });
  assert.equal(questionOf({ options: ["A"] }), undefined);
});
