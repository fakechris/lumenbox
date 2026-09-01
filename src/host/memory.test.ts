/**
 * Tests for structured memory.
 *
 * The claims that matter: that a deliberate fact outlives an automatic note, that the same fact in
 * five phrasings does not crowd out everything else, that the budget is a budget rather than a count,
 * and that an extractor is allowed to find nothing. The last one is the easiest to get wrong and the
 * most expensive: an extractor that must produce output fills memory with restatements of the
 * obvious, which are then read on every future turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectionPrompt,
  chooseRelevant,
  parseSelection,
  buildEpisodePrompt,
  buildExtractionPrompt,
  dedupe,
  dedupeKey,
  importMarkdown,
  MAX_RECORD_CHARS,
  parseEpisode,
  parseExtraction,
  MEMORY_CHAR_BUDGET,
  recall,
  renderSharedMemory,
  SHARED_CHAR_BUDGET,
  renderMemory,
  scoreOf,
  selectRelevant,
  validateRecord,
  type MemoryRecord,
} from "./memory.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T00:00:00.000Z");

function record(
  kind: MemoryRecord["kind"],
  text: string,
  daysAgo = 0
): MemoryRecord {
  return { at: new Date(NOW - daysAgo * DAY).toISOString(), kind, text };
}

test("a deliberate fact outlives an automatic note", () => {
  // The distinction the three kinds exist for: the agent vouched for one of these and nobody
  // vouched for the other. A year on, the fact should still be in the prompt and the note gone.
  const fact = record("fact", "they deploy on Fridays", 200);
  const note = record("note", "they mentioned a staging server", 200);
  assert.ok(scoreOf(fact, NOW) > scoreOf(note, NOW) * 5);

  // Fresh, the note is still worth less — it was never reviewed.
  assert.ok(scoreOf(record("fact", "x"), NOW) > scoreOf(record("note", "x"), NOW));

  // An episode outranks a single fact of the same age: it stands in for several.
  assert.ok(scoreOf(record("episode", "x"), NOW) > scoreOf(record("fact", "x"), NOW));
});

test("the same fact in five phrasings does not crowd out everything else", () => {
  // The failure this prevents. Without it, the one thing an agent keeps re-learning fills the
  // budget and the nine other things it knows fall out.
  const records = [
    record("note", "The user prefers tabs.", 5),
    record("note", "the user prefers tabs", 4),
    record("note", "They prefer tabs!", 3),
    record("note", "user prefers tabs", 2),
    record("fact", "Deploys are on Fridays", 1),
  ];
  const deduped = dedupe(records);
  assert.equal(deduped.length, 2, `expected two distinct memories, got ${deduped.length}`);
  assert.ok(deduped.some(entry => /Fridays/.test(entry.text)));
});

test("a later memory wins, because writing it again is usually a correction", () => {
  const deduped = dedupe([
    record("note", "the API key lives in .env", 10),
    record("note", "the API key lives in 1password", 1),
  ]);
  // Different words, so both survive — dedupe is not semantic and does not pretend to be.
  assert.equal(deduped.length, 2);

  // The same words: the later one is the one kept.
  const same = dedupe([record("note", "port is 8080", 10), record("note", "port is 8080", 1)]);
  assert.equal(same.length, 1);
  assert.equal(same[0]?.at, new Date(NOW - DAY).toISOString());
});

test("an automatic note never displaces the fact it repeats", () => {
  // Otherwise extraction would quietly restart the decay clock on something already vouched for,
  // and demote it from fact to note in the process.
  const deduped = dedupe([
    record("fact", "they use pnpm", 100),
    record("note", "they use pnpm", 1),
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.kind, "fact");
  assert.equal(deduped[0]?.at, new Date(NOW - 100 * DAY).toISOString());
});

test("the budget is a budget, not a count", () => {
  // Fifty short facts and five long ones cost the same, and a count would keep the wrong set.
  const short = Array.from({ length: 50 }, (_, index) =>
    record("fact", `fact number ${index}`, index)
  );
  const kept = recall(short, 300, NOW);
  assert.ok(kept.records.length > 5, "short memories: many fit");
  assert.ok(kept.omitted > 0, "and the rest are counted as omitted");

  const long = Array.from({ length: 50 }, (_, index) =>
    record("fact", "x".repeat(200) + index, index)
  );
  assert.ok(recall(long, 300, NOW).records.length < kept.records.length, "long ones: fewer fit");
});

test("at least one memory survives any budget", () => {
  // A budget smaller than the newest memory would otherwise render nothing, which reads as "this
  // agent has never learned anything" — a much worse lie than a slightly over-budget prompt.
  const kept = recall([record("fact", "x".repeat(400))], 10, NOW);
  assert.equal(kept.records.length, 1);
});

test("the prompt is ordered by time even though selection was by score", () => {
  const kept = recall(
    [record("fact", "oldest", 10), record("fact", "newest", 1), record("fact", "middle", 5)],
    10_000,
    NOW
  );
  // Scoring decides *which* memories are shown; a model reading them benefits from knowing which
  // came after which.
  assert.deepEqual(
    kept.records.map(entry => entry.text),
    ["oldest", "middle", "newest"]
  );
});

test("an omitted memory is admitted to, not hidden", () => {
  const rendered = renderMemory(recall(
    Array.from({ length: 40 }, (_, index) => record("fact", `something ${index}`, index)),
    200,
    NOW
  ));
  // Without this an agent reads a truncated list as everything it knows, and concludes something
  // never happened from its absence.
  assert.match(rendered, /are not shown/);
  assert.match(rendered, /do not conclude something never happened/);
});

test("empty memory says what to do about it", () => {
  const rendered = renderMemory({ records: [], omitted: 0 });
  assert.match(rendered, /have not kept anything yet/);
  assert.match(rendered, /RememberFact/);
  // And the one instruction that stops memory filling with noise.
  assert.match(rendered, /what a tool can tell you again on demand/);
});

test("the kind is shown, because it says how much to trust the line", () => {
  const rendered = renderMemory(recall([record("note", "they might use Windows")], 10_000, NOW));
  assert.match(rendered, /\[note\]/);
  // A deliberate fact carries no marker: it is the default and marking it would be noise.
  assert.doesNotMatch(
    renderMemory(recall([record("fact", "they use Linux")], 10_000, NOW)),
    /\[fact\]/
  );
});

test("a memory too long to keep is refused with the alternative named", () => {
  assert.equal(validateRecord("a normal fact"), undefined);
  assert.ok(validateRecord("   ")?.reason.includes("nothing to remember"));
  const long = validateRecord("x".repeat(MAX_RECORD_CHARS + 1));
  assert.ok(long);
  assert.match(long.reason, /paid for repeatedly/);
  assert.match(long.reason, /\/home\/box\/work/, "it says where a document should go instead");
});

// ── extraction ────────────────────────────────────────────────────────────────────────

test("an extractor is allowed to find nothing", () => {
  // The most important test here. An extractor that must produce output invents something, and a
  // memory of the obvious is worse than no memory: it is read on every future turn.
  assert.deepEqual(parseExtraction("NOTHING", []), []);
  assert.deepEqual(parseExtraction("  nothing  ", []), []);
  assert.deepEqual(parseExtraction("NOTHING to keep here", []), []);
  assert.deepEqual(parseExtraction("", []), []);

  // And the prompt asks for that outcome first, rather than as an afterthought.
  const prompt = buildExtractionPrompt("some conversation", []);
  assert.match(prompt, /Reply with NOTHING and nothing else unless/);
  assert.match(prompt, /Most exchanges teach nothing durable/);
  assert.match(prompt, /crowds out what matters/);
});

test("extraction is lenient about shape and strict about content", () => {
  const known = [record("fact", "they use pnpm")];
  const parsed = parseExtraction(
    ["- they deploy on Fridays", "* 2. they use pnpm", "3) staging is at stg.example.com", ""].join("\n"),
    known
  );
  // Bullets and numbering are stripped — models add them whatever the instruction says.
  assert.deepEqual(
    parsed.map(entry => entry.text),
    ["they deploy on Fridays", "staging is at stg.example.com"]
  );
  // The one repeating what is already known was dropped rather than stored again.
  assert.ok(parsed.every(entry => entry.kind === "note"));
  assert.ok(parsed.every(entry => entry.source === "extracted"));
});

test("extraction honours its own limit rather than trusting the instruction", () => {
  const parsed = parseExtraction(
    ["one thing", "two thing", "three thing", "four thing", "five thing"].join("\n"),
    []
  );
  assert.equal(parsed.length, 3, "the prompt says three; this enforces it");
});

test("an over-long extracted line is dropped, not truncated", () => {
  // Truncating would store half a sentence as a fact, which is worse than losing it: a half fact
  // reads as a whole one.
  const parsed = parseExtraction(["fine line", "x".repeat(MAX_RECORD_CHARS + 1)].join("\n"), []);
  assert.deepEqual(parsed.map(entry => entry.text), ["fine line"]);
});

test("an episode is one paragraph, or nothing", () => {
  assert.equal(parseEpisode("NOTHING"), undefined);
  assert.equal(parseEpisode("   "), undefined);
  const episode = parseEpisode("We built the parser.\n\nIt works now.");
  assert.equal(episode?.kind, "episode");
  // Newlines collapsed: an episode is a paragraph, and a multi-line one renders as broken bullets.
  assert.equal(episode?.text, "We built the parser. It works now.");

  const prompt = buildEpisodePrompt(["a", "b"]);
  assert.match(prompt, /2 exchanges/);
  assert.match(prompt, /carry the outcome rather than/, "not the narrative");
});

// ── retrieval, and the seam it sits behind ────────────────────────────────────────────

test("relevance is word overlap, which is enough for short facts", () => {
  const records = [
    record("fact", "the staging database is postgres 16"),
    record("fact", "they deploy on Fridays"),
    record("fact", "the production database is postgres 15"),
  ];
  const found = selectRelevant("what version is the staging database", records, 2);
  assert.equal(found.length, 2);
  assert.ok(found[0]?.text.includes("staging"), "the best overlap comes first");
  // Nothing in common means nothing returned, rather than the nearest thing by some metric.
  assert.deepEqual(selectRelevant("unrelated words entirely", records, 2), []);
  assert.deepEqual(selectRelevant("", records, 2), []);
  assert.deepEqual(selectRelevant("database", records, 0), []);
});

test("the dedupe key ignores phrasing but not meaning", () => {
  assert.equal(dedupeKey("The user prefers tabs!"), dedupeKey("user prefers tabs"));
  assert.equal(dedupeKey("It is in the .env file"), dedupeKey("in env file"));
  assert.notEqual(dedupeKey("port is 8080"), dedupeKey("port is 9090"));
  assert.equal(dedupeKey("!!!"), "", "punctuation alone is not a memory");
});

test("Chinese clauses share key material, which is what lets them collide at all", () => {
  // Audit 2026-09-01, claim 3: an unbroken Han run used to be one giant "word", so two
  // rephrasings of the same Chinese fact never shared a token and never deduped —
  // memory bloat in the language this installation mostly speaks. Bigrams give
  // overlapping phrasings overlapping keys.
  const a = dedupeKey("用户偏好数据库密码放在环境变量");
  const b = dedupeKey("数据库密码存放于环境变量中");
  const bWords = new Set(b.split(" "));
  const shared = new Set(a.split(" ").filter(word => bWords.has(word)));
  assert.ok(shared.has("密码"), "the two-character word survives as a bigram");
  assert.ok(shared.size >= 4, `rephrasings overlap (${shared.size} shared bigrams)`);

  // And the boundary, stated rather than implied — an earlier commit message claimed
  // more than this (audit 2026-09-01, #7). Overlapping bigrams make a paraphrase
  // *findable*; they do not make it the same key, so `dedupe` keeps both. Paraphrase is
  // suppressed at the write path instead: the extractor is shown what is already known,
  // via selectRelevant, which is the function the bigrams fixed. Merging on similarity
  // was considered and refused — at a threshold low enough to catch these two, "port is
  // 8080" and "port is 9090" merge too, and losing a fact is worse than repeating one.
  assert.notEqual(a, b, "two different phrasings are two different keys");
  const phrasings = [
    { at: "2026-09-01T00:00:00.000Z", kind: "fact" as const, text: "用户偏好数据库密码放在环境变量" },
    { at: "2026-09-01T00:01:00.000Z", kind: "fact" as const, text: "数据库密码存放于环境变量中" },
  ];
  assert.equal(dedupe(phrasings).length, 2, "dedupe is exact-key, in every language");
  assert.equal(
    dedupe([phrasings[0]!, { ...phrasings[0]!, at: "2026-09-01T00:02:00.000Z" }]).length,
    1,
    "an exact restatement still collapses"
  );
  // And selectRelevant can now be reached with a two-character Chinese query word.
  const records = [
    { at: "2026-09-01T00:00:00.000Z", kind: "fact" as const, text: "数据库密码在环境变量" },
    { at: "2026-09-01T00:00:00.000Z", kind: "fact" as const, text: "deploys on Fridays" },
  ];
  const hits = selectRelevant("密码放哪了", records, 5);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.text, /密码/);
});

// ── migration ─────────────────────────────────────────────────────────────────────────

test("an existing markdown memory is imported, dates and all", () => {
  // Losing someone's memory to upgrade the format would be the worst possible way to introduce a
  // feature about not losing things.
  const imported = importMarkdown(
    [
      "# Memory",
      "",
      "- (2026-01-15) they deploy on Fridays",
      "- no date on this one",
      "- (2026-02-01) they use pnpm",
      "- (2026-03-01) they use pnpm",
      "",
    ].join("\n")
  );
  assert.deepEqual(
    imported.map(entry => entry.text),
    ["they deploy on Fridays", "no date on this one", "they use pnpm"]
  );
  // Imported as facts, because that is what they were: written deliberately with RememberFact.
  assert.ok(imported.every(entry => entry.kind === "fact"));
  // The original date is honoured, so decay does not treat a year-old note as written today.
  assert.equal(imported[0]?.at.slice(0, 10), "2026-01-15");
  assert.match(imported[0]?.source ?? "", /memory\.md/);
  // Midday rather than midnight, since the line carried only a date and midnight in one timezone is
  // the previous day in another.
  assert.match(imported[0]?.at ?? "", /T12:00/);

  assert.deepEqual(importMarkdown(""), []);
  assert.deepEqual(importMarkdown("# Memory\n\n"), []);
});

// ── the team's tier ───────────────────────────────────────────────────────────────────

test("team memory says who learned it, because that changes its weight", () => {
  const rendered = renderSharedMemory(
    recall(
      [
        { ...record("fact", "the staging DB is postgres 16"), via: "agent-rex" },
        { ...record("fact", "the build needs node 22"), via: "agent-ops" },
      ],
      10_000,
      NOW
    ),
    id => ({ "agent-rex": "Rex", "agent-ops": "Ops" })[id] ?? id
  );
  // A fact from the agent whose job is checking things is not the same as one from the agent that
  // happened to be installing software at the time.
  assert.match(rendered, /postgres 16 — Rex/);
  assert.match(rendered, /node 22 — Ops/);
  assert.match(rendered, /notice who learned it/);
  // And it is a separate heading, so "I learned this" and "a colleague did" stay distinguishable.
  assert.match(rendered, /## What your team has learned/);
});

test("a team memory records who it is about", () => {
  const rendered = renderSharedMemory(
    recall([{ ...record("fact", "prefers tabs"), via: "a", about: "alice" }], 10_000, NOW)
  );
  // Without this, a fact learned from one person reads as being about whoever asks next — which in a
  // team is worse than not recording it at all.
  assert.match(rendered, /\(about alice\)/);
});

test("an empty team tier renders nothing, not an empty heading", () => {
  // A heading with nothing under it tells the model the team knows nothing, which is a claim rather
  // than an absence.
  assert.equal(renderSharedMemory({ records: [], omitted: 0 }), "");
});

test("the team budget is tighter than an agent's own", () => {
  // The shared tier is written by every agent, so it grows N times as fast; a generous budget here
  // would push out an agent's own working knowledge.
  assert.ok(SHARED_CHAR_BUDGET < MEMORY_CHAR_BUDGET);
});


test("a memory can be withdrawn, so a correction does not sit beside the thing it corrects", () => {
  // Memory could only accrete. An agent that recorded "the deployment region is us-east-1" and
  // later learned otherwise could write the new fact but not withdraw the old one, so both sat in
  // the prompt, both dated, both presented as things it knows. Nothing here *detects* the
  // contradiction — that would mean guessing at meaning — the agent that knows says so.
  const records: MemoryRecord[] = [
    { at: "2026-06-01T00:00:00Z", kind: "fact", text: "deployment region is us-east-1" },
    { at: "2026-08-01T00:00:00Z", kind: "retraction", text: "deployment region is us-east-1" },
    { at: "2026-08-01T00:00:01Z", kind: "fact", text: "deployment region is eu-west-1" },
  ];

  const kept = dedupe(records).map(record => record.text);
  assert.deepEqual(kept, ["deployment region is eu-west-1"]);

  // A retraction is not itself a memory: it must not appear in the prompt as a line saying what is
  // no longer true.
  const rendered = renderMemory(recall(records, Date.parse("2026-08-20T00:00:00Z")));
  assert.ok(!rendered.includes("us-east-1"));
  assert.match(rendered, /eu-west-1/);
});

test("a retraction withdraws what came before it, not what comes after", () => {
  // Order is the file's. Something recorded again after a retraction is a fresh statement, not a
  // withdrawn one — otherwise an agent could never re-learn something it had once retracted.
  const records: MemoryRecord[] = [
    { at: "2026-06-01T00:00:00Z", kind: "fact", text: "the staging box is at 10.0.0.4" },
    { at: "2026-07-01T00:00:00Z", kind: "retraction", text: "the staging box is at 10.0.0.4" },
    { at: "2026-08-01T00:00:00Z", kind: "fact", text: "the staging box is at 10.0.0.4" },
  ];
  assert.deepEqual(
    dedupe(records).map(record => record.text),
    ["the staging box is at 10.0.0.4"]
  );

  // And a retraction naming something nobody remembers changes nothing.
  const unrelated: MemoryRecord[] = [
    { at: "2026-06-01T00:00:00Z", kind: "fact", text: "they prefer short answers" },
    { at: "2026-07-01T00:00:00Z", kind: "retraction", text: "something never recorded" },
  ];
  assert.deepEqual(dedupe(unrelated).map(record => record.text), ["they prefer short answers"]);
});


// ── choosing what survives the budget ────────────────────────────────────────────────

const factAt = (at: string, text: string): MemoryRecord => ({ at, kind: "fact", text });

test("nothing is dropped, so nothing is asked", async () => {
  // The gate, and the whole reason this is allowed to exist at all. docs/05-data.md §7 says lexical
  // recall stays until there is evidence it is failing; "memories are being left out" is that
  // evidence. When everything fits there is nothing to choose between, and a model call would be
  // pure cost on every turn forever.
  let asked = 0;
  const result = await chooseRelevant({
    records: [factAt("2026-08-01T00:00:00Z", "they prefer short answers")],
    query: "what do you know about me",
    ask: async () => {
      asked += 1;
      return '{"selected": [1]}';
    },
  });
  assert.equal(asked, 0);
  assert.equal(result.records.length, 1);
});

test("when the budget forces a choice, the chosen memories are the ones kept", async () => {
  // Twenty facts, room for a few. The scoring would keep the newest; the selector keeps the ones
  // that bear on the question, which is the entire point.
  const records = Array.from({ length: 20 }, (_, index) =>
    factAt(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`, `fact number ${index + 1} about something`)
  );
  records.push(factAt("2026-06-01T00:00:00Z", "the deployment region is eu-west-1"));

  const result = await chooseRelevant({
    records,
    query: "which region do we deploy to",
    budget: 120,
    // The oldest and lowest-scoring record, which recency alone would have dropped.
    ask: async prompt => {
      const line = prompt.split("\n").find(text => text.includes("eu-west-1")) ?? "";
      const number = /^(\d+)\./.exec(line.trim())?.[1];
      return `{"selected": [${number}]}`;
    },
  });

  assert.ok(
    result.records.some(record => record.text.includes("eu-west-1")),
    `the chosen memory should have survived; got ${JSON.stringify(result.records.map(r => r.text))}`
  );
  assert.ok(result.omitted > 0, "and it still says how many did not fit");
});

test("a selector that fails, or answers nonsense, changes nothing", async () => {
  const records = Array.from({ length: 30 }, (_, index) =>
    factAt(`2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`, `fact ${index} with some words`)
  );
  const scored = recall(records, 200);

  for (const ask of [
    async () => {
      throw new Error("the provider was down");
    },
    async () => "I think memory 3 and 5 are relevant",
    async () => undefined,
  ]) {
    const result = await chooseRelevant({ records, query: "anything", budget: 200, ask });
    assert.deepEqual(
      result.records.map(record => record.text),
      scored.records.map(record => record.text),
      "a failure improves nothing and breaks nothing"
    );
  }
});

test("choosing none is a decision, and is different from failing", () => {
  const candidates = [factAt("2026-08-01T00:00:00Z", "one"), factAt("2026-08-02T00:00:00Z", "two")];
  // An empty selection is an answer: the model looked and found nothing worth showing.
  assert.deepEqual(parseSelection('{"selected": []}', candidates), []);
  // These are not answers at all, and must not be read as "none".
  assert.equal(parseSelection("no idea", candidates), undefined);
  assert.equal(parseSelection('{"selected": "all of them"}', candidates), undefined);

  // An invented number is skipped rather than discarding the rest of the answer.
  assert.deepEqual(parseSelection('{"selected": [2, 99, 1]}', candidates), [
    candidates[1],
    candidates[0],
  ]);
});

test("the selection prompt says that choosing nothing is allowed", () => {
  const prompt = buildSelectionPrompt([factAt("2026-08-01T00:00:00Z", "a fact")], "a question");
  assert.match(prompt, /what would change the/);
  // Without this a model pads to look useful, and an irrelevant memory in front of an agent is
  // worse than a missing one because it will be treated as relevant.
  assert.match(prompt, /do not pad the list to look useful/);
  assert.match(prompt, /kept; you are not/);
  assert.match(prompt, /a fact/);
});

test("the sentinel is the sentinel however the model dresses it", () => {
  // A model wrote "(NOTHING)" and the exact-match guards let it through: the extractor's
  // own way of saying nothing-learned was stored as a thing it learned, and only a person
  // reading the file could have found it (docs/14). Punctuation and casing must not
  // smuggle it past; a sentence that merely contains the word must still be kept.
  assert.deepEqual(parseExtraction("(NOTHING)", []), []);
  assert.deepEqual(parseExtraction("**Nothing**", []), []);
  assert.deepEqual(parseExtraction("- nothing.", []), []);
  assert.equal(parseEpisode("( nothing )"), undefined);
  // Line-level: a dressed sentinel among real notes is dropped, the notes are kept —
  // including one that merely contains the word.
  const kept = parseExtraction(
    "User prefers tabs over spaces\n(nothing)\nNothing gets past their reviewer without a test",
    []
  );
  assert.deepEqual(
    kept.map(record => record.text),
    ["User prefers tabs over spaces", "Nothing gets past their reviewer without a test"]
  );
});
