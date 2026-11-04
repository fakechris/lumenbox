/** One summary call is given what fits, however long a never-compacted record is (INV-1570). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummaryPrompt, CHARS_PER_TOKEN, estimateTokens, extractAnchors, noteContextWindow, policyForModel, type HistoryEntry } from "./compaction.ts";
import { boundSummaryInput, pathologicalSummaryTokens, summaryInputFor } from "./summary-input.ts";

const MODEL = "fixture-summary-input-model";
noteContextWindow(MODEL, 200_000); // trigger 130k tokens, as a real 200k-window model has

const at = "2026-11-04T00:00:00Z";
const said = (i: number, size = 800): HistoryEntry => ({ role: i % 2 ? "assistant" : "user", text: `entry ${i} see src/host/file${i}.ts ${"z".repeat(size)}`, at });

test("30k earlier entries: the prompt stays within the model's budget, keeps the newest, and says what was left out", () => {
  const entries = Array.from({ length: 30_000 }, (_, i) => said(i)); // ~10M chars, far past any window
  const trigger = policyForModel(MODEL).triggerTokens;
  assert.ok(estimateTokens(entries) > pathologicalSummaryTokens(trigger), "the fixture is pathological");
  const bounded = summaryInputFor(entries, MODEL);
  assert.ok(bounded.omitted > 29_000, `most were left out: ${bounded.omitted}`);
  assert.ok(estimateTokens(bounded.entries) <= trigger + 200, "the given part fits the trigger (plus the note)");
  const prompt = buildSummaryPrompt(bounded.entries);
  assert.ok(prompt.length <= trigger * CHARS_PER_TOKEN + 6_000, `prompt ${prompt.length} characters`);
  assert.match(prompt, /entry 29999 /, "the newest entry is there");
  assert.match(prompt, /host: \[\d+ earlier entries were left out: this history was too long to summarise in one pass/);
  const anchors = extractAnchors(bounded.entries);
  assert.ok(anchors.length > 0 && !anchors.some(anchor => /file\d{1,3}\.ts$/.test(anchor)), "anchors come from the part given, none from what was left out");
});

test("an ordinary pass is given everything, exactly as before", () => {
  const entries = Array.from({ length: 400 }, (_, i) => said(i));
  const bounded = summaryInputFor(entries, MODEL);
  assert.equal(bounded.entries, entries, "the same array: nothing rebuilt, nothing left out");
  assert.equal(bounded.omitted, 0);
});

test("a previous summary at the front is always kept, and updated rather than dropped", () => {
  const previous: HistoryEntry = { role: "assistant", kind: "summary", text: "**Threads**\n- old work, finished", covers: 10, at } as unknown as HistoryEntry;
  const bounded = boundSummaryInput([previous, ...Array.from({ length: 100 }, (_, i) => said(i))], 5_000);
  assert.equal(bounded.entries[0], previous);
  assert.ok(bounded.omitted > 0);
  assert.match(buildSummaryPrompt(bounded.entries), /^[\s\S]*PREVIOUS SUMMARY — update it[\s\S]*left out[\s\S]*entry 99 /);
});
