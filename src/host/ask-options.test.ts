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

test("two questions in a row is the budget; the third is refused", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { dispatchTool, consecutiveQuestions } = await import("./tools.ts");
  const root = mkdtempSync(join(tmpdir(), "agentbox-askbudget-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    const asked: string[] = [];
    const context = {
      agent: ada, registry, bus: {} as never, box: undefined,
      askUser: async (input: { question: string }) => { asked.push(input.question); return "in the app"; },
    } as unknown as Parameters<typeof dispatchTool>[2];
    const questionTurn = (q: string) => {
      registry.appendTranscript(ada.id, { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "t", name: "AskUser", input: { question: q } }], at: "" } as never);
      registry.appendTranscript(ada.id, { role: "user", text: "hm", at: "" } as never);
    };
    assert.equal(consecutiveQuestions(context), 0);
    questionTurn("one?"); questionTurn("two?");
    assert.equal(consecutiveQuestions(context), 2);
    const third = await dispatchTool("AskUser", { question: "three?" }, context);
    assert.equal(third.isError, true);
    assert.match(third.text, /Decide this one yourself/);
    assert.deepEqual(asked, []);
    // Work in between resets the count.
    registry.appendTranscript(ada.id, { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "t", name: "bash", input: { command: "ls" } }], at: "" } as never);
    assert.equal(consecutiveQuestions(context), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
