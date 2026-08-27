/**
 * Tests for the record scanner.
 *
 * The scanner exists because the number docs/15 turns on was produced by a script run
 * once in a shell and never kept — the review's sharpest finding. So the first thing
 * these tests pin is the finding itself: **the two strings that matched on our real
 * corpus are both false positives**, and they must keep matching, because the moment a
 * pattern stops matching them the evidence against pattern redaction quietly evaporates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_EXACT_LENGTH,
  describeScan,
  scanRecords,
  scanText,
  type ScanResult,
} from "./secret-scan.ts";

test("the two real false positives still match, because they are the evidence", () => {
  // Verbatim from this installation's records, 2026-08-26. A URL query parameter that
  // happens to be named `key` carrying a Chinese search term, and a code snippet
  // demonstrating the correct practice of reading a key from the environment.
  const searchTerm = scanText("https://example.com/s?q=x&key=全国中小企业融资综合信用服务平台");
  assert.deepEqual(
    searchTerm.patterns.map(hit => hit.pattern),
    ["url-token"],
    "the search-term false positive must keep matching; it is why pattern redaction was rejected"
  );

  const codeSnippet = scanText("const client = new XAI({ apiKey: process.env.XAI_API_KEY });");
  assert.deepEqual(
    codeSnippet.patterns.map(hit => hit.pattern),
    ["assign-secret"],
    "the correct-practice snippet must keep matching; redacting it would mangle a code example"
  );
});

test("a real credential shape is found", () => {
  // Structurally unambiguous forms, which is the narrow set worth alerting on.
  const found = scanText(
    "AKIAIOSFODNN7EXAMPLE and ghp_012345678901234567890123456789012345 and\n" +
      "-----BEGIN RSA PRIVATE KEY-----"
  );
  assert.deepEqual(found.patterns.map(hit => hit.pattern).sort(), [
    "aws-akid",
    "github-pat",
    "private-key",
  ]);
});

test("a held value is found by equality, and never printed", () => {
  const held = new Map([["GITHUB_TOKEN", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]]);
  const found = scanText("the log said ghp_abcdefghijklmnopqrstuvwxyz0123456789 oops", held);
  assert.deepEqual(found.exact, ["GITHUB_TOKEN"]);

  const result: ScanResult = {
    filesScanned: 1,
    bytesScanned: 100,
    patternHits: [],
    exactHits: [{ file: "/x/transcript.jsonl", name: "GITHUB_TOKEN" }],
  };
  const report = describeScan(result).join("\n");
  assert.match(report, /rotate them/);
  assert.ok(
    !report.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    "a report of a leak must not become one"
  );
});

test("a short held value is skipped rather than matched everywhere", () => {
  // A vault entry whose value is "admin" would otherwise report every occurrence of the
  // word — the exact half exists to avoid precisely the false positives the pattern half
  // has, so it declines the cases where it cannot deliver that.
  const held = new Map([["PIN", "admin"]]);
  assert.deepEqual(scanText("the admin panel is at /admin", held).exact, []);
  assert.ok(MIN_EXACT_LENGTH > "admin".length);
});

test("a long match is excerpted, so the report is not the leak", () => {
  const long = `sk-${"a".repeat(80)}`;
  const [hit] = scanText(long).patterns;
  assert.ok(hit !== undefined);
  assert.ok(hit.excerpt.length < 50, `excerpt should be short, got ${hit.excerpt.length}`);
  assert.ok(!long.includes(hit.excerpt) || hit.excerpt.includes("more)"));
});

test("a clean corpus says so in both halves", () => {
  const report = describeScan({
    filesScanned: 26,
    bytesScanned: 1_100_000,
    patternHits: [],
    exactHits: [],
  }).join("\n");
  assert.match(report, /1\.1 MB across 26 files/);
  assert.match(report, /no credential-shaped strings found/);
  assert.match(report, /no held value appears verbatim/);
});

test("the credential store is not reported as a leak of its own credentials", () => {
  // The first real run said "rotate FEISHU_APP_SECRET, it appears in config.json" — which
  // is where it is kept. A tool that cries wolf about its own source of truth teaches
  // people to ignore it, and the one time it matters they will.
  const home = mkdtempSync(join(tmpdir(), "lumen-scan-"));
  try {
    const secret = "s3cr3t-value-long-enough";
    writeFileSync(join(home, "config.json"), JSON.stringify({ env: { TOKEN: secret } }));
    writeFileSync(join(home, "transcript.jsonl"), JSON.stringify({ text: `oops ${secret}` }));
    const held = new Map([["config.env.TOKEN", secret]]);
    const result = scanRecords(home, held);
    assert.deepEqual(
      result.exactHits.map(hit => hit.file.split("/").pop()),
      ["transcript.jsonl"],
      "only the record that should not hold it is a finding"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
