/**
 * Tests for history compaction.
 *
 * The property that matters most is not the size reduction — it is that a cut never splits a tool
 * call from its result. A request assembled across that boundary is rejected by the API, and it
 * would be rejected only for the agents whose conversations had grown, which is the hardest kind of
 * failure to reproduce.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  activeWindow,
  buildSummaryPrompt,
  chooseCutPoint,
  droppedEntry,
  estimateTokens,
  summaryEntry,
  type CompactionPolicy,
  type HistoryEntry,
} from "./compaction.ts";

const POLICY: CompactionPolicy = { triggerTokens: 100, keepTailTokens: 40 };

const text = (role: "user" | "assistant", size: number): HistoryEntry => ({
  role,
  text: "x".repeat(size * 4),
  at: "2026-08-19T00:00:00Z",
});

const call = (size: number): HistoryEntry => ({
  role: "assistant",
  kind: "blocks",
  blocks: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "x".repeat(size * 4) } }],
  at: "2026-08-19T00:00:00Z",
});

const result = (size: number): HistoryEntry => ({
  role: "user",
  kind: "results",
  blocks: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(size * 4) }],
  at: "2026-08-19T00:00:00Z",
});

test("a short history is left alone", () => {
  assert.equal(chooseCutPoint([text("user", 10), text("assistant", 10)], POLICY), undefined);
});

test("a long history is cut, and the tail is kept", () => {
  const entries = Array.from({ length: 20 }, (_, i) => text(i % 2 ? "assistant" : "user", 20));
  const cut = chooseCutPoint(entries, POLICY);

  assert.ok(cut, "nothing was cut from a history well over the trigger");
  assert.ok(cut.index > 0 && cut.index < entries.length, `cut at ${cut.index}`);
  assert.ok(estimateTokens(entries.slice(cut.index)) >= POLICY.keepTailTokens);
  assert.match(cut.reason, /over the 100 trigger/);
});

test("a cut never separates a tool call from its result", () => {
  // The pairs are laid out so that a naive size-based cut lands between a call and its result.
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < 12; i++) {
    entries.push(call(15));
    entries.push(result(15));
  }

  const cut = chooseCutPoint(entries, POLICY);
  assert.ok(cut);
  const before = entries[cut.index - 1]!;
  const kind = "kind" in before ? before.kind : "text";
  assert.ok(
    kind === "results" || kind === "summary" || kind === "text",
    `the entry before the cut is a ${kind}, so the tail starts with an orphaned result`
  );
  // And the tail itself must not begin with a result.
  const first = entries[cut.index]!;
  const firstKind = "kind" in first ? first.kind : "text";
  assert.notEqual(firstKind, "results", "the tail starts with a result whose call was summarised");
});

test("assembly starts from the newest summary", () => {
  const entries: HistoryEntry[] = [
    text("user", 5),
    text("assistant", 5),
    summaryEntry("first summary", 2),
    text("user", 5),
    summaryEntry("second summary", 4),
    text("assistant", 5),
  ];

  const window = activeWindow(entries);
  assert.equal(window.length, 2, "the window is the newest summary plus what follows");
  assert.match((window[0] as { text: string }).text, /second summary/);
});

test("with no summary the whole history is active", () => {
  const entries = [text("user", 5), text("assistant", 5)];
  assert.equal(activeWindow(entries).length, 2);
});

test("the summary prompt asks for state, not narrative", () => {
  const prompt = buildSummaryPrompt([
    text("user", 3),
    call(3),
    result(3),
  ]);

  assert.match(prompt, /files you created or changed, with their paths/);
  assert.match(prompt, /left open or blocked/);
  assert.match(prompt, /Do not invent progress/);
  // Tool traffic is rendered, or a summary would describe a conversation with no work in it.
  assert.match(prompt, /assistant used bash/);
  assert.match(prompt, /result:/);
});

test("a summary and a failed summary are both visible in history", () => {
  const summary = summaryEntry("did the thing", 12);
  assert.equal(summary.kind, "summary");
  assert.match(summary.text, /Summary of the first 12 entries/);

  // The failure path is deliberately loud, and tells the model how to treat what it cannot see.
  const dropped = droppedEntry(12, "the summariser returned nothing");
  assert.match(dropped.text, /could not be summarised/);
  assert.match(dropped.text, /unknown rather than as not done/);
});

test("the default policy keeps a real tail", () => {
  // A trigger below the tail would mean compacting to something larger than the trigger.
  assert.ok(DEFAULT_POLICY.keepTailTokens < DEFAULT_POLICY.triggerTokens);
});
