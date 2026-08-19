/**
 * Tests for the chat feed's Markdown configuration.
 *
 * The renderer itself is markdown-it and is tested upstream; what is worth testing
 * here is the configuration, because that is where this application's guarantees are.
 * html:false is the reason model output cannot become markup — the same job a
 * sanitizer would do — so it is asserted rather than assumed, against the exact
 * options object the page is handed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import markdownit from "markdown-it";
import { MARKDOWN_OPTIONS, vendorPath } from "./markdown.ts";

const md = markdownit(MARKDOWN_OPTIONS);

test("markup in the model's text is escaped, not parsed", () => {
  const html = md.render('<img src=x onerror="alert(1)"> & <b>bold</b>');
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("<b>"), html);
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(html.includes("&amp;"), html);
});

test("links that could execute are not linked", () => {
  const hostile = md.render("[click](javascript:alert(1))");
  assert.ok(!hostile.includes("<a href=\"javascript"), hostile);

  const safe = md.render("[docs](https://example.com/a?b=1)");
  assert.ok(safe.includes('href="https://example.com/a?b=1"'), safe);
});

test("tables render as tables", () => {
  const html = md.render("| model | ctx |\n|---|---:|\n| claude-opus-5 | 1M |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<th>model</th>"), html);
  assert.ok(html.includes("<td>claude-opus-5</td>"), html);
  assert.ok(/style="text-align:right"/.test(html), html);
});

test("a table with an empty header row still renders", () => {
  // Agents write this shape when the table is really a two-column list of facts.
  const html = md.render("| | |\n|---|---|\n| API | api.x.ai |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<td>API</td>"), html);
});

test("fenced code keeps its content and its language", () => {
  const html = md.render("```sh\nif [ $a -lt $b ]; then echo '<x>'; fi\n```");
  assert.ok(html.includes('class="language-sh"'), html);
  assert.ok(html.includes("&lt;x&gt;"), html);
  assert.ok(!html.includes("<strong>"), html);
});

test("a fence that has not closed yet still renders as code", () => {
  // The normal state mid-stream: the model has opened a block and is still writing.
  const html = md.render("here you go:\n\n```sh\nls -la\ncat file");
  assert.ok(html.includes("<pre><code"), html);
  assert.ok(html.includes("ls -la\ncat file"), html);
  assert.ok(!html.includes("```"), html);
});

test("a single newline is a line break", () => {
  assert.equal(md.render("one\ntwo").trim(), "<p>one<br>\ntwo</p>");
});

test("identifiers are left alone", () => {
  const html = md.render("call display_index_for and snake_case_name");
  assert.ok(!html.includes("<em>"), html);
  assert.ok(html.includes("display_index_for"), html);
});

test("the vendored browser build is present", () => {
  // The page loads this by URL; a missing or renamed file would only surface as a
  // feed that silently stopped formatting.
  const path = vendorPath();
  assert.ok(existsSync(path), `not found: ${path}`);
  // Must be the UMD build: the page expects a global, and the ESM build defines none.
  assert.ok(path.endsWith("markdown-it.umd.min.js"), path);
});
