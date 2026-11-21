/**
 * Old tool results left out of a cold request (INV-703): what is cleared, what is kept, and that a
 * warm request is the request it would have been without any of this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { HistoryEntry } from "./compaction.ts";
import {
  clearColdResults,
  clearedResultText,
  EPHEMERAL_CACHE_TTL_MS,
  IMPLICIT_CACHE_TTL_MS,
  KEEP_RECENT_RESULT_GROUPS,
  promptCacheTtlMs,
  recordedResult,
  requestHistory,
} from "./cold-results.ts";
import { resolveProvider } from "./provider.ts";
import { historyToMessages, type TranscriptEntry } from "./turn.ts";

const T0 = Date.parse("2026-11-20T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

/** Shell output as the record keeps it: a head of about two thousand characters and the box's pointer. */
function shellOutput(round: number): string {
  const lines: string[] = [];
  for (let line = 0; lines.join("\n").length < 1_900; line++) {
    lines.push(`  ✔ suite ${round}.${line} passes (${(line * 7) % 97}ms) — src/host/module-${line % 13}.test.ts`);
  }
  return `${lines.join("\n").slice(0, 2_000)}\n[full output kept: /home/box/.spool/out-${round}.log — all 48211 bytes of stdout]`;
}

function fileText(round: number): string {
  return `// src/host/module-${round}.ts\n${"export function step(n: number): number { return n + 1; }\n".repeat(25)}`;
}

/**
 * One long shell-heavy turn, the way a member's record looks after "run the suite and fix what
 * fails": a person's request, then rounds of bash, read_file and list_dir, then a reply. A person's
 * answer to AskUser and a failed command sit among them, and both must survive.
 */
function shellHeavyTurn(rounds = 24): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    { role: "user", text: "Run the suite and fix what fails.", at: iso(T0), fromPerson: true },
  ];
  let clock = T0;
  const step = (blocks: Anthropic.ContentBlockParam[], results: Anthropic.ToolResultBlockParam[]) => {
    clock += 20_000;
    entries.push({ role: "assistant", kind: "blocks", blocks, at: iso(clock) } as TranscriptEntry);
    clock += 15_000;
    entries.push({ role: "user", kind: "results", blocks: results, at: iso(clock) } as TranscriptEntry);
  };
  for (let round = 0; round < rounds; round++) {
    const tool = round % 3 === 0 ? "read_file" : round % 3 === 1 ? "list_dir" : "bash";
    const id = `toolu_${String(round).padStart(3, "0")}`;
    const text = tool === "bash" ? shellOutput(round) : tool === "read_file" ? fileText(round) : "src/\n".repeat(80);
    step(
      [{ type: "tool_use", id, name: tool, input: tool === "bash" ? { command: "npm test" } : { path: `src/host/module-${round}.ts` } }],
      [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }]
    );
    if (round === 2) {
      step(
        [{ type: "tool_use", id: "toolu_ask", name: "AskUser", input: { question: "Skip the flaky one?" } }],
        [{ type: "tool_result", tool_use_id: "toolu_ask", content: [{ type: "text", text: `The person answered: no, fix it. ${"Details follow. ".repeat(60)}` }] }]
      );
      step(
        [{ type: "tool_use", id: "toolu_fail", name: "bash", input: { command: "npm run nope" } }],
        [{ type: "tool_result", tool_use_id: "toolu_fail", is_error: true, content: [{ type: "text", text: `npm ERR! missing script: nope\n${"npm ERR! ".repeat(120)}` }] }]
      );
    }
  }
  clock += 20_000;
  entries.push({ role: "assistant", text: "All green: fixed the two failing suites.", at: iso(clock) });
  return entries;
}

const lastAt = (entries: readonly TranscriptEntry[]) => Date.parse((entries.at(-1) as { at: string }).at);
const resultsOf = (entries: readonly HistoryEntry[]) =>
  entries.flatMap(entry => ("kind" in entry && entry.kind === "results" ? entry.blocks : []));
const textOf = (block: Anthropic.ToolResultBlockParam) => (block.content as Anthropic.TextBlockParam[])[0]!.text;

test("a cold request clears old reading results and keeps the newest groups, the person's answer, errors and every pairing", () => {
  const history = shellHeavyTurn();
  const recordBefore = JSON.stringify(history);
  const now = lastAt(history) + 3 * 60 * MIN;
  const result = clearColdResults(history as HistoryEntry[], { now, ttlMs: EPHEMERAL_CACHE_TTL_MS });

  assert.equal(JSON.stringify(history), recordBefore, "the record is not touched");
  assert.ok(result.cleared > 0);

  const before = resultsOf(history as HistoryEntry[]);
  const after = resultsOf(result.entries);
  assert.equal(after.length, before.length, "every result block is still there");
  assert.deepEqual(after.map(block => block.tool_use_id), before.map(block => block.tool_use_id), "each keeps its call's id, in order");

  const byId = new Map(after.map(block => [block.tool_use_id, block]));
  assert.equal(textOf(byId.get("toolu_ask")!), textOf(before.find(block => block.tool_use_id === "toolu_ask")!), "a person's answer is never cleared");
  assert.equal(byId.get("toolu_fail")!.is_error, true);
  assert.match(textOf(byId.get("toolu_fail")!), /missing script/, "a failure is the lesson and stays");

  const groups = (result.entries as HistoryEntry[]).filter(entry => "kind" in entry && entry.kind === "results");
  for (const group of groups.slice(-KEEP_RECENT_RESULT_GROUPS)) {
    for (const block of (group as { blocks: Anthropic.ToolResultBlockParam[] }).blocks) {
      assert.doesNotMatch(textOf(block), /left out of this request/, "the newest groups are the working set");
    }
  }

  const bash = byId.get("toolu_005")!;
  const original = before.find(block => block.tool_use_id === "toolu_005")!;
  assert.equal(textOf(bash), clearedResultText({ tool: "bash", toolUseId: "toolu_005", chars: textOf(original).length }));
  assert.match(textOf(bash), /ReadKept with call "toolu_005"/);
  assert.match(textOf(bash), new RegExp(textOf(original).length.toLocaleString("en-US")), "it says how long the original was");

  // Every call still has its result next to it, on the wire every adapter starts from.
  const messages = historyToMessages(result.entries as TranscriptEntry[]);
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]!.content;
    if (typeof content === "string") continue;
    const uses = content.filter(block => block.type === "tool_use").map(block => (block as Anthropic.ToolUseBlockParam).id);
    if (uses.length === 0) continue;
    const next = messages[index + 1]!.content as Anthropic.ContentBlockParam[];
    const answered = next.filter(block => block.type === "tool_result").map(block => (block as Anthropic.ToolResultBlockParam).tool_use_id);
    assert.deepEqual(answered, uses);
  }
});

test("within the cache's lifetime the request is byte-identical to the one sent without this", () => {
  const history = shellHeavyTurn();
  const anthropic = resolveProvider("anthropic");
  const warm = requestHistory(history, anthropic, lastAt(history) + 4 * MIN);
  assert.equal(JSON.stringify(historyToMessages(warm)), JSON.stringify(historyToMessages(history)));
});

test("once cleared on a cold wake, the turn's later requests and the next warm turn send the same prefix", () => {
  const anthropic = resolveProvider("anthropic");
  const history = shellHeavyTurn();
  const wake = lastAt(history) + 3 * 60 * MIN;
  const cold = historyToMessages(requestHistory(history, anthropic, wake));
  assert.ok(JSON.stringify(cold).includes("left out of this request"));

  // The wake is recorded, the turn goes on, and a request a minute later rebuilds from the record.
  const later: TranscriptEntry[] = [
    ...history,
    { role: "user", text: "[agent] Ada: is the suite green?", at: iso(wake + 5) },
    { role: "assistant", text: "Yes.", at: iso(wake + 30_000) },
  ];
  const warm = historyToMessages(requestHistory(later, anthropic, wake + MIN));
  assert.equal(JSON.stringify(warm.slice(0, cold.length)), JSON.stringify(cold), "the prefix the cold request cached is sent again unchanged");
});

test("the idle threshold is the provider's cache lifetime", () => {
  assert.equal(promptCacheTtlMs(resolveProvider("anthropic")), EPHEMERAL_CACHE_TTL_MS);
  const minimax = resolveProvider("minimax");
  assert.equal(promptCacheTtlMs(minimax), IMPLICIT_CACHE_TTL_MS);
  assert.equal(promptCacheTtlMs({ promptCaching: false }), undefined);

  const history = shellHeavyTurn();
  const sent = (provider: Parameters<typeof requestHistory>[1], idle: number) =>
    JSON.stringify(historyToMessages(requestHistory(history, provider, lastAt(history) + idle)));
  const verbatim = JSON.stringify(historyToMessages(history));
  assert.equal(sent(minimax, 10 * MIN), verbatim, "ten minutes idle on an implicit cache: untouched");
  assert.notEqual(sent(minimax, 61 * MIN), verbatim, "sixty-one: cleared");
  assert.equal(sent({ ...minimax, implicitCaching: false, model: "x" }, 24 * 60 * MIN), verbatim, "no cache we know of: idle time means nothing");
});

test("a saving too small to matter leaves the request alone", () => {
  const history = shellHeavyTurn(KEEP_RECENT_RESULT_GROUPS + 2).map(entry =>
    "kind" in entry && entry.kind === "results"
      ? ({ ...entry, blocks: entry.blocks.map(block => ({ ...block, content: [{ type: "text" as const, text: "ok ".repeat(70) }] })) } as TranscriptEntry)
      : entry
  );
  const result = clearColdResults(history as HistoryEntry[], { now: lastAt(history) + 60 * MIN, ttlMs: EPHEMERAL_CACHE_TTL_MS });
  assert.equal(result.cleared, 0);
  assert.equal(result.entries, history);
});

test("near the compaction trigger a warm request is cleared too", () => {
  const history = shellHeavyTurn(140);
  const anthropic = resolveProvider("anthropic");
  const warm = requestHistory(history, anthropic, lastAt(history) + MIN);
  assert.ok(JSON.stringify(warm).includes("left out of this request"));
});

test("what a request may leave out, the record gives back by the call's id", () => {
  const history = shellHeavyTurn();
  const original = resultsOf(history as HistoryEntry[]).find(block => block.tool_use_id === "toolu_005")!;
  assert.equal(recordedResult(history, "toolu_005")?.text, textOf(original));
  assert.equal(recordedResult(history, "toolu_ask"), undefined, "a person's answer was never cleared, so it is not served from here");
  assert.equal(recordedResult(history, "toolu_never"), undefined);
});

test("the saving on an idle wake after a long shell-heavy turn", () => {
  const history = shellHeavyTurn(40);
  const before = Buffer.byteLength(JSON.stringify(historyToMessages(history)));
  const after = Buffer.byteLength(JSON.stringify(historyToMessages(requestHistory(history, resolveProvider("anthropic"), lastAt(history) + 3 * 60 * MIN))));
  console.log(`# idle wake after a 40-round shell-heavy turn: ${before} bytes verbatim, ${after} cleared (${Math.round((1 - after / before) * 100)}% smaller)`);
  assert.ok(after < before / 2, "most of an old shell-heavy turn is output nobody needs re-sent");
});
