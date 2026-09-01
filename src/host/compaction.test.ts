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
import { resolveProvider, resolveSummaryProvider, summaryRuntimeFor } from "./provider.ts";
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
  compactionUrgency,
  calibratedTokens,
  CompactionGuard,
  choosePinnedEntries,
  estimateRequestTokens,
  noteRealInputTokens,
  trimInputLeaves,
  extractAnchors,
  missingSummaryHeadings,
  pendingHasDrifted,
  pendingIsUsable,
  SUMMARY_WORD_CAP,
  pruneOldImages,
  repairPairs,
  TOKENS_PER_IMAGE,
} from "./compaction.ts";

const POLICY: CompactionPolicy = { triggerTokens: 100, keepTailTokens: 40, maxEntries: 50 };

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

  assert.match(prompt, /every file you created or changed, by full path/);
  assert.match(prompt, /open, blocked or waiting/);
  assert.match(prompt, /Do not invent progress/);
  // Tool traffic is rendered, or a summary would describe a conversation with no work in it.
  assert.match(prompt, /assistant used bash/);
  assert.match(prompt, /result:/);
});

test("a summary and a failed summary are both visible in history", () => {
  const summary = summaryEntry("did the thing", 12);
  assert.equal(summary.kind, "summary");
  // Labelled as background rather than as a standing objective: read as the latter, a
  // finished piece of work kept steering answers to questions about something else.
  assert.match(summary.text, /Earlier in this conversation/);
  assert.match(summary.text, /background, not instructions/);
  assert.match(summary.text, /most recent message/);

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

// ── background pre-compaction ──────────────────────────────────────────────────────────

test("urgency has three states, and the middle one is the point", () => {
  const policy = { triggerTokens: 1_000, keepTailTokens: 300, maxEntries: 50 };
  const entry = (chars: number): HistoryEntry => ({
    role: "user",
    text: "x".repeat(chars),
    at: "",
  });

  // 2.5 chars per token, so 1,000 tokens is about 2,500 characters.
  assert.equal(compactionUrgency([entry(100)], policy), "none");
  // Above 75% of the trigger: start work, but this turn still has room and must not wait.
  assert.equal(compactionUrgency([entry(2_000)], policy), "background");
  assert.equal(compactionUrgency([entry(5_000)], policy), "now");
});

test("a speculative summary is discarded if the history moved underneath it", async () => {
  const pending = {
    covers: 10,
    computedFrom: 20,
    promise: Promise.resolve(summaryEntry("done", 10)),
  };
  const entry = (text: string): HistoryEntry => ({ role: "user", text, at: "2026-08-29T00:00:00Z" });
  const window = (length: number) => Array.from({ length }, (_, i) => entry(`m${i}`));
  const policy: CompactionPolicy = { triggerTokens: 1_000, keepTailTokens: 300, maxEntries: 50 };

  // Longer is fine: the summary covers a prefix and the tail is sent verbatim either way.
  assert.equal(pendingIsUsable(pending, window(25), policy), true);
  assert.equal(pendingIsUsable(pending, window(20), policy), true);
  // Shorter means the window was compacted underneath it, so `covers` now points at the wrong
  // entries — using it would silently summarise away work that had not been summarised.
  assert.equal(pendingIsUsable(pending, window(12), policy), false);
  assert.equal(pendingIsUsable(undefined, window(20), policy), false);

  // The uncovered tail over the entry cap: adoption would not bound the window.
  assert.equal(pendingIsUsable(pending, window(70), policy), false);

  // The docs/24 v3 case: entry counts fine, but one enormous steering message after the
  // background pass leaves a tail over the token trigger — adopting the stale summary
  // would not bound the request, so it is rejected and a fresh cut is computed.
  const heavy = [...window(15), entry("x".repeat(5_000))];
  assert.equal(pendingIsUsable(pending, heavy, policy), false);
});

test("the summariser is a separate, cheaper profile where one exists", () => {
  const anthropic = resolveProvider("anthropic");
  const summary = resolveSummaryProvider(anthropic);

  assert.notEqual(summary.model, anthropic.model, "not the agent's own model");
  assert.equal(summary.keyEnv, anthropic.keyEnv, "same credential: no new configuration needed");
  // A summarising call is plain text in, plain text out. Capabilities the cheaper model may not
  // share are switched off rather than assumed, since a rejected field fails the very compaction it
  // was meant to perform.
  assert.equal(summary.adaptiveThinking, false);
  assert.equal(summary.effort, false);

  // A provider with no cheaper model named falls back to the agent's own, rather than refusing: a
  // deployment with one credential must still be able to compact. Better slow than stuck.
  const minimax = resolveProvider("minimax");
  assert.equal(resolveSummaryProvider(minimax).model, minimax.model);
});

test("an explicit summariser choice wins over the derived one", () => {
  const previousModel = process.env.AGENTBOX_SUMMARY_MODEL;
  try {
    process.env.AGENTBOX_SUMMARY_MODEL = "some-other-model";
    assert.equal(resolveSummaryProvider(resolveProvider("anthropic")).model, "some-other-model");
  } finally {
    if (previousModel === undefined) delete process.env.AGENTBOX_SUMMARY_MODEL;
    else process.env.AGENTBOX_SUMMARY_MODEL = previousModel;
  }
});

test("compaction keeps the tail it deliberately preserved", () => {
  // The bug this exists for: the transcript is append-only, so a summary is written at the END of
  // the file, not at the position it summarises. Reading "from the newest summary onwards" returned
  // the summary and nothing else — every entry chooseCutPoint had kept sat before it and vanished
  // from the request. A conversation compacted once lost its whole recent tail, and the failure was
  // invisible because the summary itself always arrived.
  const old = Array.from({ length: 100 }, () => text("user", 5));
  const recent = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    text: `RECENT ${i}`,
    at: "2026-08-19T00:00:00Z",
  }));
  const summary = { role: "user" as const, kind: "summary" as const, covers: 100, text: "[s]", at: "" };

  const window = activeWindow([...old, ...recent, summary]);
  assert.equal(window.length, 21, "the summary plus every entry it did not cover");
  assert.equal(window[0], summary, "and the summary comes first, standing in for the old prefix");
  assert.equal(
    window.filter(entry => "text" in entry && entry.text.startsWith("RECENT")).length,
    20
  );

  // Compacted twice: the second summary's `covers` counts into the window the first one left.
  const second = { role: "user" as const, kind: "summary" as const, covers: 11, text: "[s2]", at: "" };
  const twice = activeWindow([...old, ...recent, summary, ...recent.slice(0, 5), second]);
  assert.equal(twice[0], second);
  // 21 - 11 covered = 10 left of the first window, plus the 5 appended after it.
  assert.equal(twice.length, 1 + 10 + 5);
});

test("a long conversation of cheap entries is summarised, not silently cut", () => {
  // Request assembly has a hard entry cap. Reaching it without compaction having run drops the
  // oldest entries with no summary and no notice, so a hundred short exchanges could lose the
  // instruction that started the task. The count is a trigger in its own right.
  const many = Array.from({ length: 80 }, () => text("user", 2));
  const policy: CompactionPolicy = { triggerTokens: 1_000_000, keepTailTokens: 500_000, maxEntries: 50 };
  assert.equal(compactionUrgency(many, policy), "now", "far under every token threshold");

  const cut = chooseCutPoint(many, policy);
  assert.ok(cut, "and a cut is actually named, or the trigger would fire forever with no effect");
  assert.match(cut.reason, /80 entries, over the 50 entry trigger/);
  assert.ok(many.length - cut.index <= 50, "the tail it keeps fits under the cap");
  assert.ok(cut.index > 0);
});


test("a call whose result history lost still gets one, so the request stays sendable", () => {
  // A call and its results are two separate appends, so a crash between them leaves an orphan. The
  // provider rejects a request containing a tool_use with no matching tool_result — which means one
  // orphan does not degrade a turn, it ends every future turn for that agent, permanently. Trimming
  // the ends was not enough: the orphan sits at the end only until the next turn appends anything,
  // and from then on it is interior.
  const orphaned: Anthropic.MessageParam[] = [
    { role: "user", content: "deploy it" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    // The crash happened here. Everything below is a later turn.
    { role: "user", content: "did that work?" },
    { role: "assistant", content: [{ type: "text", text: "checking" }] },
  ];

  const repaired = repairPairs(orphaned);
  const results = repaired
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => (block as { type?: string }).type === "tool_result");
  assert.equal(results.length, 1, "the orphan is paired");
  assert.equal((results[0] as Anthropic.ToolResultBlockParam).tool_use_id, "t1");

  // Unknown, not failed. The call may well have succeeded, and telling a model that a deploy failed
  // when it may have deployed is how it gets deployed twice.
  const text = JSON.stringify(results[0]);
  assert.match(text, /outcome is unknown/);
  assert.doesNotMatch(text, /"is_error":true/);

  // The later turn is still there and still in order.
  assert.equal(repaired.at(-1)?.role, "assistant");
  assert.equal(repaired.filter(message => message.role === "user").length, 3);
});

test("a result whose call is gone is dropped, not sent to be rejected", () => {
  // The other side of the pairing invariant (audit 2026-09-01, claim 1): the entry-count
  // backstop slices the window from the tail, the leading summary is re-prepended, and a
  // results entry that lost its call lands right after a user-role summary. The wire
  // rejects the whole request over it — one orphan ends the turn.
  const sliced: Anthropic.MessageParam[] = [
    { role: "user", content: "[Earlier in this conversation — background…] **Threads** …" },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "cut-away", content: [{ type: "text", text: "lost" }] },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok" }] }],
    },
  ];
  const repaired = repairPairs(sliced);
  const ids = repaired
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => (block as { type?: string }).type === "tool_result")
    .map(block => (block as Anthropic.ToolResultBlockParam).tool_use_id);
  assert.deepEqual(ids, ["c1"], "the orphan is gone and the real pair is not duplicated");

  // A message mixing text with an orphaned result keeps its words and loses the result.
  const mixed: Anthropic.MessageParam[] = [
    { role: "user", content: "hello" },
    {
      role: "user",
      content: [
        { type: "text", text: "keep this" },
        { type: "tool_result", tool_use_id: "nowhere", content: [] },
      ],
    },
  ];
  const kept = repairPairs(mixed);
  assert.equal(kept.length, 2);
  assert.match(JSON.stringify(kept[1]), /keep this/);
  assert.doesNotMatch(JSON.stringify(kept), /tool_result/);
});

test("real results are left alone, and a partly answered call is topped up", () => {
  const complete: Anthropic.MessageParam[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: {} },
        { type: "tool_use", id: "t2", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] },
      ],
    },
  ];

  const repaired = repairPairs(complete);
  assert.equal(repaired.length, 2, "extended, not followed by a second user message");
  const blocks = repaired[1]?.content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(blocks.map(block => block.tool_use_id), ["t1", "t2"]);
  assert.match(JSON.stringify(blocks[0]), /ok/, "the real result is untouched");

  // A fully answered pair is returned unchanged, byte for byte.
  const fine: Anthropic.MessageParam[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
    },
  ];
  assert.deepEqual(repairPairs(fine), fine);
});


test("the screenshot that survives pruning is the current one", () => {
  // The messages were reversed and the blocks inside them were not. So one assistant response
  // making two computer calls produced a single user message holding two screenshots, and the
  // survivor was the first — the older one. The model was shown the screen as it looked *before*
  // the last action and told it was current, which for computer use is the most expensive kind of
  // wrong: it clicks where the button used to be.
  const shot = (tag: string): Anthropic.ImageBlockParam => ({
    type: "image",
    source: { type: "base64", media_type: "image/webp", data: tag },
  });
  const messages: Anthropic.MessageParam[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "computer", input: {} },
        { type: "tool_use", id: "b", name: "computer", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: [shot("BEFORE")] },
        { type: "tool_result", tool_use_id: "b", content: [shot("AFTER")] },
      ],
    },
  ];

  const pruned = pruneOldImages(messages, 1);
  assert.equal(pruned.dropped, 1);
  const kept = JSON.stringify(pruned.messages);
  assert.ok(kept.includes("AFTER"), "the screen as it is now");
  assert.ok(!kept.includes("BEFORE"), "not the screen as it was before the last action");

  // Order is preserved: the results still line up with the calls that made them.
  const results = (pruned.messages[1]?.content ?? []) as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(results.map(result => result.tool_use_id), ["a", "b"]);
});


test("a summary has a shape, so what it left out is visible", () => {
  // Four named sections rather than four things to mention. A list gets partially satisfied and
  // nobody notices which part was dropped; a heading that must be present makes the omission
  // visible — "Artifacts: none" is a claim that can be wrong, where a missing paragraph about files
  // is just absence.
  const prompt = buildSummaryPrompt([
    { role: "user", text: "write the release notes", at: "2026-08-20T10:00:00Z" },
  ]);

  // `Threads` rather than `Objective`: a chat that has run for days holds several
  // unrelated requests, and folding them into one objective made a finished piece of work
  // keep steering answers to questions about something else.
  for (const heading of ["**Threads**", "**Done**", "**State**", "**Artifacts**"]) {
    assert.ok(prompt.includes(heading), `missing ${heading}`);
  }
  assert.match(prompt, /exactly these four headings/);

  // Paths are the thing most often lost and most expensive to find again.
  assert.match(prompt, /every file you created or changed, by full path/);
  assert.match(prompt, /an empty section is a fact/);
  assert.match(prompt, /a room, not a task/);
  assert.match(prompt, /Mark finished ones finished/);
  // Against the two ways a summary of a summary goes wrong: finished work reading as
  // pending, and a claim losing the person who made it and becoming the agent's own.
  assert.match(prompt, /dated past tense/);
  assert.match(prompt, /Collapse a resolved exchange to its conclusion/);
  assert.match(prompt, /stays attributed to them/);

  // Failures belong in the history, or the summary reads as a plan rather than a record.
  assert.match(prompt, /Attempts that failed belong here too/);

  // A cap, because the failure of an unbounded summary is that it becomes a narrative.
  assert.match(prompt, new RegExp(`Under ${SUMMARY_WORD_CAP} words`));
});

test("the spill pointer survives the transcript's own truncation", async () => {
  const { storableResult } = await import("./turn.ts");
  // What the box returns for a command that outran the cap: a big head, then a notice
  // naming the file. The head alone is longer than what the transcript keeps.
  const notice = "[stdout truncated: 918273 more bytes — full output kept: /home/box/work/.spool/abc.out.log holds all 920273 bytes]";
  const stored = storableResult({
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: [{ type: "text", text: `${"build output line\n".repeat(400)}\n\n${notice}` }],
  });

  const text = (stored.content as { type: string; text: string }[])[0]!.text;
  assert.ok(text.length < 2_500, "still trimmed for the transcript");
  assert.match(text, /full output kept: \/home\/box\/work\/\.spool\/abc\.out\.log/,
    "the trail to the whole output is what must not be trimmed away");

  // A result that fits is untouched, pointer or not.
  const small = storableResult({
    type: "tool_result",
    tool_use_id: "toolu_2",
    content: [{ type: "text", text: "two lines\nof output" }],
  });
  assert.equal((small.content as { text: string }[])[0]!.text, "two lines\nof output");
});

test("pinned entries: the ask and one successful pair per undemonstrated tool", () => {
  // docs/24 v3 P0 #2 — schema insurance without moving the cut.
  const at = "2026-08-29T00:00:00Z";
  const call = (name: string, id: string): HistoryEntry => ({
    role: "assistant",
    kind: "blocks",
    blocks: [{ type: "tool_use", id, name, input: { actions: [{ action: "screenshot" }] } }],
    at,
  });
  const result = (id: string, error = false): HistoryEntry => ({
    role: "user",
    kind: "results",
    blocks: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(1000), ...(error ? { is_error: true } : {}) }],
    at,
  });
  const older: HistoryEntry[] = [
    { role: "user", text: "去开会并共享屏幕", at },
    call("computer", "c1"), result("c1"),
    call("computer", "c2"), result("c2", true), // errored pair: never an exemplar
    call("bash", "b1"), result("b1"),
  ];
  const tail: HistoryEntry[] = [call("bash", "b2"), result("b2")];

  const pinned = choosePinnedEntries(older, tail);
  // The ask is pinned (no plain user message in the tail), then the newest
  // *successful* computer pair — c1, because c2 errored — and no bash pair,
  // because the tail already demonstrates bash.
  assert.equal(pinned.length, 3);
  assert.ok(!("kind" in pinned[0]!) && pinned[0]!.text.includes("开会"));
  const pair = pinned.slice(1);
  assert.ok("kind" in pair[0]! && pair[0]!.kind === "blocks");
  const use = (pair[0] as { blocks: { id?: string; name?: string }[] }).blocks[0]!;
  assert.equal(use.name, "computer");
  assert.equal(use.id, "c1");
  // The exemplar's result is trimmed: its value is the call's shape.
  const trimmed = (pair[1] as { blocks: { content?: unknown }[] }).blocks[0]!;
  assert.match(JSON.stringify(trimmed.content), /exemplar — result trimmed/);
  assert.ok(JSON.stringify(trimmed.content).length < 500);

  // A tail that already has a user message pins no ask.
  const tailWithUser: HistoryEntry[] = [{ role: "user", text: "继续", at }, ...tail];
  assert.ok(!choosePinnedEntries(older, tailWithUser).some(entry => !("kind" in entry)));

  // Pinned entries weigh in the estimate — a summary carrying them is not free.
  const bare = summaryEntry("s", 6);
  const carrying = { ...bare, pinned };
  assert.ok(estimateTokens([carrying]) > estimateTokens([bare]));
});

test("anchors are harvested from full blocks, deduped, and bounded", () => {
  // docs/24 v3 P0 #3: a model paraphrases; the regex does not. Harvest runs on the
  // raw blocks, so a path past any rendering clip still survives.
  const at = "2026-08-29T00:00:00Z";
  const longPrefix = "x".repeat(900);
  const entries: HistoryEntry[] = [
    { role: "user", text: "fix t42 and push", at },
    {
      role: "assistant",
      kind: "blocks",
      blocks: [
        { type: "tool_use", id: "a", name: "bash", input: { command: `${longPrefix} cat /work/chats/room/outbox/progress.md` } },
      ],
      at,
    },
    {
      role: "user",
      kind: "results",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "a",
          content: `done. full output kept: /work/spill/abc.log see https://example.com/pr/7 commit 4611851ab too, and /work/spill/abc.log again`,
        },
      ],
      at,
    },
  ];
  const anchors = extractAnchors(entries);
  assert.ok(anchors.includes("t42"));
  assert.ok(anchors.some(anchor => anchor.includes("/work/chats/room/outbox/progress.md")), "path beyond a 400-char clip survives");
  assert.ok(anchors.some(anchor => anchor.startsWith("full output kept:")), "spill pointers are anchors");
  assert.ok(anchors.some(anchor => anchor.startsWith("https://example.com")));
  assert.ok(anchors.includes("4611851ab"));
  assert.equal(anchors.filter(anchor => anchor === "/work/spill/abc.log").length, 1, "deduped");

  // Validation: the headings are a check now, not a request.
  assert.deepEqual(missingSummaryHeadings("**Threads** a **Done** b **State** c **Artifacts** d"), []);
  assert.deepEqual(missingSummaryHeadings("**Threads** only"), ["Done", "State", "Artifacts"]);
});

test("extensionless files and absolute paths are anchors too", () => {
  // Audit 2026-09-01, claim 6, measured before the fix: cat Makefile, edits to
  // docker/box/Dockerfile and /etc/hosts all vanished from the anchors of the very
  // repo that builds them — the path pattern demanded a dot-extension.
  const entries: HistoryEntry[] = [
    {
      role: "user",
      text: "ran cat Makefile, edited docker/box/Dockerfile and /etc/hosts, wrote /home/box/work/bin/run",
      at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const anchors = extractAnchors(entries);
  assert.ok(anchors.includes("Makefile"));
  assert.ok(anchors.includes("docker/box/Dockerfile"));
  assert.ok(anchors.includes("/etc/hosts"));
  assert.ok(anchors.includes("/home/box/work/bin/run"));
  // Prose words that merely look file-ish stay out.
  assert.ok(!anchors.some(anchor => anchor === "e.g" || anchor === "etc"));
});

test("a summary provider on the same wire reuses the primary client; a different wire gets its own", () => {
  // docs/24 v3 P0 #6 — the routing half of the review's finding 2. Same wire (the
  // default, and every same-vendor cheaper mapping): the primary client is the
  // client. A different wire must never be reached with the primary's credential.
  const primary = resolveProvider("anthropic");
  const sentinel = { marker: "primary" } as never;
  const same = summaryRuntimeFor(primary, sentinel);
  assert.equal(same.client, sentinel, "same wire, same client");

  const previous = process.env.AGENTBOX_SUMMARY_PROVIDER;
  const previousKey = process.env.MINIMAX_CODE_CN_API_KEY;
  try {
    process.env.AGENTBOX_SUMMARY_PROVIDER = "minimax";
    // Minting a client for the other wire needs *a* credential; which one is not what
    // this test is about. It used to read whatever the developer had exported, which
    // meant the test passed here and could only fail on a machine without the key —
    // the hermetic runner made that visible by taking the ambient environment away.
    process.env.MINIMAX_CODE_CN_API_KEY = "test-key-not-a-real-credential";
    const split = summaryRuntimeFor(primary, sentinel);
    assert.notEqual(split.client, sentinel, "a different wire gets its own client");
    assert.notEqual(split.profile.label, primary.label);
    // Cached: the second resolution reuses the minted client.
    assert.equal(summaryRuntimeFor(primary, sentinel).client, split.client);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_SUMMARY_PROVIDER;
    else process.env.AGENTBOX_SUMMARY_PROVIDER = previous;
    if (previousKey === undefined) delete process.env.MINIMAX_CODE_CN_API_KEY;
    else process.env.MINIMAX_CODE_CN_API_KEY = previousKey;
  }
});

test("the whole request is estimated, and the incompressible floor is named", () => {
  // docs/24 v3 P0 #5: the system prompt and tool schemas were invisible to every
  // earlier estimate, so a fat floor produced rejected requests no compaction could
  // have prevented.
  const messages = [{ role: "user" as const, content: "hi" }];
  const bare = estimateRequestTokens({ messages });
  const withFloor = estimateRequestTokens({
    messages,
    system: [{ text: "x".repeat(2_500) }, { text: "y".repeat(2_500) }],
    tools: [{ name: "computer", input_schema: { properties: { actions: {} } } }],
  });
  assert.equal(bare.floor, 0);
  assert.ok(withFloor.floor >= 2_000, "two 2.5k-char blocks are ~2k tokens of floor");
  assert.equal(withFloor.total - withFloor.floor, bare.total, "history half unchanged");
});

test("the estimate learns from what the wire actually billed", () => {
  const wire = "test-wire|https://example";
  assert.equal(calibratedTokens(wire, 1_000), 1_000, "identity until taught");
  // CJK-shaped reality: the provider bills ~2x our character estimate.
  noteRealInputTokens(wire, 1_000, 2_000);
  const taught = calibratedTokens(wire, 1_000);
  assert.ok(taught > 1_500 && taught <= 2_000, `learned upward, got ${taught}`);
  // Smoothing: one wild sample cannot swing the factor to its own extreme.
  noteRealInputTokens(wire, 1_000, 50_000);
  assert.ok(calibratedTokens(wire, 1_000) < 4_000, "clamped and smoothed");
  // Garbage in, nothing out.
  noteRealInputTokens(wire, 0, 100);
  noteRealInputTokens(wire, 1_000, undefined);
});

test("pinned inputs are leaf-trimmed and the pinned total is capped", () => {
  // Verification review finding 3: a 100KB write_file exemplar is 40k tokens of dead
  // weight; the shape a model imitates survives at 300 chars per string leaf.
  const trimmed = trimInputLeaves({ path: "/a/b.txt", content: "x".repeat(50_000), nested: { note: "y".repeat(500) } }) as {
    content: string; nested: { note: string };
  };
  assert.ok(trimmed.content.length < 400);
  assert.match(trimmed.content, /\[trimmed\]$/);
  assert.ok(trimmed.nested.note.length < 400, "nested leaves trimmed too");
  assert.equal((trimInputLeaves({ n: 5, b: true }) as { n: number }).n, 5, "non-strings untouched");
});

test("anchors keep relative paths whole and hex noise cannot crowd out paths", () => {
  // Verification review finding 6: the old regex matched from any slash, turning
  // src/host/turn.ts into a false-exact /host/turn.ts.
  const at = "2026-08-29T00:00:00Z";
  const hexNoise = Array.from({ length: 20 }, (_, i) => `deadbeef${i}00cafe`).join(" ");
  const entries: HistoryEntry[] = [
    { role: "user", text: `edit src/host/turn.ts and docs/24-context-memory.md ${hexNoise}`, at },
  ];
  const anchors = extractAnchors(entries);
  assert.ok(anchors.includes("src/host/turn.ts"), `whole relative path, got ${JSON.stringify(anchors)}`);
  assert.ok(anchors.includes("docs/24-context-memory.md"));
  assert.ok(!anchors.includes("/host/turn.ts"), "no mangled suffix");
  assert.ok(anchors.filter(a => /^[0-9a-f]+$/.test(a)).length <= 8, "hex capped per category");
});

test("grok round 3: heading dialects pass, shapeless drafts fail, drift is visible", () => {
  // Tolerant recognition: the production model's dialects all count.
  assert.deepEqual(missingSummaryHeadings("## Threads\nx\n## Done\ny\n## State\nz\n## Artifacts\nnone"), []);
  assert.deepEqual(missingSummaryHeadings("threads: a\nDONE: b\nstate: c\nartifacts: none"), []);
  assert.equal(missingSummaryHeadings("just prose").length, 4);

  // Hex must look like a hash, not a word or a number.
  const at = "2026-08-29T00:00:00Z";
  const noise = extractAnchors([{ role: "user", text: "defaced 1000000 accessed 4611851ab", at }]);
  assert.ok(noise.includes("4611851ab"));
  assert.ok(!noise.includes("defaced") && !noise.includes("1000000"), "words and numbers are not commits");

  // URLs shed trailing punctuation; CJK paths match whole.
  const cjk = extractAnchors([{ role: "user", text: "见 (https://x.cn/a), 写入 docs/纪要/会议.md", at }]);
  assert.ok(cjk.includes("https://x.cn/a"));
  assert.ok(cjk.includes("docs/纪要/会议.md"));

  // Drift: a pending whose uncovered tail outgrew twice the tail budget is worth
  // recomputing even while still strictly usable.
  const policy: CompactionPolicy = { triggerTokens: 10_000, keepTailTokens: 200, maxEntries: 320 };
  const grown = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, text: "y".repeat(200), at: `${i}${at}` }));
  const pending = { covers: 2, computedFrom: 4, promise: Promise.resolve(undefined) };
  assert.equal(pendingIsUsable(pending, grown, policy), true, "still usable");
  assert.equal(pendingHasDrifted(pending, grown, policy), true, "but drifted");
  assert.equal(pendingHasDrifted({ ...pending, covers: 11 }, grown, policy), false);
});

test("the guard cools a failing summariser and pauses a thrashing conversation", () => {
  // docs/24 P1 #8, the Hermes #14695 lesson: 'the message list shrank' is not
  // effectiveness — clearing the trigger is.
  const guard = new CompactionGuard();
  const t0 = 1_000_000;
  assert.equal(guard.allowed("c", t0), true);

  guard.noteFailure("c", t0);
  assert.equal(guard.allowed("c", t0 + 1), false, "failure buys a cooldown");
  assert.equal(guard.allowed("c", t0 + CompactionGuard.FAILURE_COOLDOWN_MS + 1), true);

  // Two ineffective passes pause; one effective pass resets everything.
  assert.equal(guard.notePass("c", false, t0), "ineffective");
  assert.equal(guard.notePass("c", true, t0), "ok");
  assert.equal(guard.notePass("c", false, t0), "ineffective", "the streak reset");
  assert.equal(guard.notePass("c", false, t0), "paused");
  assert.equal(guard.allowed("c", t0 + 1), false);
  assert.equal(guard.allowed("c", t0 + CompactionGuard.INEFFECTIVE_PAUSE_MS + 1), true);
  // Conversations are independent.
  assert.equal(guard.allowed("other", t0), true);
});
