/**
 * Whatever a tool said, kept by whoever cut it.
 *
 * A tool result is trimmed to `DURABLE_RESULT_CHARS` before the transcript stores it
 * (`storableResult`, turn.ts). The trim happens in exactly one place; keeping the rest did
 * not. Three producers thought to spill on their own — the box for shell output, WebFetch
 * for a page, the X reader for a post — and every other tool's overflow was gone the
 * moment the turn ended: `browser_read`, `ReadFeishuDoc`, a file read, anything an MCP
 * server returns, the text a computer-use call comes back with.
 *
 * That split is the defect. A producer has no idea what the transcript will do with its
 * output, so asking each one to remember is asking for the same bug once per tool, forever
 * — and the tools that forgot were not the rare ones. So the cut keeps what it cuts. The
 * caller passes who and when; this writes the whole text under the box's home and hands
 * back a pointer, and `storableResult` appends the pointer in the same words the box
 * already uses, which the transcript, the anchor extractor and `ReadHistory` all know.
 *
 * Not for the model. The path is on the host, outside the box, so an agent cannot read it
 * back with `read_file` — the same as a kept page (fetched.ts). It is for the person who
 * asks later what a tool actually returned.
 *
 * Kept for the same bounded time as fetched pages, under the same setting, and taken by
 * the same pass.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { fetchedDir, pruneFetched, readFrontmatter, retentionDays, sha256 } from "./fetched.ts";
import { TurnLedger } from "./resume.ts";

export const RESULTS_DIRNAME = "results";

/**
 * The words the pointer is written in.
 *
 * Deliberately the box's phrase and not a new one: `storableResult` already carries this
 * across the cut, `extractAnchors` already treats it as the most expensive thing to lose,
 * and the system prompt already tells agents what it means. A second wording would have
 * been a second thing for all three to learn.
 */
export const RESULT_KEPT_MARKER = "full output kept:";

export function resultsDir(home = agentboxHome()): string {
  return join(home, RESULTS_DIRNAME);
}

export interface KeepResultInput {
  /** Everything the tool returned, however long. */
  text: string;
  /** The turn the call belongs to, as the transcript entries carry it. */
  turnId: string;
  /** The API's id for this call, which is what ties the file to one `tool_use` block. */
  toolUseId: string;
  /** The tool's name, when the caller knows it. */
  tool?: string;
  agent: { id: string; name: string };
  conversation?: string;
  /** True when the tool itself reported a failure: a failed result is still a record. */
  isError?: boolean;
  at: Date;
}

export interface KeptResult {
  path: string;
  sha256: string;
}

/** Slashes and dots out: these go into a file name and must not go up a directory. */
function safe(part: string): string {
  return part.replace(/[^\w.-]/g, "-").replace(/\.+/g, ".").slice(0, 80) || "unknown";
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Where a result lands: one file per call, in the month it happened.
 *
 * Keyed by turn and call rather than by a digest of the text, so two calls that returned
 * the same bytes stay two records — "it ran twice" is a fact about what happened.
 */
export function keptResultPath(
  input: Pick<KeepResultInput, "turnId" | "toolUseId" | "at">,
  home = agentboxHome()
): string {
  const month = input.at.toISOString().slice(0, 7);
  return join(resultsDir(home), month, `${safe(input.turnId)}-${safe(input.toolUseId)}.txt`);
}

/** The head of a kept result. Same shape as a kept page's, so the audit export reads both. */
export function resultFrontmatter(input: KeepResultInput, bodySha256: string): string {
  return [
    "---",
    "schema: lumenbox.result/v1",
    ...(input.tool !== undefined ? [`tool: ${quote(input.tool)}`] : []),
    `tool_use_id: ${quote(input.toolUseId)}`,
    `turn_id: ${quote(input.turnId)}`,
    `at: ${input.at.toISOString()}`,
    `text_chars: ${input.text.length}`,
    ...(input.isError === true ? ["is_error: true"] : []),
    `sha256: ${bodySha256}`,
    `agent_id: ${quote(input.agent.id)}`,
    `agent: ${quote(input.agent.name)}`,
    ...(input.conversation !== undefined ? [`conversation: ${quote(input.conversation)}`] : []),
    "---",
    "",
  ].join("\n");
}

/**
 * Writes the whole result and says where it went.
 *
 * Throws only what the filesystem throws; the caller treats a failure as "no pointer"
 * rather than as a failed turn, because a turn that cannot be filed is still a turn that
 * happened.
 */
export function keepToolResult(input: KeepResultInput, home = agentboxHome()): KeptResult {
  const path = keptResultPath(input, home);
  mkdirSync(join(path, ".."), { recursive: true });
  const digest = sha256(input.text);
  writeFileSync(path, `${resultFrontmatter(input, digest)}${input.text}\n`, { mode: 0o600 });
  pruneKeptOccasionally(line => console.error(line), home, input.at, referencedKeptPaths(home));
  return { path, sha256: digest };
}

/** How often a write is allowed to trigger the retention pass. */
const PRUNE_EVERY_MS = 3_600_000;
let lastPruneAt = 0;

/**
 * Takes both kept directories in one pass, rarely, on the way past a write.
 *
 * Deliberately keyed to the home the write used rather than to `agentboxHome()`. A pass
 * that resolves its own home is a pass that can delete files in a directory the caller
 * never named — under test the global default refuses to resolve at all, which is how
 * this was caught, and in production it would have been the wrong box's files.
 *
 * Both roots together because a kept page and a kept result are the same kind of thing
 * under the same setting, and two passes would be two clocks saying one sentence.
 */
export function pruneKeptOccasionally(
  log: (line: string) => void,
  home: string,
  now = new Date(),
  /** Paths a live turn still points at; kept past their age (INV-665). */
  referenced?: ReadonlySet<string>
): void {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now.getTime();
  try {
    const days = retentionDays();
    const result = pruneFetched(home, {
      retentionDays: days,
      now,
      roots: [fetchedDir(home), resultsDir(home)],
      ...(referenced !== undefined ? { referenced } : {}),
    });
    if (result.removed > 0) log(`[kept] removed ${result.removed} file(s) older than ${days} days; ${result.kept} kept`);
  } catch (error) {
    log(`[kept] prune failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Everything a turn in the live ledger says it read and kept.
 *
 * Read from the home the caller was handed, not from the global default, for the reason
 * INV-633 learned the hard way: a pass that resolves its own home can delete files in a
 * directory nobody named.
 *
 * The live file only. A turn old enough to have been archived is older than the retention
 * on anything it points at, so scanning months of archive would cost a great deal to
 * protect nothing.
 */
export function referencedKeptPaths(home: string): ReadonlySet<string> {
  const paths = new Set<string>();
  try {
    for (const turn of new TurnLedger(join(home, "turns.jsonl"), () => {}).evidence()) {
      for (const kept of turn.kept) paths.add(kept.path);
    }
  } catch {
    // No ledger, or an unreadable one. Nothing is protected, which is the behaviour from
    // before this existed, and is the safe direction: retention still runs.
  }
  return paths;
}

/** Only for tests, which need the hour to start over. */
export function resetKeptPruneClock(): void {
  lastPruneAt = 0;
}

export interface FoundResult {
  text: string;
  path: string;
  tool?: string;
  at: string;
  sha256: string;
  /** Whole characters in the body, whatever slice the caller asked for. */
  chars: number;
}

/**
 * Finds a kept result by the call that produced it, for the agent that produced it.
 *
 * Ownership is checked here rather than by the caller, and a result belonging to someone
 * else answers exactly as a result that does not exist: `undefined`. The distinction would
 * be a way to ask whether a given call id exists at all, which is a question no agent has
 * any business answering about another.
 *
 * Searched by walking the month directories rather than by an index, because the name
 * carries the turn and the call and a directory listing is the index. The window is the
 * retention window; past it there is nothing to find, and the pointer in the transcript is
 * what still describes what was there (INV-659).
 */
export function findKeptResult(
  toolUseId: string,
  owner: { agentId: string; conversation?: string },
  home = agentboxHome()
): FoundResult | undefined {
  const root = resultsDir(home);
  let months: string[];
  try {
    months = readdirSync(root);
  } catch {
    return undefined;
  }
  const wanted = `-${safe(toolUseId)}.txt`;
  for (const month of months.sort().reverse()) {
    let names: string[];
    try {
      names = readdirSync(join(root, month));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(wanted)) continue;
      const path = join(root, month, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const head = readFrontmatter(text);
      if (head.agent_id !== owner.agentId) return undefined;
      // A result from another conversation is another room's, even for the same agent.
      if (head.conversation !== undefined && head.conversation !== owner.conversation) return undefined;
      const end = text.indexOf("\n---\n", 4);
      const body = end === -1 ? "" : text.slice(end + 5).replace(/\n$/, "");
      return {
        text: body,
        path,
        ...(head.tool !== undefined ? { tool: head.tool } : {}),
        at: head.at ?? "",
        sha256: head.sha256 ?? "",
        chars: body.length,
      };
    }
  }
  return undefined;
}

/**
 * The text behind a turn's evidence pointers, for anything that needs to read it back.
 *
 * Missing files are skipped rather than reported: a pointer to something the retention has
 * taken is not an error, it is the expected end of an artefact's life, and the pointer
 * itself still describes what was there (INV-659). A caller that needs to know the
 * difference asks `verifyPointer`.
 */
export function readKeptSources(
  kept: readonly { path: string; sha256: string }[]
): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const one of kept) {
    let text: string;
    try {
      text = readFileSync(one.path, "utf8");
    } catch {
      continue;
    }
    const end = text.indexOf("\n---\n", 4);
    out.push({
      name: one.path.split("/").slice(-2).join("/"),
      text: end === -1 ? text : text.slice(end + 5).replace(/\n$/, ""),
    });
  }
  return out;
}
