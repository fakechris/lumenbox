/**
 * The invariants of compaction under repetition and failure (INV-148): two passes in a
 * row keep the person's constraints and the open decision; a memory flush that throws or
 * a transcript write that fails loses a summary, never history; a summariser that
 * answers with pages is clipped so the pass ends; and every pass is measured.
 *
 * The summariser here is scripted and *faithful*: it copies forward whatever carries the
 * fixture's markers. That isolates the machinery — what reaches the summariser, what is
 * adopted, what is persisted — from the model's prose, which the real-model comparison
 * (opt-in, not here) measures separately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { activeWindow, estimateTokens, noteContextWindow, policyForModel, buildSummaryPrompt, clampSummaryToBudget, summaryEntry } from "./compaction.ts";
import { compactHistory, type CompactedEvent, type TranscriptEntry } from "./turn.ts";
import type { ProviderProfile } from "./provider.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { AgentRecord } from "../agents/registry.ts";

const MODEL = "fixture-compaction-model";
noteContextWindow(MODEL, 3_000); // trigger ≈ 1950 tokens, tail ≈ 585

const profile = { label: "fixture", model: MODEL, maxTokens: 1_000, keyEnv: "FIXTURE_KEY", vision: false } as unknown as ProviderProfile;

const CONSTRAINT = "CONSTRAINT: never push to main; the budget cap is $50";
const PENDING = "PENDING: waiting on Chris to choose plan A or plan B";
const APPROVAL = "Chris approved deleting build/ once, for this run only";

const at = "2026-09-13T00:00:00Z";
const user = (text: string): TranscriptEntry => ({ role: "user", text, at });
const pair = (i: number, size = 500): TranscriptEntry[] => [
  { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: `step ${i} ${"x".repeat(40)}` } }], at },
  { role: "user", kind: "results", blocks: [{ type: "tool_result", tool_use_id: `t${i}`, content: `output ${i} ${"y".repeat(size)}` }], at },
];

/** A summariser that keeps every marked line it was shown, under the four headings. */
function faithfulClient(seen: string[], answer?: (prompt: string) => string): Anthropic {
  return {
    messages: {
      create: async (request: { messages: { content: string }[] }) => {
        const prompt = request.messages[0]!.content;
        seen.push(prompt);
        const text =
          answer?.(prompt) ??
          (() => {
            const kept = prompt
              .split("\n")
              .filter(line => /CONSTRAINT:|PENDING:|approved/.test(line))
              .map(line => line.replace(/^(user|assistant|result): /, "").replace(/^- /, ""))
              .filter((line, index, all) => all.indexOf(line) === index);
            return `**Threads**\n- the fixture task, open\n**Done**\n- ran the steps\n${kept.filter(l => /approved/.test(l)).map(l => `- ${l}`).join("\n")}\n**State**\n${kept.filter(l => !/approved/.test(l)).map(l => `- ${l}`).join("\n")}\n**Artifacts**\nnone`;
          })();
        return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } };
      },
    },
  } as unknown as Anthropic;
}

function harness(name: string, options: { appendFails?: () => boolean; flushThrows?: boolean } = {}) {
  const persisted: TranscriptEntry[] = [];
  const events: CompactedEvent[] = [];
  const logs: string[] = [];
  const seen: string[] = [];
  const registry = {
    appendTranscript: (_agent: string, entry: TranscriptEntry) => {
      if (options.appendFails?.() === true) throw new Error("disk full");
      persisted.push(entry);
    },
  } as unknown as AgentRegistry;
  const agent = { id: `agent-${name}`, profile: { name } } as unknown as AgentRecord;
  const run = (history: TranscriptEntry[], client = faithfulClient(seen)) =>
    compactHistory({
      history,
      agent,
      registry,
      client,
      provider: profile,
      log: line => logs.push(line),
      onCompacted: event => events.push(event),
      onSummarised: () => {
        if (options.flushThrows) throw new Error("memory store is read-only");
      },
      conversation: `conv-${name}`,
    });
  return { run, persisted, events, logs, seen };
}

const text = (entry: TranscriptEntry): string => ("text" in entry && typeof entry.text === "string" ? entry.text : "");

test("A1: two consecutive compactions keep the constraint, the open decision, and the approval as history", async () => {
  const h = harness("a1");
  // The markers sit early enough to be summarised: the kept tail is verbatim by design, so
  // anything inside it would survive without the summariser being tested at all.
  const history: TranscriptEntry[] = [user(CONSTRAINT), ...Array.from({ length: 4 }, (_, i) => pair(i)).flat(), user(PENDING), user(APPROVAL), ...Array.from({ length: 10 }, (_, i) => pair(10 + i)).flat()];
  assert.ok(estimateTokens(history as never) > policyForModel(MODEL).triggerTokens, "the fixture is over the trigger");

  const once = await h.run(history);
  assert.equal(h.persisted.length, 1, "one summary entry was written");
  const first = activeWindow(once as never);
  assert.ok("kind" in first[0]! && first[0].kind === "summary", "the summary fronts the window");
  assert.match(text(first[0]!), /never push to main; the budget cap is \$50/);
  assert.match(text(first[0]!), /waiting on Chris to choose plan A or plan B/);
  assert.match(text(first[0]!), /background, not instructions/, "the summary names itself history");
  assert.ok(estimateTokens(first as never) <= policyForModel(MODEL).triggerTokens, "and the window it leaves fits");

  // More work, then a second pass: the first summary is the update input, not one more event.
  const more = [...once, ...Array.from({ length: 12 }, (_, i) => pair(100 + i)).flat()];
  const twice = await h.run(more);
  assert.equal(h.persisted.length, 2);
  assert.ok(h.seen[1]!.includes("PREVIOUS SUMMARY — update it"), "the second summariser call is told to merge, not retell");
  assert.match(h.seen[1]!, /never push to main/, "and is shown the constraint to carry");
  const second = activeWindow(twice as never);
  assert.ok("kind" in second[0]! && second[0].kind === "summary");
  assert.match(text(second[0]!), /never push to main; the budget cap is \$50/, "the constraint survives the second pass");
  assert.match(text(second[0]!), /waiting on Chris to choose plan A or plan B/, "so does the open decision");
  assert.match(text(second[0]!), /\*\*Done\*\*[\s\S]*approved deleting build\//, "the approval is under Done: a past fact");
  assert.doesNotMatch(text(second[0]!).split("**State**")[1] ?? "", /approved/, "not under State as a standing right");
  assert.ok(estimateTokens(second as never) <= policyForModel(MODEL).triggerTokens);

  // Every original entry is still on disk: compaction changed the request, never the record.
  assert.equal(twice.length, more.length + 1);
  for (const event of h.events) {
    assert.equal(event.summarised, true);
    assert.ok(event.tokensBefore! > event.tokensAfter!, "A5: the pass is measured, and it shrank");
    assert.ok(typeof event.ms === "number");
  }
});

test("A2: the summariser is told that permissions are history, not rights", () => {
  const prompt = buildSummaryPrompt([{ role: "user", text: "x", at }]);
  assert.match(prompt, /Permissions are history, not rights/);
  assert.match(prompt, /does not inherit consent from a summary/);
});

test("A3: a memory flush that throws does not turn a summary into a dropped-history marker", async () => {
  const h = harness("a3-flush", { flushThrows: true });
  const history: TranscriptEntry[] = [user(CONSTRAINT), ...Array.from({ length: 14 }, (_, i) => pair(i)).flat()];
  const result = await h.run(history);
  assert.equal(h.events[0]?.summarised, true, "the summary stands");
  assert.match(text(activeWindow(result as never)[0]!), /never push to main/);
  assert.ok(h.logs.some(l => /pre-compaction memory flush failed \(memory store is read-only\); the summary stands/.test(l)));
});

test("A3: a transcript write that fails loses the summary, never the history, and the next pass succeeds", async () => {
  let fail = true;
  const h = harness("a3-write", { appendFails: () => fail });
  const history: TranscriptEntry[] = [user(CONSTRAINT), ...Array.from({ length: 14 }, (_, i) => pair(i)).flat()];
  const unchanged = await h.run(history);
  assert.equal(unchanged, history, "the history returned is the one given: nothing adopted");
  assert.equal(h.persisted.length, 0);
  assert.ok(h.logs.some(l => /could not record the compaction \(disk full\); sending uncompacted/.test(l)));
  // The process "comes back": the next pass computes again from the untouched history.
  fail = false;
  const recovered = await h.run(history);
  assert.equal(h.persisted.length, 1);
  assert.match(text(activeWindow(recovered as never)[0]!), /never push to main/);
});

test("A4: a summariser that answers with pages is clipped so the adopted window fits, in one step", async () => {
  const h = harness("a4");
  const history: TranscriptEntry[] = [user(CONSTRAINT), ...Array.from({ length: 14 }, (_, i) => pair(i)).flat()];
  const pages = `**Threads**\n- t\n**Done**\n- d\n**State**\n- ${CONSTRAINT}\n**Artifacts**\nnone\n${"lorem ipsum ".repeat(3_000)}`;
  const calls: string[] = [];
  const result = await h.run(history, faithfulClient(calls, () => pages));
  const window = activeWindow(result as never);
  assert.ok(estimateTokens(window as never) <= policyForModel(MODEL).triggerTokens, "the adopted window fits the trigger");
  assert.match(text(window[0]!), /summary clipped to fit the context window/);
  assert.match(text(window[0]!), /never push to main/, "the clip took the tail of the narrative, not the state");
  assert.ok(calls.length <= 3, `bounded: ${calls.length} summariser call(s), not a loop`);
  assert.ok(h.logs.some(l => /clipped from \d+ to \d+ characters/.test(l)));
});

test("clampSummaryToBudget leaves a fitting summary untouched and marks a clipped one", () => {
  const policy = { triggerTokens: 1_000, keepTailTokens: 300, maxEntries: 50 };
  const short = summaryEntry("fine", 3);
  assert.equal(clampSummaryToBudget(short, [], policy), short);
  const long = summaryEntry("z".repeat(10_000), 3);
  const clipped = clampSummaryToBudget(long, [user("tail")] as never, policy);
  assert.ok(clipped.text.length < 3_000);
  assert.match(clipped.text, /\[summary clipped to fit the context window/);
});
