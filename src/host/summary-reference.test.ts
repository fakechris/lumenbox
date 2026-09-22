/**
 * Tests for a summary that can be traced to what it replaced.
 *
 * `covers` said how many entries a summary stood in for and never which, so a claim in a
 * summary had nowhere to walk back to. The entries were always still in the transcript —
 * compaction changes what is sent, never what is stored — which made the summary honest
 * but not auditable. These tests are about the difference.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choosePinnedEntries,
  droppedEntry,
  extractAnchors,
  MAX_SUMMARY_GENERATIONS,
  parseSummaryReference,
  replacedRange,
  summaryEntry,
  summaryReference,
  type HistoryEntry,
  type SummaryEntry,
} from "./compaction.ts";

const said = (text: string, turnId?: string): HistoryEntry =>
  ({ role: "user", text, at: "2026-09-22T10:00:00.000Z", ...(turnId !== undefined ? { turnId } : {}) }) as HistoryEntry;

test("a summary names the range it replaced, the turns in it, and how many folds it has had", () => {
  const entries = [said("one", "turn-a"), said("two", "turn-a"), said("three", "turn-b")];
  const replaced = replacedRange(entries, 0);
  assert.deepEqual(replaced, { from: 0, to: 3, turnIds: ["turn-a", "turn-b"], generation: 1 });

  const entry = summaryEntry("They discussed the report.", 3, new Date("2026-09-22T11:00:00Z"), replaced);
  assert.deepEqual(entry.replaced, replaced);
  // The reference is machine-readable and sits ahead of the prose, so a later clip of the
  // summary body cannot take it.
  const line = summaryReference(replaced);
  assert.equal(line, "[summarises entries 0-3, turns turn-a turn-b; generation 1]");
  assert.ok(entry.text.indexOf(line) < entry.text.indexOf("They discussed the report."));
  assert.deepEqual(parseSummaryReference(entry.text), replaced);
});

test("a summary of summaries counts its generations", () => {
  const first = summaryEntry("first pass", 10, new Date(), replacedRange([said("a"), said("b")], 0));
  assert.equal(first.replaced!.generation, 1);

  // Folding a stretch that already contains a summary is the second generation, and so on.
  const second = replacedRange([first as HistoryEntry, said("c")], 0);
  assert.equal(second.generation, 2);
  const third = replacedRange([summaryEntry("second pass", 4, new Date(), second) as HistoryEntry], 0);
  assert.equal(third.generation, 3);
});

test("past the generation limit a summary is carried through instead of folded again", () => {
  // Nobody bounds this. Repeat compaction summarises the previous summary, and each pass
  // is one step further from the events. Past the limit the honest move is to stop.
  const worn = summaryEntry("paraphrase of a paraphrase", 40, new Date(), {
    from: 0,
    to: 40,
    generation: MAX_SUMMARY_GENERATIONS,
  });
  const fresh = summaryEntry("still close to the events", 4, new Date(), { from: 0, to: 4, generation: 1 });

  const pinned = choosePinnedEntries([worn as HistoryEntry, fresh as HistoryEntry, said("hello")], []);
  assert.ok(pinned.includes(worn as HistoryEntry), "the worn-out summary survives verbatim");
  assert.ok(!pinned.includes(fresh as HistoryEntry), "a young one is still fair game");
});

test("a failed summarisation still says what it stood in for", () => {
  // "These entries were dropped" is a poor record. The range and the turns make it usable.
  const entry: SummaryEntry = {
    ...droppedEntry(340, "the summariser refused"),
    replaced: replacedRange([said("x", "turn-q"), said("y", "turn-q")], 0),
  };
  assert.equal(entry.replaced!.turnIds!.length, 1);
  assert.match(entry.text, /dropped to fit the context/);
});

test("every evidence pointer reaches the summary, however many there were", () => {
  // The caps exist so hex noise cannot crowd out real artefact paths. A pointer to the
  // whole of something that was cut is the opposite of noise, and fifteen pages used to
  // become ten with no sign of the other five.
  const entries: HistoryEntry[] = [];
  for (let n = 0; n < 15; n++) {
    entries.push({
      role: "user",
      kind: "results",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${n}`,
          content: [{ type: "text", text: `body\n[full output kept: /home/.agentbox/results/2026-09/t-${n}.txt]` }],
        },
      ],
      at: "2026-09-22T10:00:00.000Z",
    } as HistoryEntry);
  }
  const anchors = extractAnchors(entries);
  for (let n = 0; n < 15; n++) {
    assert.ok(
      anchors.some(anchor => anchor.includes(`/results/2026-09/t-${n}.txt`)),
      `pointer ${n} did not reach the summary`
    );
  }
});

test("the reference reads back even when there were no turn ids to record", () => {
  const replaced = { from: 12, to: 60, generation: 2 };
  assert.equal(summaryReference(replaced), "[summarises entries 12-60; generation 2]");
  assert.deepEqual(parseSummaryReference(`x ${summaryReference(replaced)} y`), replaced);
  assert.equal(parseSummaryReference("no reference here"), undefined);
});
