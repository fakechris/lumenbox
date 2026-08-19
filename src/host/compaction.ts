/**
 * Keeping a long-lived agent's history sendable.
 *
 * A conversation grows with every turn and nothing trimmed it. Measured on this system: one agent
 * reached 158KB — roughly 40,000 tokens — after a day, and a single request was already 21,812.
 * The end of that road is a turn that fails on a request which cannot be made smaller, which is
 * the worst possible time to discover the problem: the agent is mid-task and there is nothing the
 * user can do.
 *
 * Two decisions define this.
 *
 * **Compaction changes what is sent, not what is stored.** The transcript keeps every entry,
 * including the tool blocks that make an agent's claims checkable — that record is the reason to
 * trust any of this, and summarising over it would quietly destroy the thing it exists for. A
 * summary is an additional entry; assembly starts from the newest one and sends the tail verbatim.
 *
 * **The cut has to land between a tool call and nothing.** A `blocks` entry and its `results` are
 * one exchange to the API, and splitting them produces a request it rejects. The cut point is
 * chosen after a results entry, never inside a pair.
 *
 * A failed summarisation does not fail the turn. It falls back to dropping the oldest entries and
 * saying so in the history, which is worse than a summary and much better than an agent that
 * cannot answer.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** Roughly four characters per token. Wrong in the third digit, right about the order. */
export const CHARS_PER_TOKEN = 4;

export interface CompactionPolicy {
  /** Compact once the assembled history is estimated above this many tokens. */
  triggerTokens: number;
  /** Keep at least this much of the tail verbatim, so recent work is never a summary. */
  keepTailTokens: number;
}

export const DEFAULT_POLICY: CompactionPolicy = {
  triggerTokens: Number(process.env.AGENTBOX_COMPACT_AT_TOKENS ?? 60_000),
  keepTailTokens: Number(process.env.AGENTBOX_COMPACT_KEEP_TOKENS ?? 20_000),
};

/** What the transcript holds. Mirrors turn.ts, plus the summary this file adds. */
/** The entry compaction adds. Named so callers can hold one without widening to the union. */
export interface SummaryEntry {
  role: "user";
  kind: "summary";
  /** How many entries from the start of the active window this stands in for. */
  covers: number;
  text: string;
  at: string;
}

export type HistoryEntry =
  | { role: "user" | "assistant"; text: string; at: string }
  | { role: "assistant"; kind: "blocks"; blocks: Anthropic.ContentBlockParam[]; at: string }
  | { role: "user"; kind: "results"; blocks: Anthropic.ToolResultBlockParam[]; at: string }
  | SummaryEntry;

export function estimateTokens(entries: readonly HistoryEntry[]): number {
  let chars = 0;
  for (const entry of entries) {
    chars += "kind" in entry && entry.kind !== "summary"
      ? JSON.stringify(entry.blocks).length
      : (entry as { text: string }).text.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Everything from the newest summary onwards.
 *
 * The summary is the first thing sent, standing in for what it covers. Entries before it are still
 * on disk and still readable by a person; they are simply not in the request.
 */
export function activeWindow(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if ("kind" in entry && entry.kind === "summary") return entries.slice(at);
  }
  return entries;
}

export interface CutPoint {
  /** Index into the active window: entries before this are summarised. */
  index: number;
  /** Why, for the log — a decision this consequential should not be silent. */
  reason: string;
}

/**
 * Where to cut, or undefined when there is nothing worth cutting.
 *
 * Walks back from the end until the tail is big enough to keep, then keeps walking until it is
 * standing after a `results` entry — the only place a cut leaves both halves valid.
 */
export function chooseCutPoint(
  entries: readonly HistoryEntry[],
  policy: CompactionPolicy = DEFAULT_POLICY
): CutPoint | undefined {
  const total = estimateTokens(entries);
  if (total <= policy.triggerTokens) return undefined;

  // Walk back accumulating the tail.
  let tail = 0;
  let index = entries.length;
  while (index > 0 && tail < policy.keepTailTokens) {
    index -= 1;
    tail += estimateTokens([entries[index]!]);
  }

  // Then move the cut earlier until the entry before it completes an exchange. A cut directly
  // before a `results` entry would send a result whose call was summarised away.
  while (index > 0) {
    const previous = entries[index - 1]!;
    const isPairEnd = !("kind" in previous) || previous.kind === "results" || previous.kind === "summary";
    if (isPairEnd) break;
    index -= 1;
  }

  // Nothing to gain: everything is either the tail or a single unsplittable exchange.
  if (index <= 0) return undefined;

  return {
    index,
    reason:
      `history is about ${total} tokens, over the ${policy.triggerTokens} trigger; ` +
      `summarising the first ${index} entr${index === 1 ? "y" : "ies"} and keeping ` +
      `about ${tail} tokens of tail`,
  };
}

/**
 * The prompt that produces a summary.
 *
 * Asks for what a later turn actually needs — decisions, state, open threads, paths — rather than a
 * narrative. A summary that reads well and omits the file it wrote is worse than no summary,
 * because the agent will believe it.
 */
export function buildSummaryPrompt(entries: readonly HistoryEntry[]): string {
  const rendered = entries
    .map(entry => {
      if (!("kind" in entry)) return `${entry.role}: ${entry.text}`;
      if (entry.kind === "summary") return `summary of earlier work: ${entry.text}`;
      if (entry.kind === "blocks") {
        return entry.blocks
          .map(block =>
            block.type === "text"
              ? `assistant: ${block.text}`
              : block.type === "tool_use"
                ? `assistant used ${block.name}: ${JSON.stringify(block.input).slice(0, 400)}`
                : ""
          )
          .filter(Boolean)
          .join("\n");
      }
      return entry.blocks
        .map(block => {
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
          return `result: ${text.slice(0, 400)}`;
        })
        .join("\n");
    })
    .filter(line => line.trim() !== "")
    .join("\n");

  return (
    "Summarise the earlier part of your own working history below, for your future self.\n\n" +
    "Write what a later turn needs to continue without re-reading any of it:\n" +
    "- what was asked, and what has been decided\n" +
    "- what you actually did, including files you created or changed, with their paths\n" +
    "- the current state of the work, and anything left open or blocked\n" +
    "- facts you established that would be expensive to find again\n\n" +
    "Be specific and dense. Omit narration, apologies and anything you would not need again. " +
    "Do not invent progress: if something was attempted and failed, say so.\n\n" +
    "--- history ---\n" +
    rendered
  );
}

/** How the summary enters the transcript. */
export function summaryEntry(text: string, covers: number, at = new Date()): SummaryEntry {
  return {
    role: "user",
    kind: "summary",
    covers,
    text: `[Summary of the first ${covers} entries of this conversation]\n\n${text}`,
    at: at.toISOString(),
  };
}

/**
 * What goes in the transcript when summarisation itself failed.
 *
 * Deliberately visible to the model, and deliberately not silent: the alternative was sending a
 * request that cannot fit, and the alternative to that was dropping history with no trace.
 */
export function droppedEntry(covers: number, reason: string, at = new Date()): SummaryEntry {
  return {
    role: "user",
    kind: "summary",
    covers,
    text:
      `[The first ${covers} entries of this conversation were dropped to fit the context ` +
      `window, and could not be summarised: ${reason}. Earlier work is still in the ` +
      `transcript on disk, but not in this request — treat anything you cannot see as unknown ` +
      `rather than as not done.]`,
    at: at.toISOString(),
  };
}
