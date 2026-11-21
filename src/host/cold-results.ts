/**
 * Old tool results left out of a request once the provider's cache has gone cold (INV-703).
 *
 * A member is long-lived and is woken hours apart — by a teammate, a routine, a person coming
 * back after lunch. By then the provider has forgotten the cached prefix, and the whole history is
 * billed as new input. Most of that history is old tool output: shell logs, file reads, listings,
 * searches the member read, acted on, and is done with. Re-sending it verbatim buys nothing.
 *
 * So on a cold request, old results from tools whose output is a reading are replaced by one line
 * that says what was there, how long it was, and how to get it back: ReadKept by the call's id,
 * which answers from the host's kept copy or, failing that, from the transcript itself
 * (`recordedResult` below). Nothing is re-run to get it back, so the read-back has no side effect
 * and gives the answer the member actually saw, not today's.
 *
 * Three rules make this safe:
 *
 * - **The request changes, never the record.** The same principle as compaction (compaction.ts):
 *   the transcript keeps every byte; this works on a copy of the entries just before they are
 *   turned into messages.
 * - **A warm cache is never touched.** The cache is a prefix match, so rewriting an early byte
 *   throws away everything cached after it — the opposite of saving. Clearing happens only at a
 *   point where the cache is already cold, and the point is read off the transcript's own
 *   timestamps, so every later request finds the same point and clears the same results: the
 *   prefix that the cold request wrote to the cache is the prefix every warm request after it
 *   sends again, byte for byte.
 * - **Pairing is untouched.** A cleared result keeps its block, its `tool_use_id` and its call;
 *   only the text inside changes, so every adapter (the Messages wire, the OpenAI translation)
 *   sees the same shape it always did.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { activeWindow, CHARS_PER_TOKEN, estimateTokens, type HistoryEntry, policyForModel } from "./compaction.ts";
import type { ProviderProfile } from "./provider.ts";
import { isReadTool } from "./read-load.ts";
import type { FoundResult } from "./results.ts";
import { sha256 } from "./fetched.ts";

/**
 * How long the provider keeps a cached prefix, or undefined when we do not know of one.
 *
 * - Explicit breakpoints (`promptCaching`): we send `cache_control: { type: "ephemeral" }` with no
 *   `ttl` (turn.ts), and the documented lifetime of such a breakpoint is five minutes from its
 *   last use.
 * - An implicit prefix cache (`implicitCaching`, MiniMax's): no lifetime is promised. Automatic
 *   prefix caches are described as holding a prefix for minutes, up to an hour when idle; the
 *   hour is taken, because guessing short is the direction that rewrites a warm prefix.
 * - Neither: no cache we know of, and so no idle time that means anything. Only the pressure
 *   trigger applies; clearing on every turn of such a provider would change what the member sees
 *   for no reason this change is about.
 */
export const EPHEMERAL_CACHE_TTL_MS = 5 * 60_000;
export const IMPLICIT_CACHE_TTL_MS = 60 * 60_000;

export function promptCacheTtlMs(provider: Pick<ProviderProfile, "promptCaching" | "implicitCaching">): number | undefined {
  if (provider.promptCaching) return EPHEMERAL_CACHE_TTL_MS;
  if (provider.implicitCaching === true) return IMPLICIT_CACHE_TTL_MS;
  return undefined;
}

/** The newest result groups before the cold point stay whole: the member's working set. */
export const KEEP_RECENT_RESULT_GROUPS = 5;
/** Below this the rewrite is not worth the change to what the member sees. */
export const MIN_SAVING_TOKENS = 256;
/** Share of the compaction trigger at which a warm request is cleared anyway: compaction is next. */
export const PRESSURE_SHARE = 0.9;

/**
 * Whose results are a reading that may be cleared.
 *
 * The reading tools (read-load.ts: files, listings, searches, pages, history) and the shell. A
 * shell command may have changed the box, but its output is a record of what it printed, and the
 * way back is that record, never running the command again. Everything else is kept: a person's
 * answer (AskUser), a teammate's (SendToAgent, Delegate), the screen (computer), a host command
 * whose record was withheld (RunOnHost), a connector's tool we cannot see into.
 */
export function isClearableTool(name: string | undefined): boolean {
  return name !== undefined && (isReadTool(name) || name === "bash");
}

/** The one line a cleared result becomes. Its length is part of the saving, so it is short. */
export function clearedResultText(input: { tool: string; toolUseId: string; chars: number }): string {
  return (
    `[older ${input.tool} output (${input.chars.toLocaleString("en-US")} chars) left out of this request; ` +
    `the record keeps it. ReadKept with call "${input.toolUseId}" returns it — do not run the call again to see it.]`
  );
}

export interface ColdClearing {
  entries: readonly HistoryEntry[];
  /** How many results became placeholders. Zero means `entries` is the input, untouched. */
  cleared: number;
  /** Characters taken out of the request. */
  savedChars: number;
}

function atMs(entry: HistoryEntry): number {
  const ms = Date.parse(entry.at);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Where the cache went cold: entries before this index were last sent to a cache that has since
 * expired. -1 when it has not.
 *
 * Read off the record so it is the same answer on every later request: the newest gap between two
 * consecutive entries longer than the lifetime, or — when the request being built now is itself
 * the first after such a gap — the end of the history. Under pressure the end of the history,
 * whatever the clock says.
 */
export function coldPoint(entries: readonly HistoryEntry[], options: { now: number; ttlMs?: number; pressure?: boolean }): number {
  if (entries.length === 0) return -1;
  if (options.pressure === true) return entries.length;
  const ttl = options.ttlMs;
  if (ttl === undefined) return -1;
  if (options.now - atMs(entries[entries.length - 1]!) > ttl) return entries.length;
  for (let index = entries.length - 1; index > 0; index--) {
    if (atMs(entries[index]!) - atMs(entries[index - 1]!) > ttl) return index;
  }
  return -1;
}

function textOnly(block: Anthropic.ToolResultBlockParam): string | undefined {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return undefined;
  if (!block.content.every(part => part.type === "text")) return undefined;
  return block.content.map(part => (part as Anthropic.TextBlockParam).text).join("\n");
}

/** Tool name by call id, from the assistant entries. */
function callNames(entries: readonly HistoryEntry[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!("kind" in entry) || entry.kind !== "blocks") continue;
    for (const block of entry.blocks) if (block.type === "tool_use") names.set(block.id, block.name);
  }
  return names;
}

/**
 * The entries with old reading results replaced by a line each. Pure: the same entries and options
 * give the same bytes, and nothing is written.
 *
 * Only results before the cold point are candidates, minus the newest `KEEP_RECENT_RESULT_GROUPS`
 * of them. A result after the cold point is one the member has not yet answered, or answered on a
 * warm cache; neither is touched. Errors stay (they are short and they are the lesson), and so does
 * anything that is not plain text.
 */
export function clearColdResults(
  entries: readonly HistoryEntry[],
  options: { now: number; ttlMs?: number; pressure?: boolean }
): ColdClearing {
  const untouched: ColdClearing = { entries, cleared: 0, savedChars: 0 };
  const cut = coldPoint(entries, options);
  if (cut <= 0) return untouched;

  const groups: number[] = [];
  for (let index = 0; index < cut; index++) {
    const entry = entries[index]!;
    if ("kind" in entry && entry.kind === "results") groups.push(index);
  }
  const candidates = new Set(groups.slice(0, Math.max(0, groups.length - KEEP_RECENT_RESULT_GROUPS)));
  if (candidates.size === 0) return untouched;

  const names = callNames(entries.slice(0, cut));
  let cleared = 0;
  let savedChars = 0;
  const rewritten = entries.map((entry, index) => {
    if (!candidates.has(index) || !("kind" in entry) || entry.kind !== "results") return entry;
    let changed = false;
    const blocks = entry.blocks.map(block => {
      const tool = names.get(block.tool_use_id);
      const text = textOnly(block);
      if (!isClearableTool(tool) || block.is_error === true || text === undefined) return block;
      const line = clearedResultText({ tool: tool!, toolUseId: block.tool_use_id, chars: text.length });
      if (line.length >= text.length) return block;
      changed = true;
      cleared += 1;
      savedChars += text.length - line.length;
      return { ...block, content: [{ type: "text" as const, text: line }] } satisfies Anthropic.ToolResultBlockParam;
    });
    return changed ? { ...entry, blocks } : entry;
  });
  if (cleared === 0 || savedChars / CHARS_PER_TOKEN < MIN_SAVING_TOKENS) return untouched;
  return { entries: rewritten, cleared, savedChars };
}

/**
 * What turn.ts sends instead of the history, when the cache is cold or compaction is near.
 *
 * Pressure is measured on the history as stored, not as cleared: that only grows until a summary
 * replaces it, so a request that was cleared for pressure is not followed by one that is not.
 */
export function requestHistory<T>(
  history: readonly T[],
  provider: Pick<ProviderProfile, "promptCaching" | "implicitCaching" | "model">,
  now = Date.now()
): T[] {
  const entries = history as unknown as readonly HistoryEntry[];
  const pressure = estimateTokens(activeWindow(entries)) >= PRESSURE_SHARE * policyForModel(provider.model).triggerTokens;
  const ttlMs = promptCacheTtlMs(provider);
  const result = clearColdResults(entries, { now, pressure, ...(ttlMs !== undefined ? { ttlMs } : {}) });
  if (result.cleared > 0) {
    console.error(`[compaction] left ${result.cleared} older tool result(s) out of the request (${result.savedChars} chars); the record is unchanged`);
  }
  return result.entries as unknown as T[];
}

/**
 * A result as the transcript recorded it, for ReadKept when the host kept no copy of its own —
 * which is every result short enough to be stored whole, and shell output the box spilled itself.
 *
 * Only for the tools whose results `clearColdResults` may clear: what the request can leave out is
 * exactly what this gives back. The transcript is the caller's own agent's in the caller's own
 * conversation, so ownership is the same as the kept copy's.
 */
export function recordedResult(transcript: readonly unknown[], toolUseId: string): FoundResult | undefined {
  const entries = transcript as readonly HistoryEntry[];
  const tool = callNames(entries).get(toolUseId);
  if (!isClearableTool(tool)) return undefined;
  for (const entry of entries) {
    if (!("kind" in entry) || entry.kind !== "results") continue;
    const block = entry.blocks.find(candidate => candidate.tool_use_id === toolUseId);
    const text = block === undefined ? undefined : textOnly(block);
    if (text === undefined) continue;
    return { text, path: "", tool: tool!, at: entry.at, sha256: sha256(text), chars: text.length };
  }
  return undefined;
}
