/**
 * The reference pages are their sources (INV-1659): a tool, a skill, a template or a prompt part
 * that changes without its page being regenerated fails here, the way docs/INDEX.md is held to
 * the headers in docs-lint.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildTools } from "../src/host/tools.ts";
import { SEARCH_PROVIDERS } from "../src/host/web.ts";
import { PAGES, renderReference, stalePages } from "./docs-reference.mjs";

test("every reference page on disk is what its source renders", async () => {
  const stale = await stalePages();
  assert.deepEqual(stale.map(page => page.path), [], "a source changed: run node scripts/docs-reference.mjs --write and commit the pages");
});

test("the tool page lists exactly what buildTools offers with everything switched on", async () => {
  const key = SEARCH_PROVIDERS[0].keyEnv;
  process.env[key] = "offered-for-the-reference";
  let offered;
  try {
    offered = buildTools(true, true, undefined, true, true, true, true, false, ["github", "feishu", "dingtalk"]).map(tool => tool.name);
  } finally {
    delete process.env[key];
  }
  const page = (await renderReference()).find(p => p.path === PAGES.tools).text;
  const listed = [...page.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.equal(listed.length, offered.length, "one row per tool");
  assert.deepEqual([...listed].sort(), [...offered].sort());
});

test("a page that differs from its rendering is reported, and only that page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-reference-"));
  try {
    for (const page of await renderReference()) {
      mkdirSync(dirname(join(dir, page.path)), { recursive: true });
      const text = page.path === PAGES.tools ? `${page.text}a line somebody edited by hand\n` : page.text;
      writeFileSync(join(dir, page.path), text);
    }
    assert.deepEqual((await stalePages(dir)).map(page => page.path), [PAGES.tools]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
