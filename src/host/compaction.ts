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

/**
 * Characters per token, and the per-message overhead the API adds.
 *
 * 2.5 rather than the 4 this started with, and the change is a correction rather than a refinement.
 * 4 is roughly right for English prose and badly optimistic for what an agent's history actually
 * contains: JSON tool arguments, shell output, file paths, CJK text. Estimating *fewer* tokens than
 * there are means failing to compact when compaction was needed — an error in the direction that
 * ends the conversation. 2.5 errs toward compacting slightly early, which costs one summary.
 *
 * The overheads matter for a history made of many small entries: a hundred tool calls carry real
 * per-message framing that a pure character count does not see.
 */
export const CHARS_PER_TOKEN = 2.5;
export const MESSAGE_OVERHEAD_CHARS = 25;
export const TOOL_CALL_OVERHEAD_CHARS = 50;

/**
 * What one image costs, in tokens.
 *
 * Images are not charged by their byte count — a 6.5KB WebP screenshot of a 1280x800 display bills
 * as roughly 1,100-1,600 tokens depending on the provider's tiling. Counting its base64 length
 * instead (as a character estimate does) is wrong in both directions at once: a small screenshot
 * looks free and a large one looks ruinous. A flat, slightly pessimistic constant is closer to the
 * truth than either.
 */
export const TOKENS_PER_IMAGE = Number(process.env.AGENTBOX_TOKENS_PER_IMAGE ?? 1_600);

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

/**
 * The real context window, learned from the model rather than guessed.
 *
 * A fixed 60,000-token trigger is wrong in both directions: against a 1,000,000-token model it
 * throws away 94% of the usable context and summarises work that would have fitted, and against a
 * 200,000-token one it may still be too generous once the system prompt and tools are counted.
 *
 * Providers report the window in their usage. Cached per model for the life of the process, because
 * it does not change and the first response of a run is enough to learn it. Nothing here fails when
 * a provider does not report it — the configured constants stand in.
 */
const windowByModel = new Map<string, number>();

export function noteContextWindow(model: string, maxTokens: number | undefined): void {
  if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens <= 0) return;
  windowByModel.set(model, maxTokens);
}

export function knownContextWindow(model: string): number | undefined {
  return windowByModel.get(model);
}

/**
 * Fraction of the window that may be occupied before compaction starts, and the share kept as tail.
 *
 * Expressed as "how much must be left free" rather than "how much may be used", which is the way it
 * has to be reasoned about: what matters is whether the *next* round still fits, and a round can add
 * a screenshot and a page of shell output.
 */
const FREE_FRACTION = Number(process.env.AGENTBOX_COMPACT_FREE_FRACTION ?? 0.35);
const TAIL_FRACTION = Number(process.env.AGENTBOX_COMPACT_TAIL_FRACTION ?? 0.3);

/**
 * The policy to use for a model, derived from its real window when that is known.
 *
 * An explicit `AGENTBOX_COMPACT_AT_TOKENS` always wins: someone who set a number meant it.
 */
export function policyForModel(model: string): CompactionPolicy {
  if (process.env.AGENTBOX_COMPACT_AT_TOKENS !== undefined) return DEFAULT_POLICY;
  const window = knownContextWindow(model);
  if (window === undefined) return DEFAULT_POLICY;
  const trigger = Math.floor(window * (1 - FREE_FRACTION));
  return {
    triggerTokens: trigger,
    keepTailTokens: Math.max(1_000, Math.floor(trigger * TAIL_FRACTION)),
  };
}

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
  let images = 0;
  for (const entry of entries) {
    chars += MESSAGE_OVERHEAD_CHARS;
    if (!("kind" in entry) || entry.kind === "summary") {
      chars += (entry as { text: string }).text.length;
      continue;
    }
    for (const block of entry.blocks) {
      const counted = countBlock(block);
      chars += counted.chars;
      images += counted.images;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

/**
 * One content block's cost, with images counted as images.
 *
 * Recursive into tool results because that is where screenshots live: a `tool_result` whose content
 * is an array of parts, one of which is an image. Missing that nesting is how a turn of computer use
 * looks cheap right up to the request that fails.
 */
function countBlock(block: unknown): { chars: number; images: number } {
  if (block === null || typeof block !== "object") return { chars: 0, images: 0 };
  const typed = block as { type?: string; content?: unknown; text?: string; input?: unknown };

  if (typed.type === "image") return { chars: 0, images: 1 };
  if (typed.type === "text") return { chars: (typed.text ?? "").length, images: 0 };
  if (typed.type === "tool_use") {
    return {
      chars: JSON.stringify(typed.input ?? "").length + TOOL_CALL_OVERHEAD_CHARS,
      images: 0,
    };
  }
  if (typed.type === "tool_result") {
    const content = typed.content;
    if (typeof content === "string") {
      return { chars: content.length + TOOL_CALL_OVERHEAD_CHARS, images: 0 };
    }
    if (Array.isArray(content)) {
      return content.reduce<{ chars: number; images: number }>(
        (sum, part) => {
          const counted = countBlock(part);
          return { chars: sum.chars + counted.chars, images: sum.images + counted.images };
        },
        { chars: TOOL_CALL_OVERHEAD_CHARS, images: 0 }
      );
    }
    return { chars: TOOL_CALL_OVERHEAD_CHARS, images: 0 };
  }
  // Thinking blocks and anything a provider adds later: measured, not ignored.
  return { chars: JSON.stringify(block).length, images: 0 };
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

// ── in-turn: the part compaction between turns cannot reach ────────────────────────────

/**
 * Dropping old screenshots from a turn that is still running.
 *
 * Compaction above operates on the *history*, once, before a turn starts. It cannot help a turn that
 * grows past the window on its own — and a computer-use turn does exactly that, because every round
 * adds a screenshot and up to 400 rounds are allowed. Measured on this system: one screenshot of a
 * 1280x800 display is roughly 1,600 tokens, so fifty rounds carry about 80,000 tokens of images that
 * are all still being sent on round fifty-one.
 *
 * The observation that makes this cheap: **images are almost all of the weight, and only the newest
 * one is worth anything.** An agent deciding what to click needs to see the screen as it is now; the
 * screen as it was thirty actions ago is a claim about the past that the text already records. So
 * this drops old images and keeps the latest, which is a large reduction that needs no summarising
 * model, no extra latency, and no cut through the message list — the call/result pairing is
 * untouched because only the *contents* of results change.
 *
 * What replaces a dropped image is a note, not nothing. An agent that silently stops seeing earlier
 * screenshots would have no way to know its view of the past had changed.
 */

export const DROPPED_IMAGE_NOTE = "[screenshot removed to fit the context window]";

export interface ImagePruneResult {
  messages: Anthropic.MessageParam[];
  /** How many images were replaced by a note. Zero means nothing was touched. */
  dropped: number;
  /** Rough tokens reclaimed, for the log. */
  reclaimedTokens: number;
}

/**
 * Replaces every image except the most recent `keepImages` with a note.
 *
 * Operates on the in-flight message array, newest-first, so "keep the latest" is the natural
 * traversal rather than a second pass. Returns the same array when there is nothing to do, so the
 * caller can treat "no change" as free.
 */
export function pruneOldImages(
  messages: readonly Anthropic.MessageParam[],
  keepImages = 1
): ImagePruneResult {
  let seen = 0;
  let dropped = 0;

  // Newest first: the images that survive are the last ones in the conversation.
  const rewritten = messages
    .slice()
    .reverse()
    .map((message): Anthropic.MessageParam => {
      if (!Array.isArray(message.content)) return message;
      let changed = false;
      const blocks = message.content.map(block => {
        const pruned = pruneBlock(block, () => {
          seen += 1;
          if (seen <= keepImages) return false;
          dropped += 1;
          return true;
        });
        if (pruned !== block) changed = true;
        return pruned;
      });
      return changed
        ? { ...message, content: blocks as Anthropic.ContentBlockParam[] }
        : message;
    })
    .reverse();

  return {
    messages: dropped === 0 ? (messages as Anthropic.MessageParam[]) : rewritten,
    dropped,
    reclaimedTokens: dropped * TOKENS_PER_IMAGE,
  };
}

/**
 * One block, with images replaced when `shouldDrop` says so.
 *
 * `shouldDrop` is called once per image in traversal order and decides — it counts as well as
 * decides, which keeps "keep the newest N" in one place instead of spread across the recursion.
 */
function pruneBlock(block: unknown, shouldDrop: () => boolean): unknown {
  if (block === null || typeof block !== "object") return block;
  const typed = block as { type?: string; content?: unknown };

  if (typed.type === "image") {
    return shouldDrop() ? { type: "text", text: DROPPED_IMAGE_NOTE } : block;
  }

  // Screenshots from the computer tool arrive nested inside a tool_result, which is the case that
  // matters and the easy one to miss.
  if (typed.type === "tool_result" && Array.isArray(typed.content)) {
    let changed = false;
    const content = typed.content.map(part => {
      const pruned = pruneBlock(part, shouldDrop);
      if (pruned !== part) changed = true;
      return pruned;
    });
    return changed ? { ...typed, content } : block;
  }

  return block;
}

/**
 * Whether an in-flight request needs its old images dropped, and the budget to aim at.
 *
 * Separate from the pruning so the decision is testable without building message arrays, and so the
 * threshold can be stated in terms of the model's real window when one is known.
 */
export function shouldPruneImages(
  estimatedTokens: number,
  model: string,
  policy: CompactionPolicy = policyForModel(model)
): boolean {
  return estimatedTokens > policy.triggerTokens;
}

/**
 * Tokens in an in-flight message array.
 *
 * The same accounting as `estimateTokens`, over API messages rather than transcript entries. Both
 * exist because the two shapes are genuinely different — a transcript entry is one message, but an
 * in-flight assistant message carries the whole content array including thinking blocks.
 */
export function estimateMessageTokens(messages: readonly Anthropic.MessageParam[]): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    chars += MESSAGE_OVERHEAD_CHARS;
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      const counted = countBlock(block);
      chars += counted.chars;
      images += counted.images;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}
