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

import { envNumber } from "../config.ts";
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
export const TOKENS_PER_IMAGE = envNumber("AGENTBOX_TOKENS_PER_IMAGE", 1_600);

export interface CompactionPolicy {
  /** Compact once the assembled history is estimated above this many tokens. */
  triggerTokens: number;
  /** Keep at least this much of the tail verbatim, so recent work is never a summary. */
  keepTailTokens: number;
  /**
   * Compact once the window holds this many entries, whatever they weigh.
   *
   * Because the request assembler also has a hard entry cap, and a cap that is reached without
   * compaction having run drops the oldest entries with no summary and no notice — a long
   * conversation of short messages could silently lose the instruction that started it. Making the
   * count a compaction trigger means the entry cap is only ever a backstop.
   */
  maxEntries: number;
}

export const DEFAULT_POLICY: CompactionPolicy = {
  triggerTokens: envNumber("AGENTBOX_COMPACT_AT_TOKENS", 60_000),
  keepTailTokens: envNumber("AGENTBOX_COMPACT_KEEP_TOKENS", 20_000),
  // 320, up from 50 — the 2026-08-29 chronic-compaction root cause (docs/23). Entries
  // are not the scarce resource; tokens are, and the token trigger governs. A
  // computer-use turn writes two entries per round, so 50 fired after nearly every
  // CUA turn at five-thousand-token histories — three compactions in one afternoon,
  // all logged as "over the 50 entry trigger", one of which cost MiniMax the
  // `computer` tool schema mid-task. The count stays only as a backstop against the
  // assembler's own entry cap, and sits under it for the same reason it always did.
  maxEntries: envNumber("AGENTBOX_COMPACT_MAX_ENTRIES", 320),
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
const FREE_FRACTION = envNumber("AGENTBOX_COMPACT_FREE_FRACTION", 0.35);
const TAIL_FRACTION = envNumber("AGENTBOX_COMPACT_TAIL_FRACTION", 0.3);

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
    maxEntries: DEFAULT_POLICY.maxEntries,
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
  /**
   * Entries from the summarised range kept verbatim, rendered between the summary and
   * the tail (docs/24 v3 P0 #2). Two kinds ride here: the newest plain user message
   * when the tail has none — what was *asked*, in the asker's words — and the newest
   * successful call/result pair per tool the tail no longer demonstrates. The second
   * is schema insurance bought at MiniMax prices: a weak model follows a tool's
   * parameter shape by imitating its own in-context examples, and the docs/23
   * incident was ten minutes of guessing after a compaction took every example away.
   */
  pinned?: HistoryEntry[];
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
      // A summary's pinned entries are sent too, so they weigh too.
      const pinned = (entry as SummaryEntry).pinned;
      if (pinned !== undefined && pinned.length > 0) {
        chars += estimateTokens(pinned) * CHARS_PER_TOKEN;
      }
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
 * The summary, then everything it did not cover.
 *
 * The summary stands in for the entries it covers; the tail that `chooseCutPoint` deliberately kept
 * is sent verbatim after it. Entries the summary replaced are still on disk and still readable by a
 * person; they are simply not in the request.
 *
 * The subtlety, and the reason this is not a slice: **the transcript is append-only, so a summary is
 * written at the end, not at the position it summarises.** Reading "from the newest summary onwards"
 * therefore returned the summary and nothing else — every entry the cut point had deliberately
 * preserved sat *before* it in the file and was dropped from the request. A conversation compacted
 * once lost its whole recent tail, which is the opposite of what compaction is for, and the failure
 * was invisible because the summary itself always arrived.
 *
 * `covers` counts entries in the window that was active when the summary was written, so the window
 * is rebuilt by recursing into that earlier window and dropping the covered prefix. The recursion is
 * as deep as the number of compactions, which is small.
 */
export function activeWindow(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
  // Iterative, not recursive. The relationship is linear — each summary's window is a function of
  // the window before it — so it unrolls into a loop, and a loop does not exhaust the call stack.
  // The recursion did: a transcript with enough summaries (thousands) threw a stack overflow and
  // then no turn could be assembled at all. Unreachable in normal use, but a clean fix.
  //
  // Walk back collecting the summary chain, then rebuild from the innermost summary outward. Each
  // step is result = [summary, ...previous.slice(covers), ...suffixAfterSummary].
  const chain: { summary: HistoryEntry; covers: number; suffix: readonly HistoryEntry[] }[] = [];
  let cur: readonly HistoryEntry[] = entries;
  for (;;) {
    let at = -1;
    for (let index = cur.length - 1; index >= 0; index--) {
      const entry = cur[index]!;
      if ("kind" in entry && entry.kind === "summary") {
        at = index;
        break;
      }
    }
    if (at === -1) break;
    const summary = cur[at] as HistoryEntry & { covers: number };
    chain.push({
      summary,
      covers: Number.isFinite(summary.covers) ? Math.max(0, summary.covers) : 0,
      suffix: cur.slice(at + 1),
    });
    cur = cur.slice(0, at);
  }

  let result: readonly HistoryEntry[] = cur;
  for (let index = chain.length - 1; index >= 0; index--) {
    const step = chain[index]!;
    result = [step.summary, ...result.slice(step.covers), ...step.suffix];
  }
  return result;
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
  policy: CompactionPolicy = DEFAULT_POLICY,
  options: { force?: boolean } = {}
): CutPoint | undefined {
  const total = estimateTokens(entries);
  const tooMany = entries.length > policy.maxEntries;
  // `force` asks the different question the background pass needs: not "should we cut" but "where
  // would we cut, if we had to". Without it the speculative path could never fire, because it runs
  // precisely when the total is still *below* the trigger — a bug this function's own gate caused
  // in the first version of the background pass.
  if (!options.force && !tooMany && total <= policy.triggerTokens) return undefined;

  // Walk back accumulating the tail, and stop early once the tail is as many entries as we are
  // willing to send. Without that second condition a window of many cheap entries never reaches
  // `keepTailTokens`, so the whole thing counts as tail, no cut is named, and the entry cap
  // downstream drops the oldest entries in silence — the exact failure the count trigger exists to
  // prevent.
  const tailEntryLimit = Math.max(1, Math.floor(policy.maxEntries * 0.6));
  let tail = 0;
  let index = entries.length;
  while (index > 0 && tail < policy.keepTailTokens && entries.length - index < tailEntryLimit) {
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
      (tooMany && total <= policy.triggerTokens
        ? `history is ${entries.length} entries, over the ${policy.maxEntries} entry trigger`
        : `history is about ${total} tokens, over the ${policy.triggerTokens} trigger`) +
      `; summarising the first ${index} entr${index === 1 ? "y" : "ies"} and keeping ` +
      `about ${tail} tokens of tail`,
  };
}

/** At most this many tool pairs ride as exemplars; more is a history, not insurance. */
export const MAX_PINNED_TOOLS = 3;
/** An exemplar's result is trimmed to this: the value is the *call's* shape, not the output. */
export const PINNED_RESULT_CHARS = 200;
/** A pinned user message is clamped: the ask matters, a pasted specification does not. */
export const PINNED_USER_CHARS = 2_000;

/**
 * What to keep verbatim from a summarised range (docs/24 v3 P0 #2).
 *
 * Deliberately *not* a change to the cut point: extending the cut to protect these
 * would blow the token budget in exactly the computer-use case that needs them most —
 * the docs/23 recreation hazard the review warned about. Copies ride on the summary
 * entry instead, so the cut stays where the budget put it and the insurance costs a
 * few hundred tokens, bounded here.
 *
 * Selection: the newest plain user message when the tail carries none (what was asked,
 * verbatim), then the newest *successful* call/result pair for each tool the tail no
 * longer demonstrates, newest tools first, capped. Results are trimmed hard — the
 * schema a weak model imitates lives in the call, not in what came back.
 */
export function choosePinnedEntries(
  older: readonly HistoryEntry[],
  tail: readonly HistoryEntry[]
): HistoryEntry[] {
  const pinned: HistoryEntry[] = [];

  const isPlainUser = (entry: HistoryEntry): boolean =>
    !("kind" in entry) && entry.role === "user";
  if (!tail.some(isPlainUser)) {
    for (let index = older.length - 1; index >= 0; index--) {
      const entry = older[index]!;
      if (isPlainUser(entry)) {
        const text = (entry as { text: string; at: string }).text;
        pinned.push({
          role: "user",
          text: text.length > PINNED_USER_CHARS ? `${text.slice(0, PINNED_USER_CHARS)}…` : text,
          at: (entry as { at: string }).at,
        });
        break;
      }
    }
  }

  const toolsInTail = new Set<string>();
  for (const entry of tail) {
    if ("kind" in entry && entry.kind === "blocks") {
      for (const block of entry.blocks) {
        if ((block as { type?: string }).type === "tool_use") {
          toolsInTail.add((block as { name: string }).name);
        }
      }
    }
  }

  // Newest-first scan for call entries whose every call succeeded and whose results
  // immediately follow — the shape a model can safely imitate.
  const chosen = new Set<string>();
  const pairs: HistoryEntry[][] = [];
  for (let index = older.length - 2; index >= 0 && chosen.size < MAX_PINNED_TOOLS; index--) {
    const entry = older[index]!;
    const next = older[index + 1]!;
    if (!("kind" in entry) || entry.kind !== "blocks") continue;
    if (!("kind" in next) || next.kind !== "results") continue;
    const calls = entry.blocks.filter(
      (block): block is Anthropic.ToolUseBlockParam => (block as { type?: string }).type === "tool_use"
    );
    if (calls.length === 0) continue;
    const names = calls.map(call => call.name);
    if (names.every(name => toolsInTail.has(name) || chosen.has(name))) continue;
    const anyError = next.blocks.some(block => (block as { is_error?: boolean }).is_error === true);
    if (anyError) continue;

    const trimmedResults: Anthropic.ToolResultBlockParam[] = next.blocks.map(block => ({
      ...(block as Anthropic.ToolResultBlockParam),
      content: [
        {
          type: "text" as const,
          text: `[exemplar — result trimmed] ${resultText(block).slice(0, PINNED_RESULT_CHARS)}`,
        },
      ],
    }));
    pairs.push([
      { role: "assistant", kind: "blocks", blocks: entry.blocks, at: (entry as { at: string }).at },
      { role: "user", kind: "results", blocks: trimmedResults, at: (next as { at: string }).at },
    ]);
    for (const name of names) chosen.add(name);
  }
  // The scan ran newest-first; the render should read oldest-first, like history does.
  for (let index = pairs.length - 1; index >= 0; index--) pinned.push(...pairs[index]!);

  return pinned;
}

function resultText(block: unknown): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => (part as { type?: string }).type === "text")
      .map(part => (part as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

/**
 * How long a summary may be.
 *
 * A cap because the failure of an unbounded one is not that it costs tokens — it is that it becomes
 * a narrative. Given room, a model retells; given a limit, it chooses.
 */
export const SUMMARY_WORD_CAP = envNumber("AGENTBOX_SUMMARY_WORDS", 400);

/**
 * The prompt that produces a summary.
 *
 * Asks for what a later turn actually needs — decisions, state, open threads, paths — rather than a
 * narrative. A summary that reads well and omits the file it wrote is worse than no summary,
 * because the agent will believe it.
 *
 * **Four named sections rather than four bullet points.** The difference is not style. A list of
 * things to mention gets partially satisfied and nobody notices which part was dropped; a heading
 * that must be present makes an omission visible, and `Artifacts: none` is a claim that can be
 * wrong, where a missing paragraph about files is just absence. Paths are the thing most often lost
 * and most expensive to find again, which is why they get a section of their own.
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
    "This may cover several unrelated requests. A chat that has been running for days is a " +
    "room, not a task: the person asks about one thing, it finishes, and days later they " +
    "ask about something else entirely. Keep them separate and say which are finished — a " +
    "summary that merges them into one objective makes your future self answer a new " +
    "question with an old one's goal.\n\n" +
    "Use exactly these four headings, in this order, and put nothing outside them:\n\n" +
    "**Threads** — each distinct piece of work, one per line: what was asked, what was " +
    "concluded, and whether it is finished or still open. Mark finished ones finished.\n" +
    "**Done** — what you actually did, and what came of it, written as dated past tense so " +
    "finished work cannot be read as pending. Attempts that failed belong here too; a " +
    "summary that lists only successes reads as a plan rather than a history.\n" +
    "**State** — where the work stands right now, and anything open, blocked or waiting.\n" +
    "**Artifacts** — every file you created or changed, by full path, one per line, with a few " +
    "words on what each holds. If there are none, write \"none\" — an empty section is a fact, and " +
    "leaving it out looks like forgetting.\n\n" +
    `Under ${SUMMARY_WORD_CAP} words. Be specific and dense: omit narration, apologies and ` +
    "anything you would not need again. Do not invent progress.\n\n" +
    "Collapse a resolved exchange to its conclusion — the back and forth that got there is " +
    "not needed again, and carrying it forward is what makes each summary of a summary " +
    "bigger than the last. And keep the provenance: something a person or a page asserted " +
    "stays attributed to them. A claim that loses its source becomes your own knowledge on " +
    "the next pass, which is how an unchecked figure ends up being repeated as fact.\n\n" +
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
    // Named as history, not as standing instructions. Labelled only "[Summary of the
    // first N entries]", it read as the current objective: a summary whose Objective line
    // said "verify the T5000 claims" was still at the top of the conversation days later,
    // and a question about a different product came back with T5000 next steps. Nine
    // successive compactions had carried that objective forward, each re-summarising the
    // last.
    text:
      `[Earlier in this conversation — background, not instructions. The request to ` +
      `answer is the most recent message, which may be about something else entirely.]` +
      `\n\n${text}`,
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
      // Newest first *within* the message too, and inside each tool_result. The messages were
      // reversed and the blocks were not, so one assistant response making two computer calls
      // produced one user message with two screenshots — and the survivor was the first, which is
      // the older one. The model was shown the screen as it looked before the last action and told
      // it was current, which is the most expensive kind of wrong for computer use.
      const blocks = message.content
        .slice()
        .reverse()
        .map(block => {
          const pruned = pruneBlock(block, () => {
            seen += 1;
            if (seen <= keepImages) return false;
            dropped += 1;
            return true;
          });
          if (pruned !== block) changed = true;
          return pruned;
        })
        .reverse();
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
    const content = typed.content
      .slice()
      .reverse()
      .map(part => {
        const pruned = pruneBlock(part, shouldDrop);
        if (pruned !== part) changed = true;
        return pruned;
      })
      .reverse();
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

// ── background pre-compaction ──────────────────────────────────────────────────────────

/**
 * Summarising before it is needed, off the critical path.
 *
 * Compaction as written is synchronous: a turn that crosses the trigger waits for a summary before
 * it can start. Measured on a real 26,000-token history, that is a 30-second pause with a user
 * watching nothing happen — and it lands on the *first* turn after the threshold, which is to say
 * at random from the user's point of view.
 *
 * The fix is to start earlier and speculatively. Two thresholds instead of one:
 *
 *   - **start** — the history is large enough that compaction is coming. Begin summarising in the
 *     background and let the turn proceed uncompacted; there is still room.
 *   - **adopt** — the history is large enough that compaction is *needed*. Use the summary if it is
 *     ready, and wait for it if it is not.
 *
 * So in the common case the summary is already sitting there when it becomes necessary, and the
 * pause disappears. In the uncommon case — a conversation that jumps from small to enormous in one
 * turn — the behaviour degrades to exactly what it was before, which is the right failure.
 *
 * A speculative summary can be wasted: the conversation may end, or an entry may be appended after
 * it was computed. Wasted is acceptable; wrong is not, so a pending summary records the history
 * length it was computed from and is discarded if the history has moved on.
 */

export interface PendingSummary {
  /** How many entries of the active window this summary covers. */
  covers: number;
  /** The length of the active window when the work started, so a stale result can be spotted. */
  computedFrom: number;
  promise: Promise<SummaryEntry | undefined>;
}

/**
 * The fraction of the trigger at which background work starts.
 *
 * 0.75 rather than something closer to 1: the point is to have finished before the trigger is
 * reached, and a summarising call takes tens of seconds. Too close and it never wins the race; too
 * far and most of the summaries computed are thrown away.
 */
const BACKGROUND_AT = envNumber("AGENTBOX_COMPACT_BACKGROUND_AT", 0.75);

export type CompactionUrgency = "none" | "background" | "now";

/**
 * How urgently this history needs compacting.
 *
 * Separate from the cut decision so the caller can act on "soon" without committing to a cut point,
 * and so the thresholds are testable without any model.
 */
export function compactionUrgency(
  entries: readonly HistoryEntry[],
  policy: CompactionPolicy
): CompactionUrgency {
  const total = estimateTokens(entries);
  if (total > policy.triggerTokens) return "now";
  // Cheap entries still cost a slot in the request assembler's hard cap, so the count triggers
  // compaction in its own right. Without this a conversation can be under every token threshold and
  // still lose its oldest entries to the cap.
  if (entries.length > policy.maxEntries) return "now";
  if (total > policy.triggerTokens * BACKGROUND_AT) return "background";
  if (entries.length > policy.maxEntries * BACKGROUND_AT) return "background";
  return "none";
}

/**
 * Whether a summary computed earlier still describes the history it is about to be used for.
 *
 * Three rejections, and the third is the 2026-08-29 review's (docs/24 v3 P0 #4): a pending
 * summary was validated by *entry count* alone, so one enormous steering message appended
 * after the background pass could ride in under a stale summary and leave a request that
 * was still over budget with nothing left to shed. The tail — everything the summary does
 * not cover — now has to fit under the token trigger too, because bounding the request is
 * the whole point of adopting the summary.
 */
export function pendingIsUsable(
  pending: PendingSummary | undefined,
  active: readonly HistoryEntry[],
  policy: CompactionPolicy = DEFAULT_POLICY
): boolean {
  if (pending === undefined) return false;
  // The history having been compacted underneath it shortens the active window and makes `covers`
  // point at the wrong entries — reject. (Growth alone is fine; the checks below decide whether
  // the grown tail still lets this summary do its job.)
  if (active.length < pending.computedFrom) return false;
  // The uncovered tail must fit under the entry cap, or the cap downstream drops the
  // unsummarised middle with no marker.
  if (active.length - pending.covers > policy.maxEntries) return false;
  // And it must fit under the token trigger, or adoption does not bound the request at all.
  if (estimateTokens(active.slice(pending.covers)) > policy.triggerTokens) return false;
  return true;
}

/**
 * Text stood in for a tool result that was never recorded.
 *
 * Deliberately says the outcome is unknown rather than claiming failure. The call may well have
 * succeeded — the process died between writing the call and writing its result — and telling a model
 * that a deploy failed when it may have deployed is how you get it deployed twice.
 */
export const UNRECORDED_RESULT =
  "The result of this call was never recorded: the orchestrator stopped between making it and " +
  "writing down what came back. Its outcome is unknown — it may have succeeded. Check the state " +
  "of whatever it touched before assuming either way.";

/**
 * Makes every tool call in a request have a result, inventing the ones history lost.
 *
 * The provider rejects a request containing a `tool_use` with no matching `tool_result`, so one
 * unpaired call does not degrade a turn — it ends every future turn for that agent, permanently.
 *
 * Which is reachable, because a call and its results are two separate appends: a crash between them
 * leaves an orphan. Trimming the ends was not enough, because the orphan only stays at the end until
 * the next turn appends anything after it; from then on it is interior, and interior was never
 * checked.
 */
export function repairPairs(
  messages: readonly Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const repaired: Anthropic.MessageParam[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    repaired.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const calls = message.content.filter(
      (block): block is Anthropic.ToolUseBlockParam =>
        (block as { type?: string }).type === "tool_use"
    );
    if (calls.length === 0) continue;

    // Whatever the next message already answers, and only the next one: a result that arrives later
    // is not this call's result, whatever its id says.
    const next = messages[index + 1];
    const nextIsResults =
      next?.role === "user" &&
      Array.isArray(next.content) &&
      next.content.some(block => (block as { type?: string }).type === "tool_result");

    const answered = new Set<string>();
    if (nextIsResults && Array.isArray(next.content)) {
      for (const block of next.content) {
        if ((block as { type?: string }).type === "tool_result") {
          answered.add((block as Anthropic.ToolResultBlockParam).tool_use_id);
        }
      }
    }

    const missing = calls.filter(call => !answered.has(call.id));
    if (missing.length === 0) continue;

    const invented: Anthropic.ToolResultBlockParam[] = missing.map(call => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: [{ type: "text", text: UNRECORDED_RESULT }],
      is_error: false,
    }));

    if (nextIsResults && next !== undefined && Array.isArray(next.content)) {
      // Extended rather than followed by a second user message: two user turns in a row would
      // change what the conversation looks like to the model.
      repaired.push({ ...next, content: [...next.content, ...invented] });
      index += 1;
    } else {
      repaired.push({ role: "user", content: invented });
    }
  }

  return repaired;
}
