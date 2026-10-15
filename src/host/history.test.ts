/**
 * Tests for reading back a compacted history.
 *
 * The two that matter: that the block is not offered when there is nothing hidden, and that reading
 * the history does not pour back the context compaction just removed. Both are ways this feature
 * could quietly defeat the one it exists to complete.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import {
  AROUND_ENTRY_CHARS,
  AROUND_NEIGHBOURS,
  AROUND_TOTAL_CHARS,
  describeHistory,
  hasSummary,
  MAX_ENTRIES,
  parseAnchor,
  readEpochHistory,
  readHistory,
  renderEntry,
  renderHistoryBlock,
  summarisedCount,
} from "./history.ts";

const said = (text: string, role: "user" | "assistant" = "user") => ({
  role,
  text,
  at: "2026-08-20T10:00:00.000Z",
});

const called = (name: string, input: unknown) => ({
  role: "assistant" as const,
  kind: "blocks" as const,
  blocks: [{ type: "tool_use" as const, id: "t1", name, input }],
  at: "2026-08-20T10:00:01.000Z",
});

const returned = (text: string, isError = false) => ({
  role: "user" as const,
  kind: "results" as const,
  blocks: [
    { type: "tool_result" as const, tool_use_id: "t1", content: [{ type: "text" as const, text }], is_error: isError },
  ],
  at: "2026-08-20T10:00:02.000Z",
});

const summary = (covers: number) => ({
  role: "user" as const,
  kind: "summary" as const,
  covers,
  text: `[Summary of the first ${covers} entries]`,
  at: "2026-08-20T10:00:03.000Z",
});

test("the block is offered only when something was actually summarised", () => {
  // A tool advertising access to a history that was never compacted invites a call returning what
  // the agent can already see, which trains it to ignore the tool by the time it is needed.
  assert.equal(renderHistoryBlock([said("hello"), called("bash", {})]), "");
  assert.equal(hasSummary([said("hello")]), false);

  const rendered = renderHistoryBlock([summary(127), said("carry on")]);
  assert.match(rendered, /127 entries replaced/);
  assert.match(rendered, /The originals were not deleted/);
  assert.match(rendered, /ReadHistory/);
  // The reason to bother, said plainly: the two mistakes it prevents.
  assert.match(rendered, /before you conclude something never happened/);
  assert.match(rendered, /repeat work you may already have/);
});

test("the count comes from the newest summary", () => {
  // A conversation compacted twice has two summaries; the second covers the window the first left.
  assert.equal(summarisedCount([summary(50), said("x"), summary(120)]), 120);
  assert.equal(summarisedCount([said("x")]), 0);
});

test("an entry reads as what happened, with its number", () => {
  assert.match(renderEntry(said("do the thing"), 3), /^#3 .* them: do the thing$/);
  assert.match(renderEntry(said("done", "assistant"), 4), /you: done/);

  // The command, not just the tool: "ran bash" without it is exactly the unfalsifiable summary this
  // exists to get behind.
  assert.match(renderEntry(called("bash", { command: "rm -rf /tmp/x" }), 5), /you called bash/);
  assert.match(renderEntry(called("bash", { command: "rm -rf /tmp/x" }), 5), /rm -rf \/tmp\/x/);

  // A failure reads as a failure. A result that says "result:" when the tool errored is how an agent
  // concludes something worked.
  assert.match(renderEntry(returned("no such file", true), 6), /failed: no such file/);
  assert.match(renderEntry(returned("ok"), 6), /result: ok/);

  assert.match(renderEntry(summary(9), 0), /\[summary of 9 earlier entries\]/);
  assert.match(renderEntry(null, 1), /unreadable/);
});

test("reading back does not pour the context back in", () => {
  // The way this feature could defeat the one it completes: a search matching everything, returning
  // everything, undoing the compaction that made room in the first place.
  const entries = Array.from({ length: 200 }, (_, index) =>
    returned(`line ${index} ${"x".repeat(5_000)}`)
  );
  const result = readHistory(entries, { search: "line" });
  assert.equal(result.lines.length, MAX_ENTRIES, "capped");
  assert.equal(result.matched, 200, "and it says how many it did not show");

  // Each line is clamped too, so twenty-five five-thousand-character results is not what comes back.
  for (const line of result.lines) assert.ok(line.length < 800, `line was ${line.length}`);

  const described = describeHistory(result, { search: "line" });
  assert.match(described, /200 entries matched/);
  assert.match(described, /Narrow the search/);
});

test("a search matches all the words, and says so when it matches none", () => {
  const entries = [
    said("the parser broke on nested quotes"),
    said("the deploy went fine"),
    returned("parser: 3 tests failed"),
  ];
  assert.equal(readHistory(entries, { search: "parser" }).matched, 2);
  // All the words, not any: "parser quotes" should not drag in the deploy.
  assert.equal(readHistory(entries, { search: "parser quotes" }).matched, 1);
  assert.equal(readHistory(entries, { search: "PARSER" }).matched, 2, "case-insensitive");

  const nothing = readHistory(entries, { search: "kubernetes" });
  assert.equal(nothing.lines.length, 0);
  const described = describeHistory(nothing, { search: "kubernetes" });
  // Says what kind of search it is, so the agent adjusts its words rather than concluding the thing
  // never happened.
  assert.match(described, /not a search that guesses at meaning/);
});

test("a search returns the newest matches, a range reads in order", () => {
  const entries = Array.from({ length: 60 }, (_, index) => said(`step ${index} parser`));
  const found = readHistory(entries, { search: "parser" });
  // "What did I find out" is almost always the question, not "what did I first try".
  assert.match(found.lines[0] ?? "", /#59/);
  assert.match(found.lines[1] ?? "", /#58/);

  const range = readHistory(entries, { from: 10, to: 14 });
  assert.deepEqual(
    range.lines.map(line => line.split(" ")[0]),
    ["#10", "#11", "#12", "#13"]
  );
  assert.equal(range.matched, 4);
});

test("an empty range says what the transcript actually holds", () => {
  const result = readHistory([said("one")], { from: 50, to: 60 });
  // Rather than an empty answer, which reads as "there is no history".
  assert.match(describeHistory(result, { from: 50 }), /holds 1 entries/);
});

// ---------------------------------------------------------------------------
// Anchors, around and partial hits (INV-1188)

const spoke = (text: string, role: "user" | "assistant" = "user") => ({ role, text, at: "2026-10-14T10:00:00.000Z" });


test("one context version keeps plain #N anchors; several name their version", () => {
  const single = readEpochHistory([{ epoch: 0, entries: [spoke("alpha"), spoke("beta")] }], {});
  assert.match(single.lines[1]!, /^#1 /);
  const multi = readEpochHistory(
    [{ epoch: 0, entries: [spoke("alpha")] }, { epoch: 1, entries: [spoke("beta")] }],
    { search: "beta" }
  );
  assert.match(multi.lines[0]!, /^e1#0 /);
});

test("anchors are parsed in every written form", () => {
  assert.deepEqual(parseAnchor("#42"), { index: 42 });
  assert.deepEqual(parseAnchor("42"), { index: 42 });
  assert.deepEqual(parseAnchor("e1#42"), { epoch: 1, index: 42 });
  assert.deepEqual(parseAnchor("E2 #7"), { epoch: 2, index: 7 });
  assert.equal(parseAnchor("part two"), undefined);
});

test("around shows the entry whole and its neighbours cut, and stays under its cap", () => {
  const long = "x".repeat(AROUND_ENTRY_CHARS - 100);
  const entries = Array.from({ length: 20 }, (_, i) => spoke(i === 10 ? long : `line ${i} ${"y".repeat(900)}`));
  const result = readEpochHistory([{ epoch: 0, entries }], { around: "#10" });
  assert.equal(result.around, "#10");
  const center = result.lines.find(line => line.startsWith("#10 "))!;
  assert.ok(center.includes(long), "the asked-for entry is not cut");
  assert.ok(result.lines.length <= 2 * AROUND_NEIGHBOURS + 1);
  assert.ok(result.lines.join("\n").length <= AROUND_TOTAL_CHARS);
  assert.match(describeHistory(result, { around: "#10" }), /^Around #10/);
});

test("around names what is wrong with a bad or missing anchor", () => {
  const parts = [{ epoch: 0, entries: [spoke("a")] }, { epoch: 1, entries: [spoke("b")] }];
  assert.match(describeHistory(readEpochHistory(parts, { around: "nope" }), { around: "nope" }), /not an entry anchor/);
  assert.match(describeHistory(readEpochHistory(parts, { around: "e1#9" }), { around: "e1#9" }), /no entry e1#9.*e0#0–e0#0, e1#0–e1#0/);
});

test("when no entry holds every word, the ones holding the most come back, best first, and say so", () => {
  const entries = [spoke("deploy staging failed"), spoke("deploy production ok"), spoke("nothing relevant")];
  const query = { search: "deploy staging rollback" };
  const result = readEpochHistory([{ epoch: 0, entries }], query);
  assert.equal(result.partial, true);
  assert.match(result.lines[0]!, /^#0 .*\[2\/3 words\]/);
  assert.match(result.lines[1]!, /^#1 .*\[1\/3 words\]/);
  assert.equal(result.lines.length, 2);
  assert.match(describeHistory(result, query), /No entry holds every word/);
  assert.equal(readEpochHistory([{ epoch: 0, entries }], { search: "deploy staging" }).partial, undefined);
});

test("an anchor survives a restart and a late write into an older version", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-anchor-"));
  try {
    const registry = new AgentRegistry(root);
    const agent = registry.create({ name: "Nova", boxId: registry.box.id });
    registry.appendTranscript(agent.id, spoke("first version"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const late = registry.withContext(agent.id, "main", async () => {
      await gate;
      registry.appendTranscript(agent.id, spoke("late write into version zero", "assistant"));
    });
    registry.contextStore(agent.id).advance("op1", 0);
    registry.appendTranscript(agent.id, spoke("second version, entry zero"));
    const before = readEpochHistory(registry.readContextTranscriptsByEpoch(agent.id), { around: "e1#0" });
    release();
    await late;
    const reopened = new AgentRegistry(root);
    const after = readEpochHistory(reopened.readContextTranscriptsByEpoch(agent.id), { around: "e1#0" });
    const centerOf = (lines: string[]) => lines.find(line => line.startsWith("e1#0 "));
    assert.ok(centerOf(before.lines)?.includes("second version, entry zero"));
    assert.equal(centerOf(after.lines), centerOf(before.lines), "same anchor, same entry");
    const old = readEpochHistory(reopened.readContextTranscriptsByEpoch(agent.id), { around: "e0#1" });
    assert.ok(old.lines.some(line => line.startsWith("e0#1 ") && line.includes("late write")), "the late write is e0#1, not a shift of e1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("from/to count within the current version unless another is named", () => {
  const parts = [{ epoch: 0, entries: [spoke("old a"), spoke("old b")] }, { epoch: 1, entries: [spoke("new a")] }];
  assert.deepEqual(readEpochHistory(parts, { from: 0, to: 5 }).lines.map(line => line.split(" ")[0]), ["e1#0"]);
  assert.deepEqual(readEpochHistory(parts, { from: 0, to: 5, epoch: 0 }).lines.map(line => line.split(" ")[0]), ["e0#0", "e0#1"]);
});

test("an epoch-qualified anchor written before a /new still opens the original entry after it", () => {
  const parts = [{ epoch: 0, entries: [spoke("the original constraint")] }, { epoch: 1, entries: [spoke("the handoff")] }];
  const result = readEpochHistory(parts, { around: "e0#0" });
  assert.ok(result.lines.some(line => line.startsWith("e0#0 ") && line.includes("the original constraint")));
  assert.ok(!result.lines.some(line => line.includes("the handoff")), "not redirected to the newest epoch");
});
