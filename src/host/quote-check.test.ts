/**
 * Tests for the quote gate, and for the measurement that shaped it.
 *
 * The second half is the part worth keeping. The threshold in this module is calibrated
 * rather than chosen, and the most important thing the calibration found is a limitation,
 * not a capability: a near match cannot tell a quote from that quote's own negation. These
 * tests pin both numbers so neither can drift quietly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkQuotes,
  fold,
  locateQuote,
  MIN_QUOTE_CHARS,
  QUOTE_MATCH_THRESHOLD,
  quotedRuns,
  quoteReportLine,
} from "./quote-check.ts";

const pages = JSON.parse(
  readFileSync(new URL("./fixtures/read-shapes/extracted-text.json", import.meta.url), "utf8")
) as Record<string, { text: string }>;

/** Lines long enough to be a quotation, from a real page. */
function sentences(text: string, count: number): string[] {
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 60 && line.length <= 300 && !line.startsWith("["))
    .slice(0, count);
}

test("a verbatim quote is located, with offsets into the text as it was given", () => {
  const source = "One paragraph.\n\nThe study found that grounding improves factual accuracy.\n\nAnother.";
  const verdict = locateQuote("The study found that grounding improves factual accuracy.", source);
  assert.equal(verdict.state, "located");
  assert.equal(verdict.exact, true);
  assert.equal(verdict.score, 1);
  assert.equal(source.slice(verdict.start, verdict.end), "The study found that grounding improves factual accuracy.");
});

test("the differences that are not differences do not count as differences", () => {
  // Every one of these is a thing a model does while quoting correctly.
  const source = "作者说：先做错误分析，再决定评估什么（这一点很关键）。";
  for (const quote of [
    "作者说: 先做错误分析, 再决定评估什么(这一点很关键).", // punctuation half-widthed
    "作者说：先做错误分析，\n  再决定评估什么（这一点很关键）。", // reflowed
    "  作者说：先做错误分析，再决定评估什么（这一点很关键）。  ", // padded
  ]) {
    const verdict = locateQuote(quote, source);
    assert.equal(verdict.state, "located", quote);
    assert.equal(verdict.exact, true, `${quote} should fold to exact`);
  }
  // Case is folded too, for the sources that have one.
  assert.equal(locateQuote("THE STUDY FOUND", "…the study found that…").exact, true);
});

test("a quote off by a few tokens is still located, and says it was not exact", () => {
  const source = "The retrieval step is run before generation, and the retrieved passages are placed in the prompt verbatim.";
  const verdict = locateQuote("The retrieval step is run before generation and the passages are placed in the prompt verbatim.", source);
  assert.equal(verdict.state, "located");
  assert.equal(verdict.exact, false, "not exact, and it must not claim to be");
  assert.ok(verdict.score! >= QUOTE_MATCH_THRESHOLD, `scored ${verdict.score}`);
  // The source's own words come back, because that is the only thing a near match is good
  // for: putting the two side by side.
  assert.match(verdict.sourceText!, /retrieved passages are placed in the prompt verbatim/);
});

test("something the source does not contain is not located, and that is all it says", () => {
  const source = pages["wikipedia-article"]!.text;
  const verdict = locateQuote(
    "The committee voted unanimously to postpone the launch until the following spring.",
    source
  );
  assert.equal(verdict.state, "not_located");
  assert.equal(verdict.start, undefined);
  // The wording is deliberate: this is a statement about a string, not about the agent.
  assert.match(verdict.note!, /not a finding about whether it is true/);
});

test("an empty source is unavailable, which is a different finding from not_located", () => {
  // "We looked and it is not there" and "we could not look" are different facts, and only
  // one of them is about whoever wrote the quote.
  assert.equal(locateQuote("anything at all, at length", "").state, "unavailable");
  assert.equal(locateQuote("anything at all, at length", "   \n  ").state, "unavailable");
});

test("a fragment too short to be evidence is refused rather than matched", () => {
  // An approximate search over a long page finds something near enough to almost any short
  // string, and a match that any source would produce says nothing about this one.
  // "the data" really is in this page, which is true and is not evidence about anything.
  const verdict = locateQuote("the data", pages["wikipedia-article"]!.text);
  assert.equal(verdict.state, "not_located");
  assert.match(verdict.note!, new RegExp(`${MIN_QUOTE_CHARS} needed`));
});

test("offsets survive folding: what comes back is a span of the original, not of the fold", () => {
  const source = "前言。\n\n「先做错误分析」，作者写道，「再决定评估什么」。\n\n后记。";
  const verdict = locateQuote('"先做错误分析", 作者写道, "再决定评估什么".', source);
  assert.equal(verdict.state, "located");
  const span = source.slice(verdict.start, verdict.end);
  assert.match(span, /^「先做错误分析」/, `got ${span}`);
  assert.match(span, /再决定评估什么」。?$/);
  // And the fold keeps a character for every character it emits.
  const folded = fold(source);
  assert.equal(folded.text.length, folded.map.length);
});

test("only marked quotations are collected, and a paraphrase is nobody's business", () => {
  const answer =
    'The paper says "grounding improves factual accuracy across benchmarks" and I read that as a ' +
    "strong claim. Elsewhere it argues the opposite for long documents. 作者还写了「先做错误分析，再决定评估什么」。";
  assert.deepEqual(quotedRuns(answer), [
    "grounding improves factual accuracy across benchmarks",
    "先做错误分析，再决定评估什么",
  ]);
  // A sentence with no marks is a paraphrase, and going looking for unmarked ones would
  // mean guessing which sentences were meant as quotation. A gate that guesses accuses.
  assert.deepEqual(quotedRuns("It argues the opposite for long documents."), []);
  // Too short to be a quotation worth checking, and duplicates collapse.
  assert.deepEqual(quotedRuns('He said "yes" and then "yes" again.'), []);
});

/**
 * The calibration. These numbers decided the threshold, so they are pinned here; if a
 * change to the folding or the search moves them, this file is where that shows up.
 */
test("calibration: genuine near-verbatim quotes are found, and other pages' sentences are not", () => {
  const drop = (line: string) => {
    const words = line.split(" ");
    if (words.length > 6) words.splice(Math.floor(words.length / 2), 1);
    return words.join(" ");
  };
  const change = (line: string) => {
    const words = line.split(" ");
    for (const at of [2, Math.floor(words.length / 2), words.length - 2]) {
      if (words[at] !== undefined && words[at]!.length > 2) words[at] = `${words[at]!.slice(0, -1)}x`;
    }
    return words.join(" ");
  };

  const named = Object.entries(pages).filter(([name]) => !name.startsWith("_"));
  const genuine: number[] = [];
  for (const [, page] of named) {
    for (const line of sentences(page.text, 40)) {
      genuine.push(locateQuote(drop(line), page.text).score ?? 0);
      genuine.push(locateQuote(change(line), page.text).score ?? 0);
    }
  }
  assert.ok(genuine.length >= 100, `expected a real sample, got ${genuine.length}`);
  const found = genuine.filter(score => score >= QUOTE_MATCH_THRESHOLD).length;
  assert.equal(found, genuine.length, `${genuine.length - found} genuine near-verbatim quotes were lost`);

  // Sentences from a different page. The highest of these decides how much room the
  // threshold has; measured at 0.329 on 2026-09-23.
  const foreign: number[] = [];
  for (const [name, page] of named) {
    for (const [other, elsewhere] of named) {
      if (other === name) continue;
      for (const line of sentences(page.text, 40)) foreign.push(locateQuote(line, elsewhere.text).score ?? 0);
    }
  }
  const highest = Math.max(...foreign);
  assert.ok(highest < 0.40, `a sentence from another page scored ${highest}`);
  assert.ok(
    QUOTE_MATCH_THRESHOLD > highest + 0.15,
    `the threshold ${QUOTE_MATCH_THRESHOLD} has too little room above ${highest}`
  );
});

/**
 * The limitation, kept as a test because it is the reason `exact` exists.
 *
 * Whoever next proposes trusting a near match, or raising the threshold until a near match
 * can be trusted, should meet this first: neither works, and the second one costs every
 * genuine quote.
 */
test("a near match cannot tell a quote from its own negation — which is why it is not a check", () => {
  const source =
    "Retrieval-augmented generation is effective for reducing hallucination in large language models, " +
    "and the study found that grounding improves factual accuracy across every benchmark tested.";

  const reversals = [
    source.replace("is effective", "is not effective"),
    source.replace("improves", "does not improve"),
    source.replace("every benchmark", "no benchmark"),
    source.replace("reducing", "increasing"),
  ];
  for (const quote of reversals) {
    const verdict = locateQuote(quote, source);
    assert.equal(verdict.state, "located", quote.slice(0, 60));
    assert.equal(verdict.exact, false, "and crucially it is not exact");
    // Every one of these scores above 0.94. Edit distance is relative to length, so the
    // handful of characters that invert a long sentence are invisible to it.
    assert.ok(verdict.score! > 0.9, `${verdict.score} for a reversed claim`);
  }

  // Which is the whole argument for the threshold not being the safety property. A cutoff
  // high enough to reject the reversals above would also reject this, a correct quote:
  const genuine = source.replace("large language models", "LLMs");
  assert.ok(locateQuote(genuine, source).score! < 0.98, "a real near-verbatim quote scores below the reversals");

  // The only thing that separates them is exactness, and it does so completely.
  assert.equal(locateQuote(source, source).exact, true);
  for (const quote of reversals) assert.notEqual(locateQuote(quote, source).exact, true);
});

test("the gate checks an answer against the sources that were read for it", () => {
  const wiki = { name: "wikipedia", text: "Retrieval-augmented generation grounds a model in retrieved passages." };
  const blog = { name: "blog", text: "先做错误分析，再决定评估什么。这是作者的第一条建议。" };

  const answer =
    'The article says "Retrieval-augmented generation grounds a model in retrieved passages." ' +
    '作者写道「先做错误分析，再决定评估什么」。It also claims "the benchmark results were withheld from reviewers".';
  const report = checkQuotes(answer, [wiki, blog]);

  assert.equal(report.exact, 2, "both real quotes, each found in its own source");
  assert.equal(report.notLocated, 1);
  assert.equal(report.near, 0);
  // Each quote remembers which source answered for it.
  assert.equal(report.checked[0]!.source, "wikipedia");
  assert.equal(report.checked[1]!.source, "blog");
  assert.equal(report.checked[2]!.state, "not_located");

  const line = quoteReportLine(report)!;
  assert.match(line, /^\[quotes: 2 exact, 0 near, 1 not found\]/);
  assert.match(line, /benchmark results were withheld/);
  assert.match(line, /drop the quotation marks/, "and what to do about it");
  assert.doesNotMatch(line, /Retrieval-augmented/, "a quote that checked out is not mentioned");
});

test("the gate says nothing when every quote is the source's own wording", () => {
  const source = { name: "page", text: "The study found that grounding improves factual accuracy." };
  const report = checkQuotes('It reports "grounding improves factual accuracy".', [source]);
  assert.equal(report.exact, 1);
  // A gate that speaks on success trains people to stop reading it.
  assert.equal(quoteReportLine(report), undefined);
});

test("a near quote is reported with what the source actually says, not as a pass or a failure", () => {
  const source = { name: "page", text: "Retrieval-augmented generation is not effective for short documents." };
  const report = checkQuotes('The paper says "Retrieval-augmented generation is effective for short documents".', [source]);

  // This is the case the whole design turns on. The quote reverses the source and scores
  // above 0.95, so it is found — and it is emphatically not counted as a quotation.
  assert.equal(report.exact, 0);
  assert.equal(report.near, 1);
  const line = quoteReportLine(report)!;
  assert.match(line, /close to the source but not its wording/);
  assert.match(line, /The source says: "Retrieval-augmented generation is not effective/);
});

test("no source read at all is unavailable, and does not become an accusation", () => {
  const report = checkQuotes('It says "something that was never checked against anything".', []);
  assert.equal(report.unavailable, 1);
  assert.equal(report.notLocated, 0, "never confused with having looked and failed");
  assert.match(quoteReportLine(report)!, /not checked either way/);
});
