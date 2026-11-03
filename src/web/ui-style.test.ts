/**
 * The settings sections set classes, not layout (docs/92 §3, INV-1548).
 *
 * They were written after the page, each with its own inline sizes and spacing — 49 style strings
 * across five files, 21 font sizes in the web code — and the result was a page that looked
 * assembled. The sheet in ui-style.ts carries the tokens and classes; this holds the five scripts
 * to zero inline layout. Showing and hiding (`display:none`, `style.display = …`) is state, and
 * position computed at run time (`style.left`, `style.top`) is placement; both stay allowed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { UI_CSS } from "./ui-style.ts";

const SECTIONS = ["supervision-ui.ts", "supervision-wizard.ts", "box-update-ui.ts", "jev-settings.ts", "inline-ask.ts"];

/** Inline style written as layout: a `style: "…"` attribute other than display:none, or cssText. */
export function inlineLayout(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/style:\s*"([^"]*)"/g)) if (match[1]!.trim() !== "display:none") found.push(match[0]);
  for (const match of source.matchAll(/style\.cssText\s*=\s*"[^"]*"/g)) found.push(match[0]);
  return found;
}

test("the check sees layout written inline and lets state through", () => {
  assert.equal(inlineLayout(`el("div", { style: "display:flex;gap:8px" })`).length, 1);
  assert.equal(inlineLayout(`card.style.cssText = "position:fixed"`).length, 1);
  assert.equal(inlineLayout(`el("pre", { class: "ui-log", style: "display:none" }); box.style.display = "block";`).length, 0);
});

test("the five settings sections write no layout inline", () => {
  const found = SECTIONS.flatMap(name => inlineLayout(readFileSync(join(import.meta.dirname, name), "utf8")).map(hit => `${name}: ${hit}`));
  assert.deepEqual(found, []);
});

test("the sheet carries the type and space scales and the one dropdown look", () => {
  for (const token of ["--fs-xs", "--fs-sm", "--fs-md", "--fs-body", "--fs-lg", "--fs-xl", "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6"]) {
    assert.ok(UI_CSS.includes(`${token}:`), `${token} is defined`);
  }
  assert.match(UI_CSS, /\.field select \{[^}]*appearance: none;[^}]*padding-right: 36px;[^}]*background-image:/, "a chevron with room beside it");
  assert.match(UI_CSS, /\[data-theme="dark"\] \.field select \{ background-image:/, "and its dark-theme colour");
  // A class the sections use is one the sheet defines.
  const used = new Set(SECTIONS.flatMap(name => [...readFileSync(join(import.meta.dirname, name), "utf8").matchAll(/\bui-[a-z-]+/g)].map(m => m[0])));
  const missing = [...used].filter(name => !new RegExp(`\\.${name}\\b`).test(UI_CSS));
  assert.deepEqual(missing, []);
});
