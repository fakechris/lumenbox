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
import type Anthropic from "@anthropic-ai/sdk";
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
  estimateMessageTokens,
  knownContextWindow,
  noteContextWindow,
  policyForModel,
  pruneOldImages,
  TOKENS_PER_IMAGE,
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

// ── in-turn image pruning ──────────────────────────────────────────────────────────────

/** A round of computer use: an assistant tool_use, then a tool_result carrying a screenshot. */
function computerRound(index: number, resultChars = 200): Anthropic.MessageParam[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `clicking step ${index}` },
        { type: "tool_use", id: `toolu_${index}`, name: "computer", input: { action: "click" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${index}`,
          content: [
            { type: "text", text: "x".repeat(resultChars) },
            {
              type: "image",
              source: { type: "base64", media_type: "image/webp", data: "AAAA" },
            },
          ],
        },
      ],
    },
  ] as Anthropic.MessageParam[];
}

test("only the newest screenshot survives a prune, and the pairing is untouched", () => {
  const messages = Array.from({ length: 10 }, (_, index) => computerRound(index)).flat();
  const before = estimateMessageTokens(messages);

  const pruned = pruneOldImages(messages, 1);
  assert.equal(pruned.dropped, 9, "ten screenshots, one kept");

  // The structural claim that makes this safe: only the *contents* of results change, so the
  // tool_use/tool_result pairing the API requires cannot be broken by pruning.
  assert.equal(pruned.messages.length, messages.length, "no message was removed");
  for (let at = 0; at < messages.length; at++) {
    assert.equal(pruned.messages[at]!.role, messages[at]!.role, `message ${at} kept its role`);
  }
  const ids = pruned.messages.flatMap(message =>
    Array.isArray(message.content)
      ? message.content
          .filter(block => (block as { type?: string }).type === "tool_result")
          .map(block => (block as Anthropic.ToolResultBlockParam).tool_use_id)
      : []
  );
  assert.deepEqual(ids, Array.from({ length: 10 }, (_, index) => `toolu_${index}`));

  // The surviving image is the last one, because that is the one the next decision needs.
  const lastResult = pruned.messages.at(-1)!;
  const parts = (lastResult.content as Anthropic.ToolResultBlockParam[])[0]!
    .content as { type: string }[];
  assert.ok(parts.some(part => part.type === "image"), "the newest screenshot is still there");

  // And a dropped one leaves a note rather than a hole.
  const firstResult = pruned.messages[1]!;
  const firstParts = (firstResult.content as Anthropic.ToolResultBlockParam[])[0]!
    .content as { type: string; text?: string }[];
  assert.ok(!firstParts.some(part => part.type === "image"));
  assert.ok(
    firstParts.some(part => part.text?.includes("screenshot removed")),
    "an agent must be told its view of the past changed"
  );

  // Worth the trouble: the reduction is most of the request.
  const after = estimateMessageTokens(pruned.messages);
  assert.ok(after < before / 2, `expected a large cut, went from ${before} to ${after}`);
});

test("pruning with nothing to prune is free and changes nothing", () => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const pruned = pruneOldImages(messages, 1);
  assert.equal(pruned.dropped, 0);
  assert.equal(pruned.messages, messages, "the same array is returned, not a copy");
});

test("keeping zero images drops all of them, for an image-count limit", () => {
  // A provider that limits the *number* of images is not helped by keeping one.
  const messages = Array.from({ length: 3 }, (_, index) => computerRound(index)).flat();
  assert.equal(pruneOldImages(messages, 0).dropped, 3);
});

test("images are counted as images, not as base64 characters", () => {
  // A 6.5KB screenshot is ~8,700 base64 characters but bills as ~1,600 tokens. Counting characters
  // gets it wrong in both directions: small screenshots look free, large ones look ruinous.
  const withImage = computerRound(0, 0);
  const tokens = estimateMessageTokens(withImage);
  assert.ok(
    tokens > TOKENS_PER_IMAGE && tokens < TOKENS_PER_IMAGE + 500,
    `one round with one image should be about one image's worth, was ${tokens}`
  );
});

test("the estimate counts what is nested inside a tool result", () => {
  // The nesting is where screenshots actually live. Missing it is how a computer-use turn looks
  // cheap right up to the request that fails.
  const flat: HistoryEntry[] = [
    {
      role: "user",
      kind: "results",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "y".repeat(1000) }],
        },
      ],
      at: "",
    },
  ];
  const withImageNested: HistoryEntry[] = [
    {
      role: "user",
      kind: "results",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "y".repeat(1000) },
            { type: "image", source: { type: "base64", media_type: "image/webp", data: "AA" } },
          ],
        },
      ],
      at: "",
    },
  ];
  assert.ok(
    estimateTokens(withImageNested) - estimateTokens(flat) >= TOKENS_PER_IMAGE,
    "a nested image has to be seen"
  );
});

test("the trigger follows the model's real window when one is reported", () => {
  // A fixed 60k trigger wastes 94% of a 1M-token model and may be too generous for a 200k one.
  const conservative = policyForModel("unknown-model");
  assert.equal(conservative.triggerTokens, DEFAULT_POLICY.triggerTokens, "no window: fall back");

  noteContextWindow("big-model", 1_000_000);
  const big = policyForModel("big-model");
  assert.ok(big.triggerTokens > 500_000, `expected a large trigger, got ${big.triggerTokens}`);
  assert.ok(big.keepTailTokens > conservative.keepTailTokens);

  noteContextWindow("small-model", 200_000);
  assert.ok(policyForModel("small-model").triggerTokens < big.triggerTokens);

  // Rubbish is ignored rather than believed: a zero window would mean compacting on every turn.
  noteContextWindow("small-model", 0);
  assert.equal(knownContextWindow("small-model"), 200_000);
  noteContextWindow("small-model", undefined);
  assert.equal(knownContextWindow("small-model"), 200_000);
});
