/**
 * What an agent read on the web, kept.
 *
 * A page an agent fetched is the evidence for whatever it then said about it, and until
 * now that evidence lived for one turn: the tool result is cut to two thousand
 * characters when the transcript is stored (docs/24), and nothing else held the page.
 * Asked a week later what an agent's "verified" claim was verified against, the honest
 * answer was "a page it read and we did not keep".
 *
 * So every fetch leaves a file: the whole extracted text — not the forty-thousand-
 * character slice the model saw — under a frontmatter that says where it came from, when,
 * who asked, and what the page said about itself (author, date, site). The tool result
 * ends with a pointer to the file, in the same words the box uses for spilled shell
 * output, so the pointer survives the transcript's cut the way that one already does.
 *
 * Kept for a bounded time. A file nobody has asked about in ninety days is not evidence
 * anyone is waiting for, and the directory is not an archive of the web.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import type { LedgerKind } from "./jsonl.ts";
import type { PageMeta } from "./web.ts";

export const FETCHED_DIRNAME = "fetched";
/** The words a pointer to a kept page is written with. Read back by `storableResult`. */
export const KEPT_MARKER = "full page kept:";
export const FETCHED_RETENTION_VARIABLE = "AGENTBOX_FETCHED_RETENTION_DAYS";
const DEFAULT_RETENTION_DAYS = 90;

/**
 * What the two evidence stores are, in the ledgers' own vocabulary (jsonl.ts).
 *
 * `feed`, honestly, and not `record`: a kept page or result falls off the back after
 * `AGENTBOX_FETCHED_RETENTION_DAYS`, which is what a feed does and what a record may not.
 *
 * That is only defensible because of INV-659: the pointer in the transcript carries the
 * digest, the size and the instant, so when the artefact goes the *record* still says what
 * existed. The reference degrades to a description rather than dangling. Without that, a
 * `record` ledger pointing in here would have been a record with a ninety-day memory.
 *
 * What is deliberately not implemented, so nobody assumes it: retention keyed to the work
 * the evidence supported (NARA's `Event_Age`, as against the `Creation_Age` used here).
 * Evidence almost always wants the former — ninety days after the thing it was cited in
 * closed, not ninety days after it was read — and we have no link from an artefact to the
 * work that cited it. Building that link is the prerequisite, not the retention rule.
 */
export const KEPT_KIND: LedgerKind = "feed";

export function fetchedDir(home = agentboxHome()): string {
  return join(home, FETCHED_DIRNAME);
}

export interface KeepPageInput {
  /** As asked for. */
  url: string;
  /** As answered, after redirects. */
  finalUrl: string;
  title?: string;
  /** The whole extracted text, however long. */
  text: string;
  contentType: string;
  bytes: number;
  /** Whether the model was shown less than this. */
  clipped: boolean;
  /**
   * What the read got, in the shared vocabulary (read-outcome.ts), and the counts behind
   * it. Kept because "the agent read this page" and "the agent was handed a tenth of this
   * page" are different facts, and only the second one explains a thin answer later.
   */
  completeness?: string;
  shape?: { prose: number; links: number };
  /**
   * Which route answered, when more than one could have.
   *
   * Only written when it is not the obvious one. An x.com page kept under `fetched/<month>/`
   * rather than `fetched/x/<id>/` was read from the page because both resolvers were
   * unreachable (INV-663), and a year later that is the difference between "the API said
   * this" and "this is what the login wall was showing".
   */
  fetcher?: string;
  meta: PageMeta;
  agent: { id: string; name: string };
  conversation?: string;
  turnId?: string;
  toolUseId?: string;
  fetchedAt: Date;
}

export interface KeptPage {
  path: string;
  sha256: string;
}

/**
 * What a pointer says, beyond where the file is.
 *
 * The digest used to live only inside the file it described, which meant the proof was
 * pruned along with the thing it proved: after ninety days the record held a path to a
 * file that no longer existed and could not say what had been there. Now the pointer
 * describes its own target, so an expired artefact degrades from "here it is" to "this is
 * what it was" instead of to nothing.
 *
 * This is the one universal recommendation in the retention literature and the same shape
 * as in-toto's `subject[].digest` and RFC 9530's `Repr-Digest` (docs/71 §7).
 */
export interface KeptPointer {
  /** `KEPT_MARKER` or `RESULT_KEPT_MARKER`. */
  marker: string;
  path: string;
  sha256: string;
  /** Characters in the body the digest is over. */
  chars: number;
  at: Date;
}

/**
 * Reads a pointer back. The path is the first token after the marker and never contains a
 * space, which is what `extractAnchors` and the box's own spill pointer already rely on.
 */
export const KEPT_POINTER_PATTERN =
  /\[full (?:output|page) kept: (\S+) — ([\d,]+) chars, sha256 ([0-9a-f]{64}), kept ([^\]\s]+)\]/;

/** One shape for both stores, so one regex reads either. Never contains `]`. */
export function keptPointer(input: KeptPointer): string {
  return (
    `[${input.marker} ${input.path} — ${input.chars.toLocaleString("en-US")} chars, ` +
    `sha256 ${input.sha256}, kept ${input.at.toISOString()}]`
  );
}

export function parseKeptPointer(text: string): Omit<KeptPointer, "marker"> | undefined {
  const match = KEPT_POINTER_PATTERN.exec(text);
  if (match === null) return undefined;
  return {
    path: match[1]!,
    chars: Number(match[2]!.replace(/,/g, "")),
    sha256: match[3]!,
    at: new Date(match[4]!),
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const quote = (value: string): string => JSON.stringify(value);

/** `<yyyy-mm>/<sha8-of-url>-<fetched_at>.md` — sortable by time, findable by URL. */
export function keptPathFor(input: { url: string; fetchedAt: Date }, home = agentboxHome()): string {
  const stamp = input.fetchedAt.toISOString();
  const month = stamp.slice(0, 7);
  const compact = stamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(fetchedDir(home), month, `${sha256(input.url).slice(0, 8)}-${compact}.md`);
}

/** The file's head: what a later reader needs to trust the body without refetching it. */
export function fetchedFrontmatter(input: KeepPageInput, bodySha256: string): string {
  const lines = [
    "---",
    "schema: lumenbox.fetched/v1",
    `url: ${quote(input.url)}`,
    `final_url: ${quote(input.finalUrl)}`,
    ...(input.title !== undefined ? [`title: ${quote(input.title)}`] : []),
    `fetched_at: ${input.fetchedAt.toISOString()}`,
    `content_type: ${quote(input.contentType)}`,
    `bytes: ${input.bytes}`,
    `text_chars: ${input.text.length}`,
    `clipped: ${input.clipped}`,
    ...(input.fetcher !== undefined ? [`fetcher: ${quote(input.fetcher)}`] : []),
    ...(input.completeness !== undefined ? [`completeness: ${input.completeness}`] : []),
    ...(input.shape !== undefined
      ? [`prose_blocks: ${input.shape.prose}`, `links: ${input.shape.links}`]
      : []),
    `sha256: ${bodySha256}`,
    ...(input.meta.author !== undefined ? [`author: ${quote(input.meta.author)}`] : []),
    ...(input.meta.published !== undefined ? [`published: ${quote(input.meta.published)}`] : []),
    ...(input.meta.siteName !== undefined ? [`site_name: ${quote(input.meta.siteName)}`] : []),
    `agent_id: ${quote(input.agent.id)}`,
    `agent: ${quote(input.agent.name)}`,
    ...(input.conversation !== undefined ? [`conversation: ${quote(input.conversation)}`] : []),
    ...(input.turnId !== undefined ? [`turn_id: ${quote(input.turnId)}`] : []),
    ...(input.toolUseId !== undefined ? [`tool_use_id: ${quote(input.toolUseId)}`] : []),
    "---",
    "",
  ];
  return lines.join("\n");
}

/** Reads the head back: the same keys, unquoted. Enough for the audit export to select by. */
export function readFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---\n")) return out;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return out;
  for (const line of text.slice(4, end).split("\n")) {
    const at = line.indexOf(": ");
    if (at === -1) continue;
    const key = line.slice(0, at);
    const raw = line.slice(at + 2);
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw;
      }
    }
    out[key] = value;
  }
  return out;
}

/** Writes the page and says where. Never overwrites: the name carries the instant. */
export function keepFetchedPage(input: KeepPageInput, home = agentboxHome()): KeptPage {
  const path = keptPathFor(input, home);
  mkdirSync(join(path, ".."), { recursive: true });
  const digest = sha256(input.text);
  writeFileSync(path, `${fetchedFrontmatter(input, digest)}${input.text}\n`, { mode: 0o600 });
  return { path, sha256: digest };
}

/** How long a kept page stays. Bounded above so a typo cannot mean forever. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FETCHED_RETENTION_VARIABLE];
  const parsed = raw === undefined || raw === "" ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(Math.floor(parsed), 3650);
}

export interface PruneResult {
  removed: number;
  kept: number;
}

/**
 * Removes kept files older than the retention, and the month directories they empty.
 *
 * By the file's own modification time, which is when it was written: the name carries
 * the same instant, but a name is a claim and an mtime is a fact. Nothing but `.md`,
 * `.json` and `.txt` files under the given roots is touched.
 *
 * Takes roots rather than one directory because kept tool results (results.ts) live under
 * the same retention and should not need a second pass, a second setting and a second
 * clock to say the same thing.
 */
export function pruneFetched(
  home = agentboxHome(),
  options: { retentionDays?: number; now?: Date; roots?: readonly string[] } = {}
): PruneResult {
  const roots = options.roots ?? [fetchedDir(home)];
  const days = options.retentionDays ?? retentionDays();
  const cutoff = (options.now ?? new Date()).getTime() - days * 86_400_000;
  const result: PruneResult = { removed: 0, kept: 0 };
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        try {
          if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
        } catch {
          // A directory that vanished or cannot be read is not this pass's problem.
        }
        continue;
      }
      if (!/\.(md|json|txt)$/.test(name)) continue;
      if (stat.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        result.removed += 1;
      } else {
        result.kept += 1;
      }
    }
  };
  for (const root of roots) walk(root);
  return result;
}

/** How often a fetch is allowed to trigger a prune: once an hour per process is plenty. */
const PRUNE_EVERY_MS = 3_600_000;
let lastPruneAt = 0;

/**
 * Prunes on the way past, rarely, and says so in one line when anything went.
 *
 * Called from the fetch path rather than a timer so an installation that never fetches
 * never pays for it, and one that does keeps the directory bounded without a scheduler.
 */
export function pruneOccasionally(
  log: (line: string) => void,
  home = agentboxHome(),
  now = new Date(),
  /** Directories to take in the same pass — kept tool results, when the caller has them. */
  extraRoots: readonly string[] = []
): void {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now.getTime();
  try {
    const days = retentionDays();
    const result = pruneFetched(home, { retentionDays: days, now, roots: [fetchedDir(home), ...extraRoots] });
    if (result.removed > 0) log(`[fetched] removed ${result.removed} kept page(s) older than ${days} days; ${result.kept} kept`);
  } catch (error) {
    log(`[fetched] prune failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Only for tests, which need the hour to start over. */
export function resetPruneClock(): void {
  lastPruneAt = 0;
}

export interface KeptVerification {
  /** Digest in the frontmatter matched the body, and the counts agreed. */
  verified: number;
  /** The file is there and the body is not what the frontmatter says it is. */
  mismatched: number;
  /** A pointer named it and it is not there. Only counted when asked about a pointer. */
  missing: number;
  /** Which files failed, by path, so a report can name them rather than only count them. */
  failures: { path: string; why: "mismatched" | "missing" }[];
}

/**
 * Re-reads what was kept and checks it is still what it said it was.
 *
 * The digest was being written and never read. A kept page edited by hand, truncated by a
 * full disk, or corrupted on its way through a backup looked exactly like an intact one,
 * and the audit export would have carried it out as evidence. This is the cheapest thing
 * in the whole retention literature that turns a stored digest from an inert field into
 * something that does work.
 *
 * Only `.md` and `.txt` files with a readable frontmatter are checked; a file without one
 * is not ours to have an opinion about. `missing` is always zero here, because a directory
 * walk cannot see a file that is not in it — `verifyPointer` is the one that can.
 */
export function verifyKept(home = agentboxHome(), options: { roots?: readonly string[] } = {}): KeptVerification {
  const roots = options.roots ?? [fetchedDir(home), join(home, "results")];
  const out: KeptVerification = { verified: 0, mismatched: 0, missing: 0, failures: [] };
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(md|txt)$/.test(name)) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const head = readFrontmatter(text);
      const claimed = head.sha256;
      if (claimed === undefined) continue;
      // The body is everything after the closing fence, and the writer adds one trailing
      // newline that is not part of what was hashed.
      const end = text.indexOf("\n---\n", 4);
      const body = end === -1 ? "" : text.slice(end + 5).replace(/\n$/, "");
      const chars = head.text_chars;
      if (sha256(body) === claimed && (chars === undefined || Number(chars) === body.length)) {
        out.verified += 1;
      } else {
        out.mismatched += 1;
        out.failures.push({ path, why: "mismatched" });
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * Checks one pointer against what it points at.
 *
 * Three answers, and the third is the one this exists for: `missing` means the record
 * still describes the thing, which after INV-659 is a real answer rather than a dead end.
 */
export function verifyPointer(pointer: string): { state: "verified" | "mismatched" | "missing"; sha256?: string } {
  const parsed = parseKeptPointer(pointer);
  if (parsed === undefined) return { state: "missing" };
  let text: string;
  try {
    text = readFileSync(parsed.path, "utf8");
  } catch {
    // Gone, and the pointer still says what it was. That is the whole point of the digest
    // living out here rather than only inside the file.
    return { state: "missing", sha256: parsed.sha256 };
  }
  const end = text.indexOf("\n---\n", 4);
  const body = end === -1 ? text : text.slice(end + 5).replace(/\n$/, "");
  return sha256(body) === parsed.sha256
    ? { state: "verified", sha256: parsed.sha256 }
    : { state: "mismatched", sha256: parsed.sha256 };
}
