/**
 * The extractor's decisions (INV-733): create, confirm or correct, each resting on a quote of the
 * person's own words.
 *
 * What must hold: an item whose quote is not in what the person said is not kept, whoever's words
 * it is in; a target is one of the lines offered in this call or nothing; a reply that is partly
 * garbage loses the garbage and keeps the rest; and the ledger lines each decision becomes are
 * append-only — a confirm is the same record again, dated now, and a correction is a withdrawal
 * followed by its replacement. The extractor is still allowed to find nothing, which is the
 * easiest of these to get wrong and the most expensive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupe, MAX_RECORD_CHARS, type MemoryRecord, recall, scoreOf } from "./memory.ts";
import { buildExtractionPrompt, describeDrops, MAX_FROM, parseExtraction, quoteInTheirWords, recordsOfExtraction } from "./memory-extract.ts";

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
/** A note as the plain-line extractor wrote it before INV-733: no op, no quote, maybe no `from`. */
const old = (text: string, day = 1, from?: string[]): MemoryRecord => ({ at: at(day), kind: "note", text, source: "extracted", ...(from !== undefined ? { from } : {}) });
const line = (value: Record<string, unknown>) => JSON.stringify(value);

const SAID = "我们团队用 pnpm。发版都在周五下午，不是周四";
const one = (candidates: MemoryRecord[] = [], said: (string | undefined)[] = [SAID], refs = ["main@2026-09-06T10:00"], live = candidates) => ({ candidates, said, refs, live });

test("an extractor is allowed to find nothing, and the prompt asks for that first", () => {
  for (const reply of ["NOTHING", "  nothing  ", "NOTHING to keep here", "", "(NOTHING)", "**Nothing**", "- nothing."]) {
    assert.deepEqual(parseExtraction(reply, one()), { items: [], dropped: {} }, reply);
  }
  const prompt = buildExtractionPrompt("They said: x", []);
  assert.match(prompt, /^Below is part of a conversation/);
  assert.match(prompt, /Reply with NOTHING and nothing else unless/);
  assert.match(prompt, /\(nothing yet\)/);
});

test("the prompt offers the remembered lines by number and asks for a quote of their words", () => {
  const prompt = buildExtractionPrompt("They said: x", [old("they deploy on Fridays"), old("they use npm")]);
  assert.match(prompt, /K1\. they deploy on Fridays\nK2\. they use npm/);
  assert.match(prompt, /"op":"create"/);
  assert.match(prompt, /"correct" only\n {2}when they said a K line was wrong/);
  assert.match(prompt, /copied exactly from a line headed `They said`/);
  assert.doesNotMatch(prompt, /change of state comes/i);
  assert.match(buildExtractionPrompt("x", [], { stateChangesFirst: true }), /change of state comes/i);
});

test("a create, a confirm and a correction, each by a target this call offered", () => {
  const candidates = [old("they deploy on Thursdays"), old("they use pnpm", 2, ["main@2026-09-02T10:00"])];
  const parsed = parseExtraction([
    line({ op: "correct", target: "K1", text: "they release on Friday afternoons", quote: "发版都在周五下午，不是周四" }),
    line({ op: "confirm", target: 2, text: "whatever", quote: "我们团队用 pnpm" }),
    line({ op: "create", text: "their team uses pnpm for everything", quote: "我们团队用 pnpm。发版都在周五" }),
  ].join("\n"), one(candidates));
  assert.deepEqual(parsed.dropped, {});
  assert.deepEqual(parsed.items.map(item => [item.op, item.text, item.target?.text]), [
    ["correct", "they release on Friday afternoons", "they deploy on Thursdays"],
    // A confirm is about the line it names; its own text is not a rewrite of it.
    ["confirm", "they use pnpm", "they use pnpm"],
    ["create", "their team uses pnpm for everything", undefined],
  ]);
  assert.ok(parsed.items.every(item => item.from?.[0] === "main@2026-09-06T10:00"));
});

test("a bad item loses only itself, and each loss is counted by why", () => {
  const candidates = [old("they deploy on Thursdays")];
  const reply = [
    "they deploy on Fridays", // the old plain-line shape: no op, no quote
    "{\"op\": \"create\", \"text\": \"broken", // not JSON
    line({ op: "forget", target: "K1", text: "x", quote: SAID }),
    line({ op: "correct", target: "K7", text: "they release on Fridays", quote: SAID }),
    line({ op: "confirm", text: "they deploy on Thursdays", quote: SAID }), // no target at all
    line({ op: "create", text: "they release on Fridays", quote: "they said they release on Fridays" }),
    line({ op: "create", text: "their team uses pnpm", quote: "我们团队用 pnpm" }),
  ].join("\n");
  const parsed = parseExtraction(reply, one(candidates));
  assert.deepEqual(parsed.items.map(item => item.text), ["their team uses pnpm"]);
  assert.deepEqual(parsed.dropped, { malformed: 2, "unknown op": 1, "target not offered": 2, "quote not in their words": 1 });
  assert.equal(describeDrops(parsed.dropped), "2 malformed, 1 unknown op, 2 target not offered, 1 quote not in their words");
  assert.equal(describeDrops({}), undefined);
});

test("the quote must be in the person's own words: not the agent's reply, not what the host wrote, not a near miss", () => {
  // The exchange's person words are the caller's (remember.ts personWordsOf); here: the person said
  // SAID in the first exchange, and nothing of the second was theirs.
  const ctx = one([], [SAID, undefined], ["main@a", "main@b"]);
  const reply = (quote: string) => parseExtraction(line({ op: "create", text: "they release on Fridays", quote }), ctx);
  assert.equal(reply("我们团队用 pnpm。发版都在周五").items.length, 1, "exact, folded, past twelve characters");
  assert.equal(reply("我们团队用pnpm.发版都在周五下午,不是周四").items.length, 1, "spacing and full-width punctuation are not differences");
  assert.equal(reply("我们团队用 pnpm").items.length, 1, "a whole sentence of theirs, however short");
  assert.deepEqual(reply("我们团队用 pnpm。发版都在周四").dropped, { "quote not in their words": 1 }, "one character changed is a different sentence");
  assert.deepEqual(reply("发版都在周五下午").dropped, { "quote not in their words": 1 }, "a clause inside a sentence is a fragment");
  assert.deepEqual(reply("周五").dropped, { "quote not in their words": 1 }, "two characters inside a longer message prove nothing");
  assert.ok(quoteInTheirWords("用中文回答", "用中文回答。"));
  assert.ok(quoteInTheirWords("Use metric.", "Use metric. And kilometres"));
  assert.ok(!quoteInTheirWords("中文", "用中文回答"));
  // From where the quote was found: the first exchange, not the second.
  assert.deepEqual(reply("我们团队用 pnpm").items[0]!.from, ["main@a"]);
  // Exchanges that could not all be placed cite nothing rather than a guess.
  assert.equal(parseExtraction(line({ op: "create", text: "they release on Fridays", quote: SAID }), one([], [SAID], [])).items[0]!.from, undefined);
});

test("shape is read leniently: a list, a fence, bullets and trailing commas", () => {
  const item = { op: "create", text: "their team uses pnpm", quote: "我们团队用 pnpm" };
  for (const reply of [`[${line(item)}]`, `\`\`\`json\n${line(item)}\n\`\`\``, `- ${line(item)}`, `[\n${line(item)},\n${line({ ...item, op: 1 })}\n]`]) {
    assert.deepEqual(parseExtraction(reply, one()).items.map(entry => entry.text), ["their team uses pnpm"], reply);
  }
});

test("content is read strictly: three at most, nothing over-long, a credential is not storable, a repeat is not two", () => {
  const items = (texts: string[]) => texts.map(text => line({ op: "create", text, quote: SAID })).join("\n");
  assert.equal(parseExtraction(items(["one thing", "two thing", "three thing", "four thing"]), one()).items.length, 3, "the prompt says three; this enforces it");
  // Truncating would store half a sentence as a fact, which reads as a whole one.
  const long = parseExtraction(items(["fine line", "x".repeat(MAX_RECORD_CHARS + 1)]), one());
  assert.deepEqual([long.items.map(item => item.text), long.dropped], [["fine line"], { "not storable": 1 }]);
  const github = `ghp_${"Ab1".repeat(13)}`;
  assert.deepEqual(parseExtraction(items(["they use pnpm", `the token is ${github}`]), one()).items.map(item => item.text), ["they use pnpm"]);
  assert.deepEqual(parseExtraction(items(["they use pnpm", "They use pnpm."]), one()).dropped, { repeated: 1 });
  // A sentence that merely contains the sentinel's word is a sentence.
  assert.equal(parseExtraction(items(["Nothing gets past their reviewer without a test"]), one()).items.length, 1);
});

test("a create that repeats a live line word for word confirms it; a correction to the same words is no correction", () => {
  const known = old("they use pnpm", 1);
  const parsed = parseExtraction(line({ op: "create", text: "They use pnpm.", quote: SAID }), one([], [SAID], ["main@x"], [known]));
  assert.deepEqual(parsed.items.map(item => [item.op, item.target]), [["confirm", known]]);
  const same = parseExtraction(line({ op: "correct", target: "K1", text: "They use pnpm.", quote: SAID }), one([known]));
  assert.deepEqual(same.dropped, { repeated: 1 });
});

test("the ledger lines: a confirm is the record again with its decay restarted and its places kept; a correction withdraws, then replaces", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  const learned = old("they prefer short answers", 1, ["main@2026-09-01T10:00"]);
  const replaced = old("they deploy on Thursdays", 3); // an old plain-line note: no `from` at all
  const { creates, confirms, corrections } = recordsOfExtraction([
    { op: "create", text: "they release on Fridays", from: ["main@2026-10-20T09:59"] },
    { op: "confirm", text: learned.text, target: learned, from: ["main@2026-10-20T09:59"] },
    { op: "correct", text: "they deploy on Fridays", target: replaced, from: ["main@2026-10-20T09:59"] },
  ], now);
  assert.deepEqual(creates, [{ at: now.toISOString(), kind: "note", text: "they release on Fridays", source: "extracted", from: ["main@2026-10-20T09:59"] }]);
  assert.deepEqual(confirms, [{ ...learned, at: now.toISOString(), from: ["main@2026-09-01T10:00", "main@2026-10-20T09:59"] }]);
  assert.equal(corrections[0]!.retraction.kind, "retraction");
  assert.equal(corrections[0]!.retraction.text, "they deploy on Thursdays");
  assert.ok(corrections[0]!.record.at > corrections[0]!.retraction.at, "the replacement comes after its withdrawal");

  // Applied to a ledger that holds lines written before INV-733: nothing old is dropped or
  // rewritten, the corrected line is gone from the view, the confirmed one scores as new.
  const ledger = [learned, replaced, old("they live in Hangzhou", 2)];
  const after = [...ledger, ...creates, ...confirms, corrections[0]!.retraction, corrections[0]!.record];
  const view = dedupe(after).map(record => record.text).sort();
  assert.deepEqual(view, ["they deploy on Fridays", "they live in Hangzhou", "they prefer short answers", "they release on Fridays"]);
  const confirmed = dedupe(after).find(record => record.text === "they prefer short answers")!;
  assert.ok(scoreOf(confirmed, now.getTime()) > scoreOf(learned, now.getTime()) * 1.9, "said again seven weeks later, it is not seven weeks old");
  assert.ok(recall(after, 10_000, now.getTime()).records.some(record => record.text === "they live in Hangzhou"), "an untouched old note still recalls");

  // Confirmed every week for a year: the first place and the newest are kept, bounded.
  let record = learned;
  for (let week = 0; week < 20; week++) {
    record = recordsOfExtraction([{ op: "confirm", text: record.text, target: record, from: [`main@w${week}`] }], now).confirms[0]!;
  }
  assert.equal(record.from!.length, MAX_FROM);
  assert.deepEqual([record.from![0], record.from!.at(-1)], ["main@2026-09-01T10:00", "main@w19"]);
});
