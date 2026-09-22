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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { fetchedDir, pruneFetched, retentionDays, sha256 } from "./fetched.ts";

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
  pruneKeptOccasionally(line => console.error(line), home, input.at);
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
export function pruneKeptOccasionally(log: (line: string) => void, home: string, now = new Date()): void {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now.getTime();
  try {
    const days = retentionDays();
    const result = pruneFetched(home, { retentionDays: days, now, roots: [fetchedDir(home), resultsDir(home)] });
    if (result.removed > 0) log(`[kept] removed ${result.removed} file(s) older than ${days} days; ${result.kept} kept`);
  } catch (error) {
    log(`[kept] prune failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Only for tests, which need the hour to start over. */
export function resetKeptPruneClock(): void {
  lastPruneAt = 0;
}
