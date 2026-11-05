/** Memory found by what it is about, not only by its words (INV-1580), measured on the fixtures. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_FIXTURES } from "./memory-fixtures.ts";
import { dedupe, selectRelevant, type MemoryRecord } from "./memory.ts";
import { rankRelated, recallMatches, stem, termsOf } from "./memory-relevance.ts";

const hits = (query: string, records: readonly MemoryRecord[], required: readonly string[], k: number, meaning: boolean) =>
  required.filter(text => selectRelevant(query, dedupe(records), k, { meaning }).some(record => record.text === text)).length;

test("paraphrased questions find the note written in other words; word overlap alone did not", () => {
  const cases = MEMORY_FIXTURES.filter(f => f.shape === "paraphrase");
  let before = 0, after = 0, required = 0;
  for (const fixture of cases) {
    required += fixture.required.length;
    before += hits(fixture.query, fixture.records, fixture.required, 3, false);
    after += hits(fixture.query, fixture.records, fixture.required, 3, true);
  }
  console.log(`[relevance] paraphrase hits@3: words only ${before}/${required}, with stems and concepts ${after}/${required}`);
  assert.equal(after, required, "every paraphrased note is in the top three");
  assert.ok(before <= required - 4, `the cases are real paraphrases: word overlap alone found ${before}/${required}`);
});

test("on every other fixture, nothing word overlap found is lost", () => {
  for (const fixture of MEMORY_FIXTURES.filter(f => f.shape !== "paraphrase" && f.shape !== "wrong-box")) {
    const k = 5;
    // The same records, not only as many: a different required record found would hide one lost.
    const found = (meaning: boolean) => new Set(selectRelevant(fixture.query, dedupe(fixture.records), k, { meaning }).map(record => record.text).filter(text => fixture.required.includes(text)));
    const after = found(true);
    for (const text of found(false)) assert.ok(after.has(text), `${fixture.id}: "${text}" was in the top ${k} by words and is not now`);
  }
});

test("stems meet, concepts cross languages, and the order is deterministic", () => {
  assert.equal(stem("thursdays"), "thursday");
  assert.equal(stem("replies"), "reply");
  assert.equal(stem("class"), "class", "a double s is not a plural");
  assert.ok(termsOf("我们的数据库是什么").has(`c:${[...termsOf("database").keys()].find(t => t.startsWith("c:"))!.slice(2)}`), "数据库 and database share a concept");
  assert.equal(termsOf("database", false).size, 1, "words only: no stem or concept terms");
  const records: MemoryRecord[] = [
    { at: "2026-09-01T00:00:00.000Z", kind: "fact", text: "the release runbook is docs/release.md" },
    { at: "2026-09-02T00:00:00.000Z", kind: "fact", text: "the release checklist is in the wiki" },
  ];
  const once = rankRelated("where is the release doc", records).map(r => r.record.text);
  assert.deepEqual(rankRelated("where is the release doc", [...records].reverse()).map(r => r.record.text), once, "input order does not decide");
  assert.deepEqual(selectRelevant("unrelated words entirely", records, 2), [], "no shared term, nothing related");
});

test("Recall: every-word matches as before, then related-by-meaning; words only when meaning is off", () => {
  const entry = (text: string, at: string) => ({ record: { at, kind: "fact" as const, text }, tier: "yours" });
  const entries = [entry("the deployment region is eu-west-1", "2026-09-01T00:00:00.000Z"), entry("we ship from eu-west-1 on Fridays", "2026-09-02T00:00:00.000Z"), entry("Mia prefers Slack", "2026-09-03T00:00:00.000Z")];
  const both = recallMatches("ship region", entries);
  assert.deepEqual(both.exact, [], "no record holds both words");
  assert.deepEqual(both.related.map(e => e.record.text).sort(), ["the deployment region is eu-west-1", "we ship from eu-west-1 on Fridays"], "both are about it");
  const exact = recallMatches("eu-west-1", entries);
  assert.equal(exact.exact.length, 2, "every-word matching is unchanged");
  assert.deepEqual(exact.related, [], "and an exact match is not listed twice");
  assert.deepEqual(recallMatches("ship region", entries, { meaning: false }).related, [], "with meaning off, words only");
  assert.equal(recallMatches("", entries).exact.length, 3, "an empty search is everything, as before");
});
