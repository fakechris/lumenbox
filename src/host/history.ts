/**
 * Reading back what compaction summarised away.
 *
 * Compaction was written with a claim attached: the transcript keeps every entry, including the tool
 * blocks, which is what makes an agent's account of itself checkable. That is true for a *person*
 * reading the file. It was not true for the agent — the transcript lives in the orchestrator's state
 * directory, and the box's uid cannot read it:
 *
 *     $ docker exec --user box … ls /home/hostd/.agentbox/agents/
 *     ls: Permission denied
 *
 * So after "the first 127 entries were summarised", an agent needing a detail from entry 40 had no
 * path to it at all. The uid split is right and stays; what was missing is a way *through* the
 * orchestrator, which is what this is.
 *
 * Two things shape it:
 *
 * **It is offered only when there is something to look back at.** A tool advertising access to a
 * history that was never summarised invites a call that returns what the agent can already see —
 * the same mistake, in the other direction, as a prompt pointing the model at a file that does not
 * exist.
 *
 * **It returns a reading, not a replay.** Re-emitting raw content blocks would pour the very context
 * compaction removed back into the request. Entries are rendered compactly — what was said, what was
 * called, what came back in brief — and bounded, with indices so the agent can ask for more.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** One transcript entry, in the shapes turn.ts writes. */
type Entry =
  | { role: "user" | "assistant"; text: string; at: string }
  | { role: "assistant"; kind: "blocks"; blocks: Anthropic.ContentBlockParam[]; at: string }
  | { role: "user"; kind: "results"; blocks: Anthropic.ToolResultBlockParam[]; at: string }
  | { role: "user"; kind: "summary"; covers: number; text: string; at: string };

/** How much of any one entry is shown. Enough to recognise it, not enough to re-fill the context. */
export const ENTRY_CHARS = 600;

/** The most entries one call returns, so a wide search cannot undo a compaction. */
export const MAX_ENTRIES = 25;

/** Whether this history has been compacted, and so whether there is anything hidden to offer. */
export function hasSummary(entries: readonly unknown[]): boolean {
  return entries.some(
    entry =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { kind?: string }).kind === "summary"
  );
}

/**
 * How many entries the newest summary stands in for.
 *
 * Reported to the agent so "read further back" has a number attached rather than being an invitation
 * to guess.
 */
export function summarisedCount(entries: readonly unknown[]): number {
  let covers = 0;
  for (const entry of entries) {
    const typed = entry as { kind?: string; covers?: number };
    if (typed?.kind === "summary" && typeof typed.covers === "number") covers = typed.covers;
  }
  return covers;
}

/**
 * Where an entry lives, as the agent writes it back: `#42` in a conversation that has only
 * ever had one context version, `e1#42` once `/new` has started another (INV-1188). The
 * epoch is part of the address because an index alone is only unique within one version.
 */
export function anchorOf(index: number, epoch?: number): string {
  return epoch === undefined ? `#${index}` : `e${epoch}#${index}`;
}

/** Reads `#42`, `42`, `e1#42` or `e1 #42`; undefined for anything else. */
export function parseAnchor(text: string): { epoch?: number; index: number } | undefined {
  const match = /^\s*(?:e(\d+)\s*)?#?\s*(\d+)\s*$/i.exec(text);
  if (match === null) return undefined;
  return { ...(match[1] !== undefined ? { epoch: Number(match[1]) } : {}), index: Number(match[2]) };
}

/** One entry as a line a model can read, with its anchor so it can ask for neighbours. */
export function renderEntry(entry: unknown, index: number, epoch?: number, limit: number = ENTRY_CHARS): string {
  const clamp = (text: string): string => clampTo(text, limit);
  const typed = entry as Entry;
  const at = typeof typed?.at === "string" ? typed.at.slice(0, 19).replace("T", " ") : "";
  const head = `${anchorOf(index, epoch)} ${at}`;

  if (typed === null || typeof typed !== "object") return `${head} (unreadable)`;

  if (!("kind" in typed)) {
    const who = typed.role === "user" ? "them" : "you";
    return `${head} ${who}: ${clamp(typed.text)}`;
  }

  if (typed.kind === "summary") return `${head} [summary of ${typed.covers} earlier entries]`;

  if (typed.kind === "blocks") {
    const parts = typed.blocks.map(block => {
      if (block.type === "text") return `you: ${clamp(block.text)}`;
      if (block.type === "tool_use") {
        // The call and its arguments, because "ran bash" without the command is exactly the kind of
        // unfalsifiable summary this exists to get behind.
        return `you called ${block.name}: ${clamp(JSON.stringify(block.input))}`;
      }
      return "";
    });
    return `${head} ${parts.filter(Boolean).join(" | ")}`;
  }

  const results = typed.blocks.map(block => {
    const content = block.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(part => (part as { type?: string }).type === "text")
              .map(part => (part as { text?: string }).text ?? "")
              .join(" ")
          : "";
    return `${block.is_error === true ? "failed" : "result"}: ${clamp(text)}`;
  });
  return `${head} ${results.join(" | ")}`;
}

function clampTo(text: string, limit: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** All the searchable text of an entry, so a match is found on what it actually contains. */
function textOf(entry: unknown): string {
  const typed = entry as Entry;
  if (typed === null || typeof typed !== "object") return "";
  if (!("kind" in typed)) return typed.text ?? "";
  if (typed.kind === "summary") return typed.text ?? "";
  return JSON.stringify(typed.blocks ?? "");
}

export interface HistoryQuery {
  /** Words to look for. Absent means "give me this range". */
  search?: string;
  /** Inclusive start index. Absent with a search means "everywhere". */
  from?: number;
  /** Exclusive end index. */
  to?: number;
  /**
   * Which context version `from`/`to` count in, once there is more than one. Absent means the
   * current one. A search without a range looks in every version.
   */
  epoch?: number;
  /** An anchor from an earlier answer (`#42`, `e1#42`): that entry in full, and its neighbours. */
  around?: string;
}

export interface HistoryResult {
  lines: string[];
  /** Total entries the transcript holds, so a caller knows what it is a slice of. */
  total: number;
  /** How many matched before the cap, so a truncated answer says it is truncated. */
  matched: number;
  /** No entry held every word; these hold the most of them (INV-1188). */
  partial?: boolean;
  /** An `around` reading: the entry in full with its neighbours. */
  around?: string;
  /** Why nothing could be read, said plainly. */
  problem?: string;
}

/** One transcript of one context version, as the registry reads it. */
export interface EpochEntries {
  epoch: number;
  entries: readonly unknown[];
}

/** How much of the entry an `around` points at is shown: a long draft in one read. */
export const AROUND_ENTRY_CHARS = 8_000;
/** Neighbours shown on each side of it. */
export const AROUND_NEIGHBOURS = 3;
/** The whole `around` answer stays under this, neighbours dropped farthest first. */
export const AROUND_TOTAL_CHARS = 16_000;

/**
 * Reads a slice of a transcript, or searches it.
 *
 * Search is lexical and case-insensitive, matching all of the words given — same reasoning as memory
 * recall: this is short, keyword-dense material and an embedding here would be infrastructure bought
 * for a problem nobody has measured. A search returns the *newest* matches, because the question is
 * almost always "what did I find out", not "what did I first try". When no entry holds every word,
 * the ones holding the most of them are returned instead, and said to be partial — "nothing" was the
 * wrong answer to a four-word search that missed on one word.
 */
export function readHistory(entries: readonly unknown[], query: HistoryQuery): HistoryResult {
  return readEpochHistory([{ epoch: 0, entries }], query);
}

/**
 * The same over every context version of a conversation. With one version the anchors are the plain
 * `#42` they always were; with more, every anchor names its version (`e1#42`), because an index is
 * only unique within one.
 */
export function readEpochHistory(parts: readonly EpochEntries[], query: HistoryQuery): HistoryResult {
  const multi = parts.length > 1;
  const latest = parts.length === 0 ? 0 : Math.max(...parts.map(part => part.epoch));
  const label = (epoch: number): number | undefined => (multi ? epoch : undefined);
  const items = parts.flatMap(part => part.entries.map((entry, index) => ({ epoch: part.epoch, index, entry })));
  const total = items.length;

  if (query.around !== undefined) return readAround(parts, query.around, multi ? latest : undefined, label, total);

  const ranged = query.from !== undefined || query.to !== undefined;
  const rangeEpoch = multi ? (query.epoch ?? latest) : parts[0]?.epoch ?? 0;
  const pool = items.filter(item => {
    if (!ranged && query.search !== undefined && query.epoch === undefined) return true;
    if (item.epoch !== rangeEpoch) return false;
    return item.index >= Math.max(0, query.from ?? 0) && item.index < (query.to ?? Number.POSITIVE_INFINITY);
  });

  const words = (query.search ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 1);
  const render = (item: { epoch: number; index: number; entry: unknown }) => renderEntry(item.entry, item.index, label(item.epoch));

  if (words.length === 0) {
    const chosen = pool.slice(0, MAX_ENTRIES);
    return { lines: chosen.map(render), total, matched: pool.length };
  }

  const scored = pool.map(item => {
    const haystack = textOf(item.entry).toLowerCase();
    return { item, hits: words.filter(word => haystack.includes(word)).length };
  });
  const every = scored.filter(score => score.hits === words.length).map(score => score.item);
  if (every.length > 0 || words.length === 1) {
    // Newest first for a search, since the useful answer is usually the most recent one.
    const chosen = every.slice(-MAX_ENTRIES).reverse();
    return { lines: chosen.map(render), total, matched: every.length };
  }
  const some = scored
    .filter(score => score.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.item.epoch - a.item.epoch || b.item.index - a.item.index);
  return {
    lines: some.slice(0, MAX_ENTRIES).map(score => `${render(score.item)} [${score.hits}/${words.length} words]`),
    total,
    matched: some.length,
    ...(some.length > 0 ? { partial: true } : {}),
  };
}

function readAround(
  parts: readonly EpochEntries[],
  anchorText: string,
  defaultEpoch: number | undefined,
  label: (epoch: number) => number | undefined,
  total: number
): HistoryResult {
  const anchor = parseAnchor(anchorText);
  if (anchor === undefined) {
    return { lines: [], total, matched: 0, problem: `"${anchorText}" is not an entry anchor; use one from an earlier answer, such as #42 or e1#42.` };
  }
  const epoch = anchor.epoch ?? defaultEpoch ?? parts[0]?.epoch ?? 0;
  const part = parts.find(candidate => candidate.epoch === epoch);
  if (part === undefined || anchor.index >= part.entries.length) {
    const sizes = parts.map(candidate => `${anchorOf(0, label(candidate.epoch))}–${anchorOf(Math.max(0, candidate.entries.length - 1), label(candidate.epoch))}`).join(", ");
    return { lines: [], total, matched: 0, problem: `There is no entry ${anchorOf(anchor.index, label(epoch) ?? anchor.epoch)}. The history holds ${sizes || "nothing"}.` };
  }
  const center = renderEntry(part.entries[anchor.index], anchor.index, label(epoch), AROUND_ENTRY_CHARS);
  const before: string[] = [];
  const after: string[] = [];
  for (let step = 1; step <= AROUND_NEIGHBOURS; step += 1) {
    const prev = anchor.index - step;
    const next = anchor.index + step;
    if (prev >= 0) before.unshift(renderEntry(part.entries[prev], prev, label(epoch)));
    if (next < part.entries.length) after.push(renderEntry(part.entries[next], next, label(epoch)));
  }
  // Farthest neighbours go first when the answer would run long; the entry asked for never does.
  const size = () => [...before, center, ...after].reduce((sum, line) => sum + line.length + 1, 0);
  while (size() > AROUND_TOTAL_CHARS && (before.length > 0 || after.length > 0)) {
    if (before.length >= after.length) before.shift();
    else after.pop();
  }
  return {
    lines: [...before, center, ...after],
    total,
    matched: 1,
    around: anchorOf(anchor.index, label(epoch)),
  };
}

/** The answer as the agent reads it, including when there is nothing to report. */
export function describeHistory(result: HistoryResult, query: HistoryQuery): string {
  if (result.problem !== undefined) return result.problem;
  if (result.lines.length === 0) {
    return query.search
      ? `Nothing in the ${result.total} recorded entries matches "${query.search}". Try fewer or ` +
          `different words — this is a plain word match, not a search that guesses at meaning.`
      : `There is nothing in that range. The transcript holds ${result.total} entries.`;
  }
  if (result.around !== undefined) {
    return [
      `Around ${result.around} in your recorded history (oldest first; ${result.around} in full, its neighbours cut):`,
      "",
      ...result.lines,
    ].join("\n");
  }
  const heading = result.partial === true
    ? `No entry holds every word of "${query.search}". These hold the most of them, best first:`
    : `From your recorded history (${result.total} entries in total):`;
  const truncated =
    result.matched > result.lines.length
      ? `\n\n${result.matched} entries matched; the ${result.lines.length} ${result.partial === true ? "best" : "most recent"} are above. ` +
        `Narrow the search or ask for a range if you need the others.`
      : "";
  return [heading, "", ...result.lines, truncated].join("\n");
}

/**
 * The prompt block telling an agent its earlier history is still readable.
 *
 * Rendered only when something has actually been summarised. Without that check it would advertise a
 * capability whose answer is "here is what you can already see", which trains an agent to ignore it
 * by the time it is needed.
 */
export function renderHistoryBlock(entries: readonly unknown[]): string {
  if (!hasSummary(entries)) return "";
  const covered = summarisedCount(entries);
  return [
    "## Your earlier history is still there",
    "",
    `The start of this conversation was summarised to fit — ${covered} entries replaced by the`,
    "summary you can see above. **The originals were not deleted.** Use `ReadHistory` to search or",
    "read them: what you actually ran, what actually came back, what you were told and when.",
    "",
    "Worth doing before you conclude something never happened, or repeat work you may already have",
    "done. A summary is a paraphrase, and the thing it left out is exactly the thing you are missing.",
    "",
    "One more hop is available when you need it. A command that printed more than a tool result can",
    "hold says so where it was cut, and names a file holding all of it — `full output kept: <path>`.",
    "That file is still on the box, so a truncated build log or a huge listing is one `read_file`",
    "away rather than gone.",
  ].join("\n");
}
