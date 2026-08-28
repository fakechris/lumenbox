/**
 * Tests for the pitfall registry.
 *
 * The risk this kind carries is not that it misses a lesson — it is that it fills with
 * noise, because every line here is read on every future turn and crowds out what matters.
 * That is the ground on which `memory.ts` rejected a "profile" tier, so the tests are
 * weighted toward what must *not* be written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPitfallPrompt, parsePitfall } from "./pitfalls.ts";
import { MEMORY_CHAR_BUDGET, recall, scoreOf } from "./memory.ts";
import type { MemoryRecord } from "./memory.ts";

const LESSON =
  "A page that returns 200 with an empty table may be a logged-out view — check for the login wall before parsing.";

test("a distilled lesson becomes a pitfall record that says where it came from", () => {
  const record = parsePitfall(LESSON, "blocked", new Date("2026-08-29T00:00:00Z"))!;
  assert.equal(record.kind, "pitfall");
  assert.equal(record.text, LESSON);
  assert.equal(record.source, "pitfall:blocked", "a person reading the file can see which event taught it");
});

test("the distiller is allowed to find nothing, and its refusal is honoured", () => {
  // Most failures are ordinary. An extractor that must produce output invents, and an
  // invented hazard is worse than a missing one because it is read forever.
  assert.equal(parsePitfall("NOTHING", "loop"), undefined);
  assert.equal(parsePitfall("  nothing.  ", "loop"), undefined);
  assert.equal(parsePitfall("NOTHING\nthe task was about a spreadsheet", "loop"), undefined);
  assert.equal(parsePitfall("", "loop"), undefined);
});

test("a reply that ignored the brief is dropped rather than trimmed into shape", () => {
  // Too short to be a lesson: an interjection, not something a stranger could use.
  assert.equal(parsePitfall("It failed.", "audit-returned"), undefined);
  assert.equal(parsePitfall("Timed out", "loop"), undefined);
  // Longer than a memory record may be. A pitfall that needs a paragraph is a document
  // with a fact pointing at it, and letting it through would blow the prompt budget that
  // every other memory competes inside.
  assert.equal(parsePitfall("x".repeat(600), "blocked"), undefined);
});

test("list markers and preamble numbering are stripped, and only the first line is kept", () => {
  const record = parsePitfall(`- ${LESSON}\n- and another thought entirely`, "loop")!;
  assert.equal(record.text, LESSON, "the marker goes and the second line does not arrive");
  assert.equal(parsePitfall(`1. ${LESSON}`, "loop")!.text, LESSON);
});

test("the prompt tells the model what disqualifies a lesson, not only what qualifies", () => {
  const prompt = buildPitfallPrompt({
    source: "audit-returned",
    attempt: "整理 Q3 报表",
    detail: "the reviewer found rows silently dropped",
  });
  assert.match(prompt, /an independent reviewer sent the work back/, "the event is named for the model");
  assert.match(prompt, /NOTHING/, "the sentinel is offered");
  // The answer-agnostic rule, which is the whole difference between a pitfall and a fact
  // about one task.
  assert.match(prompt, /this file, this site, this account, this number/);
  assert.match(prompt, /整理 Q3 报表/);
  assert.match(prompt, /rows silently dropped/);
});

test("a pitfall outranks a same-age note and yields to an episode", () => {
  const at = new Date("2026-08-29T00:00:00Z").toISOString();
  const now = Date.parse("2026-08-29T00:00:00Z");
  const of = (kind: MemoryRecord["kind"]): number => scoreOf({ at, kind, text: "x" }, now);
  assert.ok(of("pitfall") > of("fact"), "about to be walked into beats a preference");
  assert.ok(of("pitfall") > of("note"));
  assert.ok(of("pitfall") < of("episode"), "a summary standing in for many facts still leads");
});

test("a pitfall is still recalled when a note of the same age has decayed past it", () => {
  // Ninety days on: the note has lost most of its claim on the prompt, the pitfall has
  // barely moved. A hazard is true until the thing that caused it changes, and nothing
  // here can tell that it did.
  const old = new Date("2026-06-01T00:00:00Z").toISOString();
  const now = Date.parse("2026-08-30T00:00:00Z");
  const records: MemoryRecord[] = [
    { at: old, kind: "note", text: "They asked about the quarterly numbers on Tuesday." },
    { at: old, kind: "pitfall", text: LESSON, source: "pitfall:blocked" },
  ];
  const shown = recall(records, MEMORY_CHAR_BUDGET, now).records.map(record => record.text);
  assert.equal(shown[0], LESSON, "the hazard leads");
  // And under a budget that fits only one line, the hazard is the one that survives.
  const tight = recall(records, LESSON.length + 4, now).records.map(record => record.text);
  assert.deepEqual(tight, [LESSON]);
});
