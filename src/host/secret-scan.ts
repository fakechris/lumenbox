/**
 * What credential-shaped text is in the records, and what is actually a secret.
 *
 * This exists because a number nobody can re-run is a claim rather than a measurement.
 * The design in docs/15 turns on one figure — that eleven credential patterns over this
 * installation's real records produced two matches and both were false — and the first
 * version of that figure came from a script typed into a shell once and never kept. The
 * adversarial review said so, and was right: the corpus, the scanner and the result were
 * all absent from the tree that stated the conclusion.
 *
 * Two questions, deliberately kept apart, because they have different reliabilities:
 *
 *   - **What matches a pattern?** Evidence *against* pattern redaction, not for it. Every
 *     match needs a human verdict; the point of running it is to count how many turn out
 *     to be real. On our corpus the answer was zero out of two.
 *   - **Does a value we hold appear verbatim?** Exact, no pattern involved, and the only
 *     question here with a trustworthy answer. Values are compared but never printed.
 *
 * Nothing here redacts anything. It reports. Rewriting a record does not un-read the
 * secret, and rotation is the remedy that helps — so the useful output is a list of
 * places to look, produced in a form somebody else can reproduce.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Credential shapes, by vendor prefix or structure rather than by entropy.
 *
 * "Long string with digits" matches base64 payloads, hashes, minified code and Chinese
 * text encoded in a URL. These are the forms that carry their own identification.
 */
export const CREDENTIAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "aws-akid", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "openai-anthropic", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "feishu-app", pattern: /\bcli_[a-z0-9]{16,}\b/g },
  { name: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "url-token",
    pattern: /[?&](?:access_token|api_key|token|key|secret|password)=[^&\s"']{8,}/g,
  },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: "assign-secret",
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["']?[^\s"',;]{12,}/gi,
  },
];

export interface PatternHit {
  file: string;
  pattern: string;
  /** Enough to judge it by, and short enough that this report is not itself the leak. */
  excerpt: string;
}

export interface ExactHit {
  file: string;
  /** Which held value, by its name. The value is never carried. */
  name: string;
}

export interface ScanResult {
  filesScanned: number;
  bytesScanned: number;
  patternHits: PatternHit[];
  exactHits: ExactHit[];
}

/** Every `.jsonl` and `.md` under a root, which is what the records are made of. */
export function recordFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // A directory that cannot be read is not a scan failure.
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(jsonl|md|json)$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * Scans text for both questions.
 *
 * `held` maps a name to a value we already possess — vault entries, configured tokens.
 * Short ones are skipped rather than matched: a held value of `admin` would report every
 * occurrence of the word, which is the false-positive problem the pattern half already
 * has and the exact half exists to avoid.
 */
export const MIN_EXACT_LENGTH = 12;

export function scanText(
  text: string,
  held: ReadonlyMap<string, string> = new Map()
): { patterns: { pattern: string; excerpt: string }[]; exact: string[] } {
  const patterns: { pattern: string; excerpt: string }[] = [];
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    // Fresh each time: a /g regex carries lastIndex between calls.
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      patterns.push({ pattern: name, excerpt: excerptOf(match[0]) });
    }
  }
  const exact: string[] = [];
  for (const [name, value] of held) {
    if (value.length < MIN_EXACT_LENGTH) continue;
    if (text.includes(value)) exact.push(name);
  }
  return { patterns, exact };
}

/** Head only, so a report of a leak cannot become one. */
function excerptOf(match: string): string {
  const head = match.slice(0, 34);
  return match.length > 34 ? `${head}…(${match.length - 34} more)` : head;
}

/**
 * The credential stores, which are not scanned at all.
 *
 * The first real run reported two things, and both were the tool misunderstanding its own
 * job: "rotate FEISHU_APP_SECRET, it appears in config.json", and a `cli_…` app id
 * matching a pattern in the same file. Both are the store holding what a store holds.
 *
 * A first attempt excluded these files from the *exact* half only, on the reasoning that
 * a pattern hit there would mean "a secret is in a file with no business holding one" —
 * which is exactly backwards, and did not survive one real run. A credential store's
 * business is holding credentials. Scanning it says nothing, and a tool that cries wolf
 * about its own source of truth teaches people to ignore it, on the one occasion it
 * matters.
 */
export const CREDENTIAL_STORES: readonly string[] = ["config.json", "vault.json"];

function isCredentialStore(file: string): boolean {
  return CREDENTIAL_STORES.some(name => file.endsWith(`/${name}`));
}

export function scanRecords(root: string, held: ReadonlyMap<string, string>): ScanResult {
  const files = recordFiles(root);
  let bytes = 0;
  const patternHits: PatternHit[] = [];
  const exactHits: ExactHit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
      bytes += statSync(file).size;
    } catch {
      continue;
    }
    // A credential store holding credentials is not a finding, in either half.
    if (isCredentialStore(file)) continue;
    const { patterns, exact } = scanText(text, held);
    for (const hit of patterns) patternHits.push({ file, ...hit });
    for (const name of exact) exactHits.push({ file, name });
  }
  return { filesScanned: files.length, bytesScanned: bytes, patternHits, exactHits };
}

/** The report, in the shape the docs quote. */
export function describeScan(result: ScanResult): string[] {
  const lines = [
    `scanned ${(result.bytesScanned / 1e6).toFixed(1)} MB across ${result.filesScanned} files`,
  ];
  if (result.patternHits.length === 0) lines.push("no credential-shaped strings found");
  else {
    lines.push(
      `${result.patternHits.length} credential-shaped string(s) — each needs a human ` +
        `verdict; a match is not a secret:`
    );
    for (const hit of result.patternHits) {
      lines.push(`  ${hit.pattern.padEnd(18)} ${hit.excerpt}`);
    }
  }
  lines.push(
    result.exactHits.length === 0
      ? "no held value appears verbatim in any record"
      : `${result.exactHits.length} held value(s) appear verbatim — rotate them:`
  );
  for (const hit of result.exactHits) lines.push(`  ${hit.name} in ${hit.file}`);
  return lines;
}
