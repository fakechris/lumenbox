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
const ENTRY_CHARS = 600;

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

/** One entry as a line a model can read, with its index so it can ask for neighbours. */
export function renderEntry(entry: unknown, index: number): string {
  const typed = entry as Entry;
  const at = typeof typed?.at === "string" ? typed.at.slice(0, 19).replace("T", " ") : "";
  const head = `#${index} ${at}`;

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

function clamp(text: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > ENTRY_CHARS ? `${clean.slice(0, ENTRY_CHARS)}…` : clean;
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
}

export interface HistoryResult {
  lines: string[];
  /** Total entries the transcript holds, so a caller knows what it is a slice of. */
  total: number;
  /** How many matched before the cap, so a truncated answer says it is truncated. */
  matched: number;
}

/**
 * Reads a slice of a transcript, or searches it.
 *
 * Search is lexical and case-insensitive, matching all of the words given — same reasoning as memory
 * recall: this is short, keyword-dense material and an embedding here would be infrastructure bought
 * for a problem nobody has measured. A search returns the *newest* matches, because the question is
 * almost always "what did I find out", not "what did I first try".
 */
export function readHistory(entries: readonly unknown[], query: HistoryQuery): HistoryResult {
  const total = entries.length;
  const from = Math.max(0, query.from ?? 0);
  const to = Math.min(total, query.to ?? total);

  const indexed = entries
    .map((entry, index) => ({ entry, index }))
    .filter(item => item.index >= from && item.index < to);

  const words = (query.search ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 1);

  const matching =
    words.length === 0
      ? indexed
      : indexed.filter(item => {
          const haystack = textOf(item.entry).toLowerCase();
          return words.every(word => haystack.includes(word));
        });

  // Newest first for a search, since the useful answer is usually the most recent one; oldest first
  // for a plain range, because a range is being read in order.
  const chosen =
    words.length === 0
      ? matching.slice(0, MAX_ENTRIES)
      : matching.slice(-MAX_ENTRIES).reverse();

  return {
    lines: chosen.map(item => renderEntry(item.entry, item.index)),
    total,
    matched: matching.length,
  };
}

/** The answer as the agent reads it, including when there is nothing to report. */
export function describeHistory(result: HistoryResult, query: HistoryQuery): string {
  if (result.lines.length === 0) {
    return query.search
      ? `Nothing in the ${result.total} recorded entries matches "${query.search}". Try fewer or ` +
          `different words — this is a plain word match, not a search that guesses at meaning.`
      : `There is nothing in that range. The transcript holds ${result.total} entries.`;
  }
  const truncated =
    result.matched > result.lines.length
      ? `\n\n${result.matched} entries matched; the ${result.lines.length} most recent are above. ` +
        `Narrow the search or ask for a range if you need the others.`
      : "";
  return [
    `From your recorded history (${result.total} entries in total):`,
    "",
    ...result.lines,
    truncated,
  ].join("\n");
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
