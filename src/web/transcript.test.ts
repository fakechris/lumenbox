/**
 * Tests for turning a stored transcript into a readable conversation.
 *
 * The wake-prompt cases go through buildWakePrompt rather than a hand-written string,
 * so the parse is tested against the format actually written to disk. A test with its
 * own copy of the format would keep passing after the prompt changed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWakePrompt, parseWakePrompt } from "../host/prompt.ts";
import { toDisplayEntries } from "./transcript.ts";

const inbound = (from: string, text: string, priority = false) => ({
  id: "m-test", fromId: `id-${from}`,
  fromName: from,
  text,
  priority,
  receivedAt: "2026-08-18T00:00:00.000Z",
});

test("a wake prompt round-trips back to the message that caused it", () => {
  const prompt = buildWakePrompt([inbound("Ada", "Done — /home/box/work/report.md")]);
  const parsed = parseWakePrompt(prompt, ["Ada", "Bob"]);

  assert.deepEqual(parsed, [
    { from: "Ada", priority: false, text: "Done — /home/box/work/report.md" },
  ]);
});

test("several peers, and the priority flag, survive the round trip", () => {
  const prompt = buildWakePrompt([
    inbound("Ada", "first"),
    inbound("Bob", "second", true),
  ]);
  const parsed = parseWakePrompt(prompt, ["Ada", "Bob"]);

  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.[0], { from: "Ada", priority: false, text: "first" });
  assert.deepEqual(parsed?.[1], { from: "Bob", priority: true, text: "second" });
});

test("a multi-line message keeps its own lines", () => {
  const body = "Findings:\n\n- one\n- two\nNote: not a new sender";
  const parsed = parseWakePrompt(buildWakePrompt([inbound("Ada", body)]), ["Ada"]);

  // The roster is what stops "Note:" from being read as a message from Note.
  assert.ok(parsed, "the body parsed");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.text, body);
});

test("text the user typed is not a wake prompt", () => {
  assert.equal(parseWakePrompt("check the markdown rendering", ["Ada"]), null);
  assert.equal(parseWakePrompt("[agent] malformed", ["Ada"]), null);
});

test("tool traffic becomes tool rows, not empty bubbles", () => {
  const entries = [
    { role: "user", text: "take a screenshot", at: "t" },
    {
      role: "assistant",
      kind: "blocks",
      blocks: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "1", name: "bash", input: { command: "ls -la /home/box" } },
        {
          type: "tool_use",
          id: "2",
          name: "computer",
          input: { actions: [{ action: "click" }, { action: "screenshot" }] },
        },
      ],
      at: "t",
    },
    {
      role: "user",
      kind: "results",
      blocks: [
        { type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "work" }] },
        { type: "tool_result", tool_use_id: "2", content: "failed", is_error: true },
      ],
      at: "t",
    },
  ];

  const display = toDisplayEntries(entries, [{ id: "id-Ada", name: "Ada" }]);

  assert.deepEqual(display[0], { kind: "text", role: "user", text: "take a screenshot" });
  assert.deepEqual(display[1], { kind: "text", role: "assistant", text: "Looking now." });
  // The result is folded into the call it answers, so the page has one row to collapse.
  assert.deepEqual(display[2], {
    kind: "tools",
    tools: [
      { name: "bash", detail: "ls -la /home/box", result: "work", isError: false },
      { name: "computer", detail: "click + screenshot", result: "failed", isError: true },
    ],
  });
  assert.equal(display[3], undefined);
});

test("a wake prompt in a transcript becomes a peer entry", () => {
  const entries = [
    { role: "user", text: buildWakePrompt([inbound("Ada", "over to you")]), at: "t" },
    { role: "assistant", text: "on it", at: "t" },
  ];

  const display = toDisplayEntries(entries, [{ id: "id-Ada", name: "Ada" }, { id: "id-Bob", name: "Bob" }]);
  assert.deepEqual(display[0], {
    kind: "peer",
    messages: [{ from: "Ada", priority: false, text: "over to you" }],
  });
  assert.deepEqual(display[1], { kind: "text", role: "assistant", text: "on it" });
});

test("entries with nothing to show are dropped", () => {
  const display = toDisplayEntries(
    [{ role: "assistant", text: "   ", at: "t" }, { role: "assistant", kind: "blocks", blocks: [] }],
    []
  );
  assert.deepEqual(display, []);
});

test("a message to a teammate is recorded by name, not by id", () => {
  // The UI shows this as a one-line hint in the sender's chat ("Messaged [Bob]"),
  // not as the message text; a uuid there would say nothing about who was messaged.
  const entries = [
    {
      role: "assistant",
      kind: "blocks",
      blocks: [
        {
          type: "tool_use",
          id: "1",
          name: "SendToAgent",
          input: { target_id: "id-Bob", text: "please verify r1.txt" },
        },
      ],
      at: "t",
    },
  ];

  const display = toDisplayEntries(entries, [{ id: "id-Bob", name: "Bob" }]);
  assert.deepEqual(display[0], {
    kind: "tools",
    tools: [{ name: "SendToAgent", detail: "Bob: please verify r1.txt" }],
  });
});
