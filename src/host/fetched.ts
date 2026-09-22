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
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import type { PageMeta } from "./web.ts";

export const FETCHED_DIRNAME = "fetched";
/** The words a pointer to a kept page is written with. Read back by `storableResult`. */
export const KEPT_MARKER = "full page kept:";
export const FETCHED_RETENTION_VARIABLE = "AGENTBOX_FETCHED_RETENTION_DAYS";
const DEFAULT_RETENTION_DAYS = 90;

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
 * the same instant, but a name is a claim and an mtime is a fact. Nothing but `.md` and
 * `.json` files under the directory is touched.
 */
export function pruneFetched(
  home = agentboxHome(),
  options: { retentionDays?: number; now?: Date } = {}
): PruneResult {
  const root = fetchedDir(home);
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
      if (!/\.(md|json)$/.test(name)) continue;
      if (stat.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        result.removed += 1;
      } else {
        result.kept += 1;
      }
    }
  };
  walk(root);
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
export function pruneOccasionally(log: (line: string) => void, home = agentboxHome(), now = new Date()): void {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now.getTime();
  try {
    const days = retentionDays();
    const result = pruneFetched(home, { retentionDays: days, now });
    if (result.removed > 0) log(`[fetched] removed ${result.removed} kept page(s) older than ${days} days; ${result.kept} kept`);
  } catch (error) {
    log(`[fetched] prune failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Only for tests, which need the hour to start over. */
export function resetPruneClock(): void {
  lastPruneAt = 0;
}
