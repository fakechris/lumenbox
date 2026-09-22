/**
 * Tests for the line that says what a read got.
 *
 * The second half of this file is the more valuable one: it records the measurement that
 * *falsified* the first design. A page can be dense with prose and still not be the
 * document you asked for, so the line reports counts and refuses to grade them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROSE_BLOCK_CHARS,
  parseReadOutcome,
  readOutcome,
  textShape,
  withReadOutcome,
} from "./read-outcome.ts";

test("the line leads with what was got, then the counts, then what to do", () => {
  assert.equal(
    readOutcome({
      completeness: "clipped",
      shape: { chars: 40_000, totalChars: 61_606, prose: 57, links: 576 },
      hint: "open it with browser_open to see the rest",
    }),
    "[read: clipped — 40,000 of 61,606 chars, 57 prose blocks, 576 links; open it with browser_open to see the rest]"
  );
  // Counts are not singularised: one shape, one format, easy to parse.
  assert.equal(
    readOutcome({ completeness: "full", shape: { chars: 812, prose: 4, links: 1 } }),
    "[read: full — 812 chars, 4 prose blocks, 1 links]"
  );
  assert.equal(readOutcome({ completeness: "unavailable" }), "[read: unavailable]");
  assert.equal(
    readOutcome({ completeness: "summary", shape: { results: 8 }, note: "descriptions are the engine's, not the pages" }),
    "[read: summary — 8 results; descriptions are the engine's, not the pages]"
  );
  // "of" only appears when there really was more.
  assert.match(readOutcome({ completeness: "full", shape: { lines: 12, totalLines: 12 } }), /12 lines\]$/);
  assert.match(readOutcome({ completeness: "clipped", shape: { lines: 12, totalLines: 900 } }), /12 of 900 lines/);
});

test("the line is first, and reads back to what was written", () => {
  const whole = withReadOutcome(
    { completeness: "blocked", note: "the site answered with a consent screen" },
    "# A title\nSource: https://example.com/\n\nbody"
  );
  assert.ok(whole.startsWith("[read: blocked"), whole.slice(0, 40));
  const parsed = parseReadOutcome(whole);
  assert.equal(parsed?.completeness, "blocked");
  assert.equal(parsed?.detail, "the site answered with a consent screen");
  assert.equal(whole.split("\n\n")[1], "# A title\nSource: https://example.com/");
  // Anything that is not the line parses as nothing, rather than as a false "full".
  assert.equal(parseReadOutcome("# A title\n\n[read: full]"), undefined);
  assert.equal(parseReadOutcome("[read: excellent — 5 chars]"), undefined);
});

test("prose is counted outside links, because a navigation page is mostly labels", () => {
  const prose = "x".repeat(PROSE_BLOCK_CHARS);
  assert.deepEqual(textShape(`${prose}\n\n${prose}`), { chars: prose.length * 2 + 2, prose: 2, links: 0 });
  // A block that is only a link counts as a link and not as prose, however long.
  const nav = `[${"a".repeat(80)}](https://example.com/${"b".repeat(80)})`;
  assert.deepEqual(textShape(nav), { chars: nav.length, prose: 0, links: 1 });
  // A block one character short of the bar is not prose.
  assert.equal(textShape("y".repeat(PROSE_BLOCK_CHARS - 1)).prose, 0);
});

/**
 * Three real pages, fetched 2026-09-22 and kept as the text they extract to.
 *
 * This is the evidence behind a design that was thrown away. The first draft of this
 * module was going to classify a page as a "shell" when its prose was thin, so that a
 * JavaScript app serving navigation could be told apart from an article. The numbers say
 * that rule is backwards.
 */
test("prose density does not tell an app shell from an article: the measurement that killed the idea", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("./fixtures/read-shapes/extracted-text.json", import.meta.url), "utf8")
  ) as Record<string, { htmlChars: number; title: string; text: string }>;

  const shapes = Object.fromEntries(
    // `_note` records how the pages were redacted; it is prose about the fixture, not a page.
    Object.entries(fixtures).filter(([name]) => !name.startsWith("_")).map(([name, page]) => {
      const shape = textShape(page.text);
      return [name, { ...shape, proseRatio: +(shape.prose / Math.max(1, shape.chars / 1000)).toFixed(2), htmlRatio: +(shape.chars / page.htmlChars).toFixed(3) }];
    })
  );

  // The logged-out x.com status page: dense with prose, and it is not navigation.
  assert.equal(shapes["x-status-logged-out"]!.chars, 6_434);
  assert.equal(shapes["x-status-logged-out"]!.prose, 29);
  assert.equal(shapes["x-status-logged-out"]!.links, 14);

  // An encyclopedia article: far more text, far more links, and *fewer* prose blocks per
  // thousand characters than the app. Any "thin prose means shell" rule flags this page
  // and clears the other one — which is exactly the wrong way round.
  assert.ok(
    shapes["wikipedia-article"]!.proseRatio < shapes["x-status-logged-out"]!.proseRatio,
    `wikipedia ${shapes["wikipedia-article"]!.proseRatio} should be under x.com ${shapes["x-status-logged-out"]!.proseRatio}`
  );
  // And a short blog post has three prose blocks, which the same rule would also condemn.
  assert.ok(shapes["personal-blog-post"]!.prose <= 3, JSON.stringify(shapes["personal-blog-post"]));

  // The one signal that did separate them is the share of the HTML that becomes text —
  // 1.7% for the app against 17-25% for the documents. It is left unused on purpose: it
  // measures how a page is built, not whether the read got the content, and a page with a
  // large inline payload would trip it for no reason.
  assert.ok(shapes["x-status-logged-out"]!.htmlRatio < 0.05, JSON.stringify(shapes["x-status-logged-out"]));
  assert.ok(shapes["wikipedia-article"]!.htmlRatio > 0.1, JSON.stringify(shapes["wikipedia-article"]));
  assert.ok(shapes["personal-blog-post"]!.htmlRatio > 0.1, JSON.stringify(shapes["personal-blog-post"]));
});

test("the x.com page a plain fetch gets does carry the article, behind its navigation", () => {
  // The claim this replaces said the agent saw forty-three characters. It did not: that
  // was the tweet's own text in the API. What a plain fetch gets is most of the article —
  // after two thousand characters of sign-in furniture, which is the part the transcript
  // keeps (docs/69).
  const fixtures = JSON.parse(
    readFileSync(new URL("./fixtures/read-shapes/extracted-text.json", import.meta.url), "utf8")
  ) as Record<string, { text: string }>;
  const text = fixtures["x-status-logged-out"]!.text;
  assert.match(text.slice(0, 2_000), /Log in|Sign up/, "the head is navigation");
  assert.ok(text.length > 6_000, "and there is a great deal more after it");
  // A sentence from the body of the article the post links to.
  assert.match(text, /先做错误分析/, "the article's own prose is in the page");
});
