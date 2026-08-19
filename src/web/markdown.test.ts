/**
 * Tests for the chat feed's Markdown renderer.
 *
 * Two classes of failure matter here. The visible one is Markdown arriving as
 * literal syntax, which is what prompted the renderer. The quiet one is markup
 * escaping: the text comes from a model, so a rendered tag is a script the page
 * runs. Every case below that asserts on entities is guarding that, not formatting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.ts";

const NUL = String.fromCharCode(0);

test("markup in the model's text is inert", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> & <b>bold</b>');
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("<b>"), html);
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(html.includes("&amp;"), html);
});

test("a fenced block keeps its content verbatim", () => {
  const html = renderMarkdown("before\n\n```js\nif (a < b) { x = '**not bold**'; }\n```\n\nafter");
  assert.ok(html.includes("<pre><code>"), html);
  assert.ok(html.includes("if (a &lt; b)"), html);
  // Markdown inside a code block is content, not syntax.
  assert.ok(html.includes("**not bold**"), html);
  assert.ok(!html.includes("<strong>"), html);
  // A block is its own element, never wrapped in a paragraph.
  assert.ok(!/<p>\s*<pre>/.test(html), html);
  assert.ok(html.includes("<p>before</p>"), html);
});

test("a fence that has not closed yet still renders as code", () => {
  // The normal state mid-stream: the model has opened a block and is still writing.
  const html = renderMarkdown("here you go:\n\n```sh\nls -la\ncat file");
  assert.ok(html.includes("<pre><code>ls -la\ncat file</code></pre>"), html);
  assert.ok(!html.includes("```"), html);
});

test("inline code is code, not emphasis", () => {
  const html = renderMarkdown("run `npm test -- *.ts` now");
  assert.ok(html.includes("<code>npm test -- *.ts</code>"), html);
  assert.ok(!html.includes("<em>"), html);
});

test("emphasis, strong and strikethrough", () => {
  assert.ok(renderMarkdown("**very** important").includes("<strong>very</strong>"));
  assert.ok(renderMarkdown("a *little* odd").includes("<em>little</em>"));
  assert.ok(renderMarkdown("~~gone~~").includes("<del>gone</del>"));
});

test("identifiers are left alone", () => {
  // The failure this prevents: display_index_for rendered as displayindexfor with a
  // stray italic run through the middle.
  const html = renderMarkdown("call display_index_for and snake_case_name");
  assert.ok(!html.includes("<em>"), html);
  assert.ok(html.includes("display_index_for"), html);
});

test("links are limited to schemes that cannot execute", () => {
  const safe = renderMarkdown("see [the docs](https://example.com/a?b=1&c=2)");
  assert.ok(safe.includes('href="https://example.com/a?b=1&amp;c=2"'), safe);
  assert.ok(safe.includes('rel="noopener noreferrer"'), safe);

  const hostile = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!hostile.includes("<a "), hostile);
  // Left as visible source rather than silently dropped.
  assert.ok(hostile.includes("javascript:alert(1)"), hostile);
});

test("lists, including nested and ordered ones", () => {
  const flat = renderMarkdown("- one\n- two\n- three");
  assert.equal(flat, "<ul><li>one</li><li>two</li><li>three</li></ul>");

  const nested = renderMarkdown("- outer\n  - inner\n- back");
  assert.equal(
    nested,
    "<ul><li>outer<ul><li>inner</li></ul></li><li>back</li></ul>"
  );

  const ordered = renderMarkdown("1. first\n2. second");
  assert.equal(ordered, "<ol><li>first</li><li>second</li></ol>");
});

test("numbered steps after bullets keep their numbers", () => {
  // Caught by looking at the rendered page: the ordered list inherited the bullet
  // list above it, because the blank line between them was treated as a gap and the
  // marker type was never checked.
  const html = renderMarkdown("- a bullet\n\n1. step one\n2. step two");
  assert.equal(
    html,
    "<ul><li>a bullet</li></ul><ol><li>step one</li><li>step two</li></ol>"
  );
});

test("headings, blockquotes and rules", () => {
  assert.ok(renderMarkdown("## Findings").includes("<h2>Findings</h2>"));
  assert.ok(renderMarkdown("###### deep").includes("<h6>deep</h6>"));
  assert.ok(renderMarkdown("> quoted\n> more").includes("<blockquote>quoted<br>more</blockquote>"));
  assert.ok(renderMarkdown("above\n\n---\n\nbelow").includes("<hr>"));
});

test("a single newline breaks the line; a blank line starts a paragraph", () => {
  assert.equal(renderMarkdown("one\ntwo"), "<p>one<br>two</p>");
  assert.equal(renderMarkdown("one\n\ntwo"), "<p>one</p><p>two</p>");
});

test("a placeholder in the input cannot forge held content", () => {
  // The markers are an internal channel; text that mimics one must not reach it.
  const html = renderMarkdown(NUL + "0" + NUL + " and `real`");
  assert.ok(!html.includes("<pre>"), html);
  assert.ok(html.includes("<code>real</code>"), html);
  assert.ok(!html.includes(NUL), html);
});

test("empty input renders nothing", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("   \n\n  "), "");
  assert.equal(renderMarkdown(undefined as unknown as string), "");
});
