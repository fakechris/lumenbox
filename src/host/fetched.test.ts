/**
 * Tests for keeping what an agent read.
 *
 * The property that matters: the file holds the whole text and enough of a head to be
 * trusted later, and the pruning is by age with a bound, never by anything cleverer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchedDir,
  fetchedFrontmatter,
  keepFetchedPage,
  keptPathFor,
  pruneFetched,
  pruneOccasionally,
  readFrontmatter,
  resetPruneClock,
  retentionDays,
  sha256,
  type KeepPageInput,
} from "./fetched.ts";

function sample(overrides: Partial<KeepPageInput> = {}): KeepPageInput {
  return {
    url: "https://example.com/article?utm_source=x",
    finalUrl: "https://example.com/article",
    title: "An article",
    text: "# An article\n\nThe whole thing, every word of it.\n".repeat(2_000),
    contentType: "text/html",
    bytes: 123_456,
    clipped: true,
    meta: { author: "Ada", published: "2026-09-18", siteName: "Example" },
    agent: { id: "agent-1", name: "Nova" },
    conversation: "feishu-personal-oc_abc",
    fetchedAt: new Date("2026-09-20T13:00:00.000Z"),
    ...overrides,
  };
}

test("a kept page is the whole text under a head that says where, when, who and what the page said of itself", () => {
  const home = mkdtempSync(join(tmpdir(), "fetched-"));
  try {
    const input = sample();
    const kept = keepFetchedPage(input, home);
    assert.equal(kept.path, join(fetchedDir(home), "2026-09", `${sha256(input.url).slice(0, 8)}-20260920T130000Z.md`));
    const file = readFileSync(kept.path, "utf8");
    const head = readFrontmatter(file);
    assert.equal(head.schema, "lumenbox.fetched/v1");
    assert.equal(head.url, input.url);
    assert.equal(head.final_url, input.finalUrl);
    assert.equal(head.title, "An article");
    assert.equal(head.fetched_at, "2026-09-20T13:00:00.000Z");
    assert.equal(head.content_type, "text/html");
    assert.equal(head.bytes, "123456");
    assert.equal(head.text_chars, String(input.text.length));
    assert.equal(head.clipped, "true");
    assert.equal(head.sha256, sha256(input.text));
    assert.equal(head.author, "Ada");
    assert.equal(head.published, "2026-09-18");
    assert.equal(head.site_name, "Example");
    assert.equal(head.agent_id, "agent-1");
    assert.equal(head.agent, "Nova");
    assert.equal(head.conversation, "feishu-personal-oc_abc");
    // The body is every word, not the slice the model saw.
    const body = file.slice(file.indexOf("\n---\n", 4) + 5);
    assert.equal(body, `${input.text}\n`);
    assert.equal(sha256(body.slice(0, -1)), kept.sha256);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a page that said nothing about itself gets no invented author, and the head still parses", () => {
  const input = sample({ meta: {}, title: undefined, conversation: undefined });
  const head = readFrontmatter(fetchedFrontmatter(input, "deadbeef"));
  assert.equal(head.author, undefined);
  assert.equal(head.published, undefined);
  assert.equal(head.title, undefined);
  assert.equal(head.sha256, "deadbeef");
  // Quoting survives what a page title can contain.
  const spiky = readFrontmatter(fetchedFrontmatter(sample({ title: 'He said: "no" — and\nleft' }), "x"));
  assert.equal(spiky.title, 'He said: "no" — and\nleft');
});

test("two fetches of the same URL are two files; the instant is in the name", () => {
  const a = keptPathFor({ url: "https://example.com/", fetchedAt: new Date("2026-09-20T13:00:00Z") }, "/home");
  const b = keptPathFor({ url: "https://example.com/", fetchedAt: new Date("2026-09-20T13:00:01Z") }, "/home");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join("/home", "fetched", "2026-09", "")));
});

test("retention is read from the environment, defaults to ninety days, and is bounded", () => {
  assert.equal(retentionDays({}), 90);
  assert.equal(retentionDays({ AGENTBOX_FETCHED_RETENTION_DAYS: "7" }), 7);
  assert.equal(retentionDays({ AGENTBOX_FETCHED_RETENTION_DAYS: "0" }), 90);
  assert.equal(retentionDays({ AGENTBOX_FETCHED_RETENTION_DAYS: "forever" }), 90);
  assert.equal(retentionDays({ AGENTBOX_FETCHED_RETENTION_DAYS: "99999" }), 3650);
});

test("pruning removes kept files older than the retention, empties their month, and leaves the rest", () => {
  const home = mkdtempSync(join(tmpdir(), "fetched-"));
  try {
    const now = new Date("2026-09-20T13:00:00Z");
    const old = keepFetchedPage(sample({ fetchedAt: new Date("2026-05-01T00:00:00Z") }), home);
    const recent = keepFetchedPage(sample({ fetchedAt: new Date("2026-09-19T00:00:00Z") }), home);
    // An X post kept by x-post.ts lives under the same root and ages the same way.
    const xDir = join(fetchedDir(home), "x", "123");
    mkdirSync(xDir, { recursive: true });
    const oldPost = join(xDir, "post.md");
    writeFileSync(oldPost, "---\n---\nold\n");
    const stale = new Date("2026-04-01T00:00:00Z");
    utimesSync(old.path, stale, stale);
    utimesSync(oldPost, stale, stale);
    const fresh = new Date("2026-09-19T00:00:00Z");
    utimesSync(recent.path, fresh, fresh);

    const result = pruneFetched(home, { retentionDays: 90, now });
    assert.deepEqual(result, { removed: 2, kept: 1 });
    assert.ok(!existsSync(old.path));
    assert.ok(!existsSync(oldPost));
    assert.ok(!existsSync(join(fetchedDir(home), "2026-05")), "the emptied month is gone");
    assert.ok(!existsSync(xDir), "the emptied post directory is gone");
    assert.ok(existsSync(recent.path));
    assert.deepEqual(readdirSync(join(fetchedDir(home), "2026-09")).length, 1);

    // A missing directory is nothing to prune, not an error.
    assert.deepEqual(pruneFetched(join(home, "nowhere"), { retentionDays: 90, now }), { removed: 0, kept: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pruning on the way past happens at most once an hour and says what it removed", () => {
  const home = mkdtempSync(join(tmpdir(), "fetched-"));
  try {
    resetPruneClock();
    const kept = keepFetchedPage(sample({ fetchedAt: new Date("2026-01-01T00:00:00Z") }), home);
    const stale = new Date("2026-01-01T00:00:00Z");
    utimesSync(kept.path, stale, stale);
    const lines: string[] = [];
    const now = new Date("2026-09-20T13:00:00Z");
    pruneOccasionally(line => lines.push(line), home, now);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /removed 1 kept page\(s\) older than 90 days/);
    assert.ok(!existsSync(kept.path));
    // Within the hour: nothing happens, nothing is said.
    keepFetchedPage(sample({ fetchedAt: new Date("2026-01-02T00:00:00Z") }), home);
    pruneOccasionally(line => lines.push(line), home, new Date(now.getTime() + 60_000));
    assert.equal(lines.length, 1);
  } finally {
    resetPruneClock();
    rmSync(home, { recursive: true, force: true });
  }
});
