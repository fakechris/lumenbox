/**
 * Tests for the edge from a turn to what it read.
 *
 * The link only went one way. A kept file names the turn that read it, so file-to-turn
 * resolved; nothing answered turn-to-files, and the only way to ask was to walk every
 * month of the evidence store filtering on a field. Two pieces of shipped work stopped at
 * exactly this missing edge, which is why it is its own thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLedger } from "./resume.ts";
import { keepFetchedPage, pruneFetched } from "./fetched.ts";
import { keepToolResult, readKeptSources, referencedKeptPaths, resetKeptPruneClock } from "./results.ts";
import { checkQuotes } from "./quote-check.ts";

function home(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-turn-evidence-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const page = (root: string, n: number, text: string) =>
  keepFetchedPage(
    {
      url: `https://example.com/${n}`,
      finalUrl: `https://example.com/${n}`,
      title: `Page ${n}`,
      text,
      contentType: "text/html",
      bytes: text.length * 2,
      clipped: false,
      meta: {},
      agent: { id: "a1", name: "Nova" },
      turnId: "turn-1",
      fetchedAt: new Date(Date.UTC(2026, 8, 22, 10, n, 0)),
    },
    root
  );

test("a turn that read three pages records three pointers, with digests that match the files", () => {
  const { path, cleanup } = home();
  try {
    const kept = [0, 1, 2].map(n => page(path, n, `page ${n} said something worth quoting at length.`));
    const turns = new TurnLedger(join(path, "turns.jsonl"), () => {});
    const id = turns.begin({ agentId: "a1", about: "read three pages", id: "turn-1" });
    turns.end(
      id,
      "done",
      new Date(),
      undefined,
      kept.map((one, n) => ({ path: one.path, sha256: one.sha256, chars: 40 + n, at: "2026-09-22T10:00:00.000Z" }))
    );

    const recorded = turns.evidence();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, "turn-1");
    assert.deepEqual(
      recorded[0]!.kept.map(one => one.sha256),
      kept.map(one => one.sha256)
    );
    // And the edge resolves both ways now: the set is what the retention pass reads.
    assert.deepEqual([...referencedKeptPaths(path)].sort(), kept.map(one => one.path).sort());
  } finally {
    cleanup();
  }
});

test("the quote gate reaches the sources through the edge, and tells a real quote from an invented one", () => {
  const { path, cleanup } = home();
  try {
    const real = page(path, 0, "The study found that grounding improves factual accuracy across benchmarks.");
    const other = page(path, 1, "先做错误分析，再决定评估什么。这是作者给出的第一条建议。");
    const edge = [real, other].map(one => ({ path: one.path, sha256: one.sha256 }));

    const sources = readKeptSources(edge);
    assert.equal(sources.length, 2);

    const answer =
      'The page says "grounding improves factual accuracy across benchmarks" and 作者写道「先做错误分析，再决定评估什么」。' +
      'It also claims "the authors withdrew the paper after review".';
    const report = checkQuotes(answer, sources);
    assert.equal(report.exact, 2);
    assert.equal(report.notLocated, 1);
    assert.match(report.checked[2]!.quote, /withdrew the paper/);
  } finally {
    cleanup();
  }
});

test("a page a live turn still points at outlives its retention", () => {
  const { path, cleanup } = home();
  try {
    resetKeptPruneClock();
    const cited = page(path, 0, "the page a turn still cites");
    const forgotten = page(path, 1, "the page nothing cites");
    const now = new Date(Date.UTC(2026, 11, 31));
    // Both are far past the retention by age.
    const old = new Date(now.getTime() - 200 * 86_400_000);
    for (const one of [cited, forgotten]) utimesSync(one.path, old, old);

    const turns = new TurnLedger(join(path, "turns.jsonl"), () => {});
    const id = turns.begin({ agentId: "a1", about: "cited one of them", id: "turn-1" });
    turns.end(id, "done", now, undefined, [
      { path: cited.path, sha256: cited.sha256, chars: 26, at: "2026-09-22T10:00:00.000Z" },
    ]);

    const result = pruneFetched(path, { retentionDays: 90, now, referenced: referencedKeptPaths(path) });
    assert.equal(result.removed, 1, "the uncited one goes");
    assert.ok(statSync(cited.path).isFile(), "the cited one stays");
    assert.throws(() => statSync(forgotten.path));
  } finally {
    cleanup();
  }
});

test("without the edge, retention behaves exactly as it did before", () => {
  const { path, cleanup } = home();
  try {
    const one = page(path, 0, "nothing points at this");
    const now = new Date(Date.UTC(2026, 11, 31));
    const old = new Date(now.getTime() - 200 * 86_400_000);
    utimesSync(one.path, old, old);
    // No ledger at all: nothing is protected, retention still runs, which is the safe
    // direction and the behaviour from before this existed.
    assert.deepEqual([...referencedKeptPaths(path)], []);
    assert.equal(pruneFetched(path, { retentionDays: 90, now }).removed, 1);
  } finally {
    cleanup();
  }
});

test("a pointer to something already gone is skipped, not an error", () => {
  const { path, cleanup } = home();
  try {
    const one = page(path, 0, "here for now");
    const edge = [{ path: one.path, sha256: one.sha256 }, { path: join(path, "gone.md"), sha256: "0".repeat(64) }];
    // The retention taking an artefact is the expected end of its life, not a failure. The
    // pointer still describes what was there; a caller needing the difference asks
    // verifyPointer.
    const sources = readKeptSources(edge);
    assert.equal(sources.length, 1);
    assert.match(sources[0]!.text, /here for now/);
  } finally {
    cleanup();
  }
});

test("a kept tool result joins the same edge as a kept page", () => {
  const { path, cleanup } = home();
  try {
    resetKeptPruneClock();
    const result = keepToolResult(
      { text: "what the tool returned, at length, worth quoting.", turnId: "turn-9", toolUseId: "u1", tool: "browser_read", agent: { id: "a1", name: "Nova" }, at: new Date() },
      path
    );
    const turns = new TurnLedger(join(path, "turns.jsonl"), () => {});
    const id = turns.begin({ agentId: "a1", about: "one tool call", id: "turn-9" });
    turns.end(id, "done", new Date(), undefined, [
      { path: result.path, sha256: result.sha256, chars: 48, at: new Date().toISOString() },
    ]);
    assert.ok(referencedKeptPaths(path).has(result.path));
    assert.match(readKeptSources([result])[0]!.text, /what the tool returned/);
  } finally {
    cleanup();
  }
});
