/**
 * The agent turn loop.
 *
 * A manual tool-use loop rather than the SDK's tool runner, because a turn here
 * has to be abortable mid-flight: a priority message from a teammate supersedes
 * background work, and the abort has to land between tool calls.
 */

import { envNumber } from "../config.ts";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { AgentBus, InboundMessage } from "../agents/bus.ts";
import type { BoxClient } from "../box/client.ts";
import type { DisplayLease } from "../box/display-lease.ts";
import type { PolicyGate } from "./policy.ts";
import type { Claims } from "./claims.ts";
import type { FileVersions } from "./files.ts";
import type { TurnLedger } from "./resume.ts";
import type { Skill } from "./skills.ts";
import {
  classifyLimit,
  continuationPrompt,
  detectLoop,
  loopReport,
  MAX_CONTINUATIONS,
  signatureOf,
  stateHashOf,
  type RoundRecord,
} from "./progress.ts";
import {
  decideRetry,
  FirstTokenStallError,
  FIRST_TOKEN_DEADLINE_MS,
} from "./transient.ts";
import type { UsageLog } from "./usage.ts";
import { chooseRelevant, recall } from "./memory.ts";
import {
  activeWindow,
  buildSummaryPrompt,
  compactionUrgency,
  pendingIsUsable,
  type PendingSummary,
  estimateMessageTokens,
  noteContextWindow,
  policyForModel,
  repairPairs,
  pruneOldImages,
  shouldPruneImages,
  chooseCutPoint,
  droppedEntry,
  estimateTokens,
  summaryEntry,
  type HistoryEntry,
  type SummaryEntry,
} from "./compaction.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { buildSystemPromptParts, buildTurnPrompt } from "./prompt.ts";
import { buildTools, dispatchTool, type ToolOutcome } from "./tools.ts";
import { resolveSummaryProvider } from "./provider.ts";
import type { Effort, ProviderProfile } from "./provider.ts";

/**
 * Round cap.
 *
 * This is a runaway guard, not a task budget. It has to be generous: one round is
 * one model turn, and a real GUI task spends a round per click, so a browser
 * workflow can legitimately run well past a hundred. Set it near the plausible ceiling of honest work and treat reaching it as
 * a fault rather than a finish — a silent stop looks exactly like a completed
 * turn, which is the worst way to fail.
 */
const MAX_ROUNDS = envNumber("AGENTBOX_MAX_ROUNDS", 400);

/**
 * How many of the most recent screenshots survive an in-turn prune.
 *
 * One, because one is what the decision needs: an agent choosing where to click needs the screen as
 * it is now. Two is defensible for before/after comparisons and costs another ~1,600 tokens a round.
 */
const KEEP_IMAGES = envNumber("AGENTBOX_KEEP_IMAGES", 1);

/**
 * How many times one turn may shed content and retry after the provider rejects the request.
 *
 * Bounded so a provider that rejects everything cannot become an infinite loop. Each attempt sheds
 * strictly more than the last, so three is enough to go from "all screenshots" to "one" to "none".
 */
const MAX_SHED_ATTEMPTS = envNumber("AGENTBOX_MAX_SHED_ATTEMPTS", 3);

/** What kind of "too big" a provider is complaining about, or undefined if it is not that. */
type Overflow = "context-window" | "too-many-images";

/**
 * Reads a provider error for the two distinct ways a request can be too large.
 *
 * They are separate because the fixes are separate: a context-window overflow is about total tokens
 * and is helped by dropping anything, while an image-count limit is about the *number* of images
 * regardless of size and is only helped by dropping images. Treating them as one thing means
 * shedding text to fix an image-count error and failing again with the same message.
 *
 * Matched on message text because that is what providers actually give us — status codes are shared
 * with unrelated failures, and an over-broad match here would turn a genuine bug into a silent
 * retry. Hence the specific phrases rather than a search for "token" or "large".
 */
function classifyOverflow(error: unknown): Overflow | undefined {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const imagePhrases = [
    "too many images",
    "too many images or documents",
    "too much media",
    "image count",
  ];
  if (imagePhrases.some(phrase => message.includes(phrase))) return "too-many-images";

  const contextPhrases = [
    "prompt is too long",
    "context length",
    "context_length_exceeded",
    "maximum context",
    "input length and `max_tokens` exceed",
    "input token limit",
    "too many total text bytes",
    "request too large",
  ];
  if (contextPhrases.some(phrase => message.includes(phrase))) return "context-window";
  return undefined;
}

/**
 * Sheds content in place so the same round can be retried, and says what it did.
 *
 * Ordered by what costs least to lose. Images first, because they are the bulk and only the newest
 * matters. Then all images, because an image-count limit is not about size. Only then text, and even
 * then the oldest tool results rather than anything the model said — a tool result is evidence the
 * transcript still holds, while dropping the model's own words rewrites the conversation it is
 * mid-way through.
 *
 * `dropped` of zero means nothing further can be shed, which the caller turns into a clear error
 * rather than another attempt.
 */
function shedForRetry(
  messages: Anthropic.MessageParam[],
  overflow: Overflow
): { dropped: number; detail: string } {
  // An image-count rejection is not about tokens, so keeping even one may be too many.
  const keep = overflow === "too-many-images" ? 0 : KEEP_IMAGES;
  const pruned = pruneOldImages(messages, keep);
  if (pruned.dropped > 0) {
    messages.length = 0;
    messages.push(...pruned.messages);
    return {
      dropped: pruned.dropped,
      detail:
        `dropped ${pruned.dropped} screenshot(s)` +
        (keep === 0 ? " (all of them: the limit is on image count, not size)" : "") +
        `, about ${pruned.reclaimedTokens} tokens`,
    };
  }

  const trimmed = truncateOldestResults(messages);
  if (trimmed.dropped > 0) {
    return {
      dropped: trimmed.dropped,
      detail: `truncated ${trimmed.dropped} older tool result(s), about ${trimmed.chars} characters`,
    };
  }
  return { dropped: 0, detail: "nothing further can be dropped" };
}

/** Tool-result text kept when a retry has to reach for text. Enough to stay evidence. */
const SHED_RESULT_LIMIT = 500;

/**
 * Shortens the oldest oversized tool results, leaving a note where the rest was.
 *
 * Oldest first and results only: the newest results are what the current decision rests on, and the
 * model's own messages are not ours to rewrite. A truncated result says so, because an agent that
 * silently sees less than it did would draw conclusions from an absence.
 */
function truncateOldestResults(
  messages: Anthropic.MessageParam[]
): { dropped: number; chars: number } {
  let dropped = 0;
  let chars = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if ((block as { type?: string }).type !== "tool_result") continue;
      const result = block as Anthropic.ToolResultBlockParam;
      if (!Array.isArray(result.content)) continue;
      for (const part of result.content) {
        const typed = part as { type?: string; text?: string };
        if (typed.type !== "text" || typeof typed.text !== "string") continue;
        if (typed.text.length <= SHED_RESULT_LIMIT) continue;
        chars += typed.text.length - SHED_RESULT_LIMIT;
        typed.text =
          `${typed.text.slice(0, SHED_RESULT_LIMIT)}\n[truncated to fit the context window]`;
        dropped += 1;
        // One pass, and only until something was actually freed: shedding the minimum keeps the
        // most evidence, and the retry will come back if it was not enough.
        if (chars > 20_000) return { dropped, chars };
      }
    }
  }
  return { dropped, chars };
}
/** Transcript entries replayed into a new turn's context. */
const HISTORY_LIMIT = 60;

export interface TurnDeps {
  client: Anthropic;
  registry: AgentRegistry;
  bus: AgentBus;
  box: BoxClient | undefined;
  /** Which desktop this agent drives. Each agent has its own. */
  displayIndex?: number;
  /** Presented on every box call, so the box can refuse another agent's desktop. */
  boxOwner?: string;
  /** Where what a turn cost is written. Absent in tests that do not care. */
  usage?: UsageLog;
  /**
   * Asked whether this turn may keep going, and whether its tools may run.
   *
   * Absent means allow, which is the behaviour before this existed. Present, it is asked once per
   * round — so a stop takes effect at the next round boundary rather than mid-request, which is the
   * only place a turn can be left in a state the transcript describes correctly.
   */
  policy?: PolicyGate;
  /** Who is driving, threaded through so a memory kept this turn records who it is about. */
  caller?: { userId?: string };
  /**
   * Skills, already read from the box.
   *
   * Passed in rather than read here, because reading them is a box round trip and the turn loop
   * should not acquire a reason to fail before it has started.
   */
  skills?: readonly Skill[];
  /** Guards one desktop against two agents; moot when each has its own. */
  display?: DisplayLease;
  /**
   * What each agent last saw each shared file as, so two of them writing one file is noticed
   * rather than silently resolved by whoever wrote last.
   */
  files?: FileVersions;
  /** Who has taken which piece of work, so two agents do not take the same one. */
  claims?: Claims;
  /**
   * Asks a cheap model which memories matter for this message.
   *
   * Only consulted when the budget forces a choice. Absent means the scoring decides, which is what
   * happened before this existed and what still happens whenever everything fits.
   */
  selectMemory?: (prompt: string) => Promise<string | undefined>;
  resolution: ResolutionConfig | undefined;
  /** Which endpoint and what it can do. Omitted in tests to mean full Claude. */
  provider?: ProviderProfile;
  effort?: Effort;
  /**
   * Records that this turn began, so a process that dies underneath it leaves a fact rather than a
   * silence.
   *
   * Optional, and absent means no record — which is what every turn had before, and what a test
   * that should not touch the state directory wants.
   */
  turns?: TurnLedger;
  /**
   * The ledger handle for this turn, when it is a resumption of an earlier one.
   *
   * Threaded in rather than derived, because only the caller doing the resuming knows which turn
   * this continues and how many attempts have gone before.
   */
  resumeOf?: { id: string; attempt: number };
  onEvent?: (event: TurnEvent) => void;
}

const FULL_CLAUDE: ProviderProfile = {
  label: "Anthropic",
  model: "claude-opus-5",
  maxTokens: 64_000,
  vision: true,
  adaptiveThinking: true,
  effort: true,
  promptCaching: true,
  auth: "x-api-key",
  keyEnv: "ANTHROPIC_API_KEY",
};

export type TurnEvent =
  | { type: "text"; agentId: string; agentName: string; delta: string }
  | { type: "tool_start"; agentId: string; agentName: string; tool: string; input: unknown }
  | {
      type: "tool_end";
      agentId: string;
      agentName: string;
      tool: string;
      summary: string;
      /**
       * base64 WebP, when the tool returned one. Carried so a watching UI can
       * show what the agent actually saw, which is the difference between
       * trusting its account of the screen and checking it.
       */
      screenshot?: string;
    }
  | { type: "round"; agentId: string; round: number }
  /**
   * The history outgrew the context window and was summarised.
   *
   * Its own event rather than a line of agent prose: the agent did not say this, and a feed that
   * attributes it to the agent is lying about who is talking. It is feed-worthy because it is the
   * one moment where what the agent can see stops matching what it did.
   */
  | {
      type: "compacted";
      agentId: string;
      /** How many entries the summary stands in for. */
      covers: number;
      /** False when summarising failed and the entries were dropped instead. */
      summarised: boolean;
      detail: string;
    }
  | { type: "aborted"; agentId: string }
  /**
   * A round failed in a way a retry can fix, and is being retried.
   *
   * `discardPartial` is the load-bearing field: nothing was written to the transcript, so a partial
   * answer exists only on the watcher's screen and would otherwise appear twice.
   */
  | {
      type: "retrying";
      agentId: string;
      round: number;
      attempt: number;
      delayMs: number;
      kind: string;
      discardPartial: boolean;
      detail: string;
    }
  | {
      type: "usage";
      /** Which round of the turn, so a long turn is visible as one. */
      round: number;
      agentId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };

/**
 * A transcript record.
 *
 * Tool traffic is persisted as real content blocks rather than as prose, and that
 * distinction is load-bearing. Persisting only text taught agents to skip the
 * work: a past turn read as "asked to write a file" followed by "Done — wrote the
 * file", with the write invisible, and an agent shown that shape twice produced
 * the second half without the first.
 *
 * The first attempt at a fix — appending a "[tools used this turn]" summary as
 * assistant text — made it worse. The model could see that line in its history,
 * so it simply wrote one itself, complete with an invented success message, and
 * called nothing. An audit trail the model can forge is not an audit trail.
 * `tool_use` and `tool_result` blocks are a separate channel it cannot type into.
 */
export type TranscriptEntry =
  | {
      role: "user" | "assistant";
      text: string;
      at: string;
      /**
       * The messages that caused this turn, by id.
       *
       * For whoever is reconstructing what happened afterwards, not for the model — which has no
       * use for a list of uuids and never sees this field. Every agent runs in one process against
       * one clock, so ordering was never the missing piece; the link was.
       */
      causedBy?: readonly string[];
    }
  /** An assistant turn that called tools; carries text and tool_use blocks. */
  | { role: "assistant"; kind: "blocks"; blocks: Anthropic.ContentBlockParam[]; at: string }
  /** The matching results. Must immediately follow its `blocks` entry. */
  | {
      role: "user";
      kind: "results";
      blocks: Anthropic.ToolResultBlockParam[];
      at: string;
    }
  /** Stands in for the entries before it when the history outgrew the context window. */
  | {
      role: "user";
      kind: "summary";
      covers: number;
      text: string;
      at: string;
    };

/** Tool-result text kept in replayed history. Enough to be evidence, not bulky. */
const REPLAYED_RESULT_LIMIT = 2_000;

/**
 * Strips a tool result down for storage.
 *
 * Images are dropped: a turn of computer use would otherwise put a megabyte of
 * screenshots into every later request, and without compaction that ends the
 * conversation. The text stays, so the model still sees that it looked and what
 * it was told.
 */
function storableResult(
  block: Anthropic.ToolResultBlockParam
): Anthropic.ToolResultBlockParam {
  const content = Array.isArray(block.content) ? block.content : [];
  const texts = content
    .filter((part): part is Anthropic.TextBlockParam => part.type === "text")
    .map(part => part.text);
  const imageCount = content.filter(part => part.type === "image").length;

  let text = texts.join("\n").slice(0, REPLAYED_RESULT_LIMIT);
  if (imageCount > 0) {
    text += `\n[${imageCount} screenshot(s) were attached and shown at the time]`;
  }

  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: [{ type: "text", text: text || "(no output)" }],
    is_error: block.is_error,
  };
}

/**
 * Rebuilds message history from the transcript.
 *
 * The window is trimmed to whole tool exchanges: a `tool_use` block whose result
 * was cut off, or a result whose call was, is rejected by the API — so an orphan
 * at either end is dropped rather than sent.
 */
/**
 * Summarises the front of a history that has outgrown the context window.
 *
 * Returns the history to assemble from — either unchanged, or with a summary entry appended and
 * persisted. Never throws: a turn that cannot summarise still has to run, so the fallback drops the
 * oldest entries and says so in the history rather than failing or trimming silently.
 *
 * The summarising call is a plain, tool-free request on the same model the agent uses. A dedicated
 * cheaper or wider model would be better and is a configuration change, not a code one.
 */
/**
 * Summaries computed speculatively, keyed by agent.
 *
 * Module-level and in memory on purpose: a speculative summary is worth nothing after a restart —
 * the work is cheap to redo and the alternative is persisting something the agent has not adopted.
 * Bounded by the number of agents, which is bounded by desktops (32).
 */
const pendingSummaries = new Map<string, PendingSummary>();

/** Produces one summary of the given entries, or undefined when the model would not cooperate. */
async function summarise(
  entries: readonly HistoryEntry[],
  covers: number,
  client: Anthropic,
  summaryProvider: ProviderProfile
): Promise<SummaryEntry | undefined> {
  const response = await client.messages.create({
    model: summaryProvider.model,
    // Enough for a dense summary and no more; a summary that runs to pages defeats the purpose.
    max_tokens: Math.min(4096, summaryProvider.maxTokens),
    messages: [{ role: "user", content: buildSummaryPrompt(entries) }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  return summaryEntry(text, covers);
}

/**
 * Summarises the front of a history that has outgrown the context window.
 *
 * Returns the history to assemble from — either unchanged, or with a summary entry appended and
 * persisted. Never throws: a turn that cannot summarise still has to run, so the fallback drops the
 * oldest entries and says so in the history rather than failing or trimming silently.
 *
 * Three outcomes rather than two, which is the point of the background pass:
 *
 *   - **none** — well under the trigger. Nothing happens.
 *   - **background** — approaching it. A summary is started and *not waited for*; this turn goes
 *     out uncompacted, because there is still room. If it finishes before it is needed, the pause
 *     the user would have seen disappears.
 *   - **now** — over it. Use the speculative summary if one is ready and still describes this
 *     history, otherwise compute one and wait.
 *
 * The summarising call uses a separate, cheaper profile where one is available: it is a plain,
 * tool-free, text-in-text-out request, and paying the agent's own model for it is the most
 * expensive way to do the least interesting work.
 */
async function compactHistory(options: {
  history: TranscriptEntry[];
  agent: AgentRecord;
  registry: AgentRegistry;
  client: Anthropic;
  provider: ProviderProfile;
  log: (line: string) => void;
  onCompacted: (event: { type: "compacted"; covers: number; summarised: boolean; detail: string }) => void;
}): Promise<TranscriptEntry[]> {
  const { history, agent, registry, client, provider, log, onCompacted } = options;
  const active = activeWindow(history as HistoryEntry[]);
  // Derived from the model's real window once one response has reported it, so the same code is
  // right for a 200k model and a 1M one.
  const policy = policyForModel(provider.model);
  const urgency = compactionUrgency(active, policy);
  if (urgency === "none") {
    pendingSummaries.delete(agent.id);
    return history;
  }

  // Forced when pre-computing: in the background band the total is still under the trigger, so the
  // ordinary gate would refuse to name a cut and nothing would ever be prepared.
  const cut = chooseCutPoint(active, policy, { force: urgency === "background" });
  if (!cut) return history;
  const olderEntries = active.slice(0, cut.index);
  const summaryProvider = resolveSummaryProvider(provider);

  if (urgency === "background") {
    // Start it and walk away. Nothing here is awaited, and a failure is swallowed on purpose: this
    // is speculative work, and the `now` path will report properly if it ever becomes necessary.
    if (!pendingSummaries.has(agent.id)) {
      log(
        `pre-summarising ${cut.index} entries in the background on ${summaryProvider.model}; ` +
          `this turn proceeds uncompacted`
      );
      pendingSummaries.set(agent.id, {
        covers: cut.index,
        computedFrom: active.length,
        promise: summarise(olderEntries, cut.index, client, summaryProvider).catch(() => undefined),
      });
    }
    return history;
  }

  log(`compacting history: ${cut.reason}`);

  let entry: SummaryEntry;
  try {
    const pending = pendingSummaries.get(agent.id);
    let ready: SummaryEntry | undefined;
    if (pendingIsUsable(pending, active.length)) {
      ready = await pending!.promise;
      if (ready !== undefined) {
        log(`used the summary prepared in the background (${pending!.covers} entries)`);
      }
    }
    const produced = ready ?? (await summarise(olderEntries, cut.index, client, summaryProvider));
    if (produced === undefined) throw new Error("the summariser returned no text");
    entry = produced;
    const detail =
      `summarised ${entry.covers} entries: about ${estimateTokens(olderEntries)} tokens ` +
      `became ${estimateTokens([entry])}` +
      (ready === undefined ? "" : " (prepared in the background)");
    log(detail);
    onCompacted({ type: "compacted", covers: entry.covers, summarised: true, detail });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Loud, and told to the model: the alternative was a request that cannot fit, and the
    // alternative to that was dropping history with no trace of it having happened.
    entry = droppedEntry(cut.index, reason);
    const detail = `could not summarise (${reason}); dropped ${cut.index} entries instead`;
    log(detail);
    onCompacted({ type: "compacted", covers: cut.index, summarised: false, detail });
  } finally {
    // Consumed either way: a summary that was adopted must not be adopted twice, and one that
    // failed must not be retried forever.
    pendingSummaries.delete(agent.id);
  }

  registry.appendTranscript(agent.id, entry);
  return [...history, entry as TranscriptEntry];
}

function historyToMessages(
  entries: readonly TranscriptEntry[]
): Anthropic.MessageParam[] {
  // From the newest summary onwards. Everything before it stays in the transcript on disk — the
  // record is what makes an agent's claims checkable, so compaction changes the request, never the
  // record.
  //
  // The slice is a backstop: compaction bounds the window by tokens and by entry count, so this
  // rarely fires. When it does, the leading summary is kept even though it is the oldest entry,
  // because it is the one marker that history was compacted at all — dropping it as well would
  // discard uncovered history with no trace that anything was cut.
  const full = activeWindow(entries as HistoryEntry[]) as TranscriptEntry[];
  const leadingSummary =
    full.length > 0 && "kind" in full[0]! && (full[0] as { kind?: string }).kind === "summary"
      ? full[0]
      : undefined;
  let window = full.slice(-HISTORY_LIMIT);
  if (leadingSummary !== undefined && window[0] !== leadingSummary) {
    window = [leadingSummary, ...window.slice(-(HISTORY_LIMIT - 1))];
  }

  // A results entry at the front has lost its call.
  while (window.length > 0 && "kind" in window[0]! && window[0]!.kind === "results") {
    window.shift();
  }
  // A trailing call with no results is *kept*, not dropped. It used to be popped, because a request
  // ending in an unpaired `tool_use` is rejected — but pairing is now repaired below, and popping it
  // deleted the one piece of evidence a resumed turn most needs: the action that was in flight when
  // the process died. The agent was told to check what it might have been part-way through, and the
  // record of what that was had been removed from its own history.

  const messages: Anthropic.MessageParam[] = [];
  for (const entry of window) {
    if ("kind" in entry) {
      if (entry.kind === "summary") {
        messages.push({ role: "user", content: entry.text });
        continue;
      }
      if (entry.blocks.length === 0) continue;
      messages.push({ role: entry.role, content: entry.blocks });
    } else if (entry.text.trim() !== "") {
      messages.push({ role: entry.role, content: entry.text });
    }
  }
  // Last, over the assembled request rather than over the entries: an unpaired call does not
  // degrade a turn, it ends every future turn for this agent, so the guarantee belongs at the point
  // the request is actually made.
  return repairPairs(messages);
}

/**
 * Builds the tool_result content block for one tool call.
 *
 * A screenshot rides back as an image block alongside the text, which is what
 * makes the computer tool work at all — the model needs to see the end state.
 */
function toolResultBlock(
  toolUseId: string,
  outcome: ToolOutcome
): Anthropic.ToolResultBlockParam {
  const content: Anthropic.ToolResultBlockParam["content"] = [
    { type: "text", text: outcome.text },
  ];

  for (const image of outcome.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  }

  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: outcome.isError,
  };
}

export class TurnAborted extends Error {
  constructor() {
    super("Turn aborted");
    this.name = "TurnAborted";
  }
}

/** Thrown when a turn hits the round cap, so a stall is visible rather than silent. */
export class TurnRoundLimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnRoundLimitExceeded";
  }
}

/**
 * Runs one turn for an agent: build context, call the model, execute tools, repeat
 * until the model stops asking for tools.
 */
export async function runTurn(
  agent: AgentRecord,
  inbound: readonly InboundMessage[],
  signal: AbortSignal,
  deps: TurnDeps
): Promise<void> {
  if (inbound.length === 0) return;

  const { registry, bus, box, client } = deps;
  const emit = deps.onEvent ?? (() => {});
  const provider = deps.provider ?? FULL_CLAUDE;

  // Recorded before anything else, so a process that dies at any point after this leaves a begin
  // with no end — a fact, rather than a turn that simply stopped existing.
  const turnId = randomUUID();
  let ended = false;
  const finish = (how: string) => {
    if (ended) return;
    ended = true;
    deps.turns?.end(turnId, how);
  };

  // Which memories survive the budget, decided by a model only when the budget forces a choice.
  //
  // Below the budget nothing is dropped, so there is nothing to choose between and no call is made —
  // which is almost always. The discipline this respects is in docs/05-data.md §7: lexical recall
  // stays until there is evidence it is failing, and "memories are being left out" is that evidence
  // rather than an impression.
  const ownMemory = registry.readMemoryRecords(agent.id);
  const memoryRecall = await chooseRelevant({
    records: ownMemory,
    query: inbound.map(message => message.text).join(" "),
    ask: deps.selectMemory ?? (async () => undefined),
    log: line => console.error(`[memory] ${agent.profile.name}: ${line}`),
  });

  // Built once, and the volatile half rebuilt on every continuation — see `rebuildVolatile`. The
  // stable half never changes for one agent, so it is fixed here.
  const buildParts = (recallToUse: typeof memoryRecall) =>
    buildSystemPromptParts({
      agent,
      teammates: registry.list(),
      memory: registry.readMemoryRecords(agent.id),
      memoryRecall: recallToUse,
      sharedMemory: registry.readSharedMemory(),
      skills: deps.skills,
      transcript: registry.readTranscript(agent.id),
      // Read fresh, which is what makes the plan and the todo list survive a compaction: they are in
      // the prompt rather than in the history a summary replaces.
      durable: registry.readDurableState(agent.id),
      resolution: deps.resolution,
      agentsRoot: registry.root,
      hasBox: box !== undefined,
      vision: provider.vision,
    });
  const promptParts = buildParts(memoryRecall);

  // Two breakpoints, one per stability tier. The first covers the tool
  // definitions and the invariant prompt; the second extends the cache over
  // memory and the roster while those are unchanged, and is the only part that
  // has to be re-processed when the agent writes a memory. Breakpoints are
  // dropped entirely where the endpoint does not implement caching, rather than
  // sent and ignored.
  const cache = provider.promptCaching
    ? ({ cache_control: { type: "ephemeral" } } as const)
    : {};
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: promptParts.stable, ...cache },
    { type: "text", text: promptParts.volatile, ...cache },
  ];

  // A stop belongs to the turn that was running. Clearing it as the next turn starts means a
  // person's next instruction is not silently refused — which would read as the agent having broken
  // rather than having been stopped.
  //
  // Here, at the top, rather than after the history is assembled. Compaction can wait on a
  // summariser for several seconds, and a stop pressed during that wait was cleared by this line
  // moments later: one flag meant both "stop the turn that was running" and "stop the turn that is
  // starting", and clearing the first threw away the second. The Stop button did nothing, silently.
  deps.policy?.resume(agent.id);

  let history = registry.readTranscript(agent.id) as TranscriptEntry[];
  const turnText = buildTurnPrompt(inbound);

  // Before assembling: a conversation that has grown past what fits is summarised, once, and the
  // summary is persisted so later turns pay nothing. Measured on this system at 158KB and 40k
  // tokens after a day — the end of that road is a turn failing on a request that cannot be made
  // smaller, at the worst possible moment.
  history = await compactHistory({
    history,
    agent,
    registry,
    client,
    provider,
    log: line => console.error(`[compaction] ${agent.profile.name}: ${line}`),
    onCompacted: event => emit({ ...event, agentId: agent.id }),
  });

  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(history),
    { role: "user", content: turnText },
  ];

  registry.appendTranscript(agent.id, {
    role: "user",
    text: turnText,
    at: new Date().toISOString(),
    // Which messages caused this turn. Recorded on the entry rather than written into the text: it
    // is for whoever is reconstructing what happened afterwards, and the model has no use for a
    // list of uuids. Without it a turn holds no trace of what set it off, so "who caused this" can
    // not be walked backwards however precisely everything was timed.
    causedBy: inbound.map(message => message.id),
  } satisfies TranscriptEntry);

  // Narrowed by this agent's profile. Withheld, not refused: a tool it may not use is not in its
  // prompt at all.
  const tools = buildTools(box !== undefined, provider.vision, agent.profile.tools);

  // One entry per completed round, for the loop and progress judgements. Held out here rather than
  // inside runRounds so a continuation can reset it: a fresh budget deserves a fresh judgement.
  const rounds: RoundRecord[] = [];

  // The ledger opens here, not during setup. Its job is to record that a turn was *executing* — a
  // model call, a tool — when the process died, so the next startup resumes it. Everything above is
  // assembly that ran nothing; a death there loses no work (the accepted message is still in the
  // inbox) and would otherwise have left an open ledger that read a setup failure as an interrupted
  // turn and resumed one that had already reported failing.
  deps.turns?.begin({
    id: turnId,
    agentId: agent.id,
    about: inbound.map(message => message.text).join(" / "),
    ...(deps.resumeOf !== undefined
      ? { resumeOf: deps.resumeOf.id, attempt: deps.resumeOf.attempt }
      : {}),
  });

  try {
    // Continuations are a loop here rather than recursion inside runRounds: each pass gets a fresh
    // round budget and a fresh look at the history, and the plan and todo list carry the intent
    // across. A turn that was working steadily resumes instead of being abandoned at the limit.
    let continuation = 0;
    for (;;) {
      const outcome = await runRounds(continuation);
      if (outcome === undefined) break;
      continuation = outcome.continuation;
      registry.appendTranscript(agent.id, {
        role: "user",
        text: outcome.continueWith,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry);

      // Reassembled from the transcript, and compacted on the way, which is what the comment above
      // has always claimed and what the code did not do: a continuation used to push one more
      // message onto the array the previous four hundred rounds had built. So the turn that most
      // needs room — one still working after four hundred rounds — was the only one that never got
      // any, and proactive compaction could not help because it had already run, once, before the
      // first round.
      //
      // Everything a completed round produced is on disk by now, so re-reading loses nothing; and
      // an orphaned call left by the round limit is paired up during assembly.
      history = await compactHistory({
        history: registry.readTranscript(agent.id) as TranscriptEntry[],
        agent,
        registry,
        client,
        provider,
        log: line => console.error(`[compaction] ${agent.profile.name}: ${line}`),
        onCompacted: event => emit({ ...event, agentId: agent.id }),
      });
      // In place: `runRounds` closes over this array.
      messages.length = 0;
      messages.push(...historyToMessages(history));

      // Rebuild the volatile system block from disk too. The durable blocks — plan, todos — are the
      // whole point of surviving compaction, and an agent updates them *mid-turn*: it marks a todo
      // done in round five, and a continuation compacts that tool result away while the system block,
      // built once at turn start, still says the todo is pending. The stable half is unchanged, so
      // only system[1] is rewritten. Memory is not re-selected here — that is a model call, and the
      // thing that goes stale across a continuation is the durable state, not the recalled facts.
      system[1] = { type: "text", text: buildParts(recall(registry.readMemoryRecords(agent.id))).volatile, ...cache };

      rounds.length = 0; // a fresh budget means a fresh judgement about looping
    }
    finish("done");
  } catch (error) {
    // An end either way. A turn that failed or was aborted is over, and leaving it open would have
    // the next startup try to resume something that already reported itself.
    finish(error instanceof TurnAborted ? "aborted" : "failed");
    throw error;
  } finally {
    // Release the desktop however the turn ends — normally, by abort, or by
    // throwing. A lease leaked here would lock every other agent out of the
    // screen for the lifetime of the process.
    deps.display?.release(agent.id);
  }

  async function runRounds(
    continuation: number
  ): Promise<{ continueWith: string; continuation: number } | undefined> {
  // How many times this turn has had to shed content after a rejection. Bounded, because a provider
  // that rejects everything must not become an infinite retry loop.
  let shed = 0;
  // Transient retries across the whole turn, not per round: a connection that keeps dropping should
  // not get four fresh attempts at every round of a four-hundred-round turn.
  let attempts = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) {
      emit({ type: "aborted", agentId: agent.id });
      throw new TurnAborted();
    }
    // Asked before spending anything. A stop or an exhausted budget ends the turn here, at a round
    // boundary, where the transcript is consistent — aborting mid-request would leave a call with no
    // result, which is a shape the next turn cannot replay.
    const permitted = deps.policy?.check({
      kind: "model-call",
      agentId: agent.id,
      agentName: agent.profile.name,
      round,
    });
    if (permitted !== undefined && !permitted.allow) {
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: permitted.reason,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry);
      emit({
        type: "text",
        agentId: agent.id,
        agentName: agent.profile.name,
        delta: permitted.reason,
      });
      return;
    }

    emit({ type: "round", agentId: agent.id, round });

    // Proactive guard, before the request rather than after it fails. Compaction of the *history*
    // happened once, before this turn; it cannot help a turn that outgrows the window on its own,
    // and a computer-use turn does exactly that — one screenshot per round, up to MAX_ROUNDS of
    // them, all still being sent on the last one. Only the newest screen matters for deciding what
    // to click; the rest is a claim about the past that the text already records.
    const estimated = estimateMessageTokens(messages);
    if (shouldPruneImages(estimated, provider.model)) {
      const pruned = pruneOldImages(messages, KEEP_IMAGES);
      if (pruned.dropped > 0) {
        messages.length = 0;
        messages.push(...pruned.messages);
        const note =
          `dropped ${pruned.dropped} older screenshot(s) to fit the context window ` +
          `(about ${pruned.reclaimedTokens} tokens, from an estimated ${estimated})`;
        console.error(`[compaction] ${agent.profile.name}: ${note}`);
        emit({
          type: "compacted",
          agentId: agent.id,
          covers: pruned.dropped,
          summarised: true,
          detail: note,
        });
      }
    }

    // Tracked per attempt: whether anything reached the watcher. A retry cannot duplicate stored
    // history — nothing is appended until the round completes — but it can show a partial answer
    // twice, and the watcher is told so it can drop the first.
    let outputProduced = false;
    let firstTokenTimer: NodeJS.Timeout | undefined;
    const attemptControl = new AbortController();
    // Two signals: the caller's abort, and our own first-token deadline. Linked so either ends the
    // request and the classifier can still tell which happened.
    const onOuterAbort = () => attemptControl.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    const stream = client.messages.stream(
      {
        model: provider.model,
        max_tokens: provider.maxTokens,
        // Adaptive thinking with a summary, so the caller can show progress
        // instead of a silent pause on a long turn. Both this and effort are
        // Claude-only; a compatible endpoint that accepts them without
        // implementing them is worse than one that never sees them.
        ...(provider.adaptiveThinking
          ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
          : {}),
        ...(provider.effort
          ? { output_config: { effort: deps.effort ?? "high" } }
          : {}),
        system,
        tools,
        messages,
      },
      { signal: attemptControl.signal }
    );

    // A stream can open and then deliver nothing. That is not a slow answer — a slow answer produces
    // tokens — and waiting on it forever is indistinguishable from a hang.
    let stalled = false;
    firstTokenTimer = setTimeout(() => {
      if (!outputProduced) {
        stalled = true;
        attemptControl.abort();
      }
    }, FIRST_TOKEN_DEADLINE_MS);
    firstTokenTimer.unref?.();

    const sawProgress = () => {
      outputProduced = true;
      if (firstTokenTimer !== undefined) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
    };

    // Any content, not just prose. The deadline used to be cleared only by a `text` event, and a
    // round that is entirely tool calls — which is most of a computer-use turn — never produces one,
    // nor does a long stretch of thinking. So a model working perfectly well for two minutes was
    // aborted as stalled and retried, repeatedly, on exactly the turns that take longest.
    //
    // `message_start` is excluded on purpose: it is what a stream that has opened and delivered
    // nothing still sends, so treating it as progress would disable the deadline rather than widen
    // it. (The SDK does not surface `ping` here at all, which is why it is not in this check —
    // adding it would not compile.)
    stream.on("streamEvent", event => {
      if (event.type === "message_start") return;
      sawProgress();
    });

    stream.on("text", delta => {
      sawProgress();
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta });
    });

    // Both are per attempt and both used to outlive it: the listener was never removed and the timer
    // was never cleared unless a `text` event arrived. Four hundred rounds of that is four hundred
    // listeners on one signal — past Node's warning threshold — and as many pending timers.
    const releaseAttempt = () => {
      signal.removeEventListener("abort", onOuterAbort);
      if (firstTokenTimer !== undefined) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
    };

    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
      releaseAttempt();
    } catch (rawError) {
      releaseAttempt();
      // A first-token stall arrives as an abort, because that is how the request was ended. Named
      // properly here so the retry decision and the message a person reads both say what happened.
      const error = stalled ? new FirstTokenStallError(FIRST_TOKEN_DEADLINE_MS) : rawError;
      // The outer abort is the only one that means "a person stopped this"; our own deadline abort
      // must not be mistaken for it.
      if (signal.aborted) {
        emit({ type: "aborted", agentId: agent.id });
        throw new TurnAborted();
      }
      // The request did not fit. This is recoverable and must be recovered from: the alternative is
      // a turn that dies mid-task, which is the worst moment to find out. Shed what can be shed and
      // retry the same round — the estimate is only an estimate, so the proactive guard above will
      // sometimes be wrong and this is what catches it.
      const overflow = classifyOverflow(error);
      if (overflow !== undefined && shed < MAX_SHED_ATTEMPTS) {
        shed += 1;
        const relief = shedForRetry(messages, overflow);
        console.error(
          `[compaction] ${agent.profile.name}: request rejected (${overflow}); ` +
            `${relief.detail}; retrying round ${round}`
        );
        emit({
          type: "compacted",
          agentId: agent.id,
          covers: relief.dropped,
          summarised: relief.dropped > 0,
          detail: `request rejected (${overflow}); ${relief.detail}`,
        });
        if (relief.dropped === 0) {
          // Nothing left to shed. Retrying would fail identically, so say what is actually wrong
          // rather than looping until MAX_SHED_ATTEMPTS runs out.
          throw new Error(
            `The request is too large for ${provider.model} and nothing further can be dropped ` +
              `(${overflow}). The turn has ${messages.length} messages. Consider a model with a ` +
              `larger context window, or a smaller task.`
          );
        }
        round -= 1; // retry this round rather than consuming one
        continue;
      }

      // Everything else: was this a failure a retry could fix? A long turn is exposed to a dropped
      // connection precisely because it holds one open the longest, and before this a single blip
      // ended the turn and the work with it.
      const retry = decideRetry({
        error,
        attempt: attempts + 1,
        aborted: signal.aborted,
        outputProduced,
      });
      if (retry.retry) {
        attempts += 1;
        const detail =
          `${error instanceof Error ? error.message : String(error)} — ${retry.reason}` +
          (outputProduced ? "; the partial answer above is being discarded" : "");
        console.error(`[turn] ${agent.profile.name}: retrying round ${round} in ${retry.delayMs}ms: ${detail}`);
        emit({
          type: "retrying",
          agentId: agent.id,
          round,
          attempt: attempts,
          delayMs: retry.delayMs,
          kind: retry.kind,
          // The watcher needs this to drop what it already rendered: nothing was written to the
          // transcript, so the partial exists only on their screen.
          discardPartial: outputProduced,
          detail,
        });
        await new Promise(resolve => setTimeout(resolve, retry.delayMs));
        if (signal.aborted) {
          emit({ type: "aborted", agentId: agent.id });
          throw new TurnAborted();
        }
        round -= 1;
        continue;
      }

      console.error(
        `[turn] ${agent.profile.name}: giving up on round ${round}: ${retry.reason}`
      );
      throw error;
    }

    // Reported and written down. The event drives the UI; the record is what a collector outside
    // the box pulls, and what a bill is eventually made of — see src/host/usage.ts.
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    emit({ type: "usage", agentId: agent.id, round, ...usage });
    // Learn the real context window while we are here. Providers report it under different names —
    // Anthropic does not report it at all today, several OpenAI-compatible endpoints do — so this
    // reads whatever is present and falls back to the configured constants when nothing is.
    noteContextWindow(
      provider.model,
      (response.usage as { max_tokens?: number; context_window?: number }).max_tokens ??
        (response.usage as { context_window?: number }).context_window ??
        provider.contextWindow
    );
    deps.usage?.record({
      agentId: agent.id,
      agentName: agent.profile.name,
      // Recorded from what was actually used, with a fallback rather than an optional field: a
      // usage record whose model is missing cannot be priced later.
      provider: deps.provider?.label ?? "unknown",
      model: deps.provider?.model ?? "unknown",
      round,
      ...usage,
    });

    // Safety classifiers can decline a request; content is empty or partial.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      const note = `The model declined this request (category: ${category}).`;
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: note,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry);
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: note });
      return;
    }

    // Append the whole content array, not just text: tool_use blocks and thinking
    // blocks have to be echoed back unchanged for the next round to be valid.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      const finalText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("");
      if (finalText.trim()) {
        registry.appendTranscript(agent.id, {
          role: "assistant",
          text: finalText,
          at: new Date().toISOString(),
        } satisfies TranscriptEntry);
        return;
      }

      // A turn that ends with nothing to say used to end silently: nothing appended, nothing
      // emitted. From the person's side that is "I asked and nothing happened", which is the
      // worst-feeling failure there is — indistinguishable from a hang, a crash, or being ignored.
      //
      // It happens when a final message carries no text: thinking blocks only, an empty content
      // array, a model that stopped for a reason it did not narrate. Rare, and rare is exactly why
      // it is worth a line rather than a shrug.
      const silent =
        `The turn ended without anything to report. The model returned no text on its last round, ` +
        `so there is no answer here — not an empty one. Ask again, or ask for what is missing.`;
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: silent,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry);
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: silent });
      console.error(`[turn] ${agent.profile.name}: ended with no text on round ${round}`);
      return;
    }

    // Execute every requested tool and return all results in one user message.
    // Splitting them across messages trains the model out of parallel calls.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      emit({
        type: "tool_start",
        agentId: agent.id,
        agentName: agent.profile.name,
        tool: toolUse.name,
        input: toolUse.input,
      });

      let outcome: ToolOutcome;
      try {
        outcome = await dispatchTool(
          toolUse.name,
          (toolUse.input ?? {}) as Record<string, unknown>,
          {
            agent,
            registry,
            bus,
            box,
            files: deps.files,
            claims: deps.claims,
            policy: deps.policy,
            caller: deps.caller,
            display: deps.display,
            displayIndex: deps.displayIndex,
            boxOwner: deps.boxOwner,
          }
        );
      } catch (error) {
        outcome = {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      emit({
        type: "tool_end",
        agentId: agent.id,
        agentName: agent.profile.name,
        tool: toolUse.name,
        summary: outcome.text.split("\n")[0]?.slice(0, 200) ?? "",
        screenshot: outcome.images?.[0]?.data,
      });

      results.push(toolResultBlock(toolUse.id, outcome));
    }

    // Persist the exchange as blocks, in the order the API requires: the calling
    // assistant turn, then its results. Thinking blocks are not kept — they are
    // only valid within the turn that produced them.
    const at = new Date().toISOString();
    registry.appendTranscript(agent.id, {
      role: "assistant",
      kind: "blocks",
      blocks: response.content.filter(
        (block): block is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
          block.type === "text" || block.type === "tool_use"
      ),
      at,
    } satisfies TranscriptEntry);
    registry.appendTranscript(agent.id, {
      role: "user",
      kind: "results",
      blocks: results.map(storableResult),
      at,
    } satisfies TranscriptEntry);

    messages.push({ role: "user", content: results });

    // What this round did, reduced to what decides whether anything is happening. Recorded after the
    // tools ran, so a todo ticked off during the round counts as the change it is.
    rounds.push({
      signatures: toolUses.map(use => signatureOf(use.name, use.input)),
      stateHash: stateHashOf(registry.readDurableState(agent.id)),
    });

    // Detected as it starts rather than at the limit. An agent repeating one call has already wasted
    // every round since the second; there is nothing to learn from letting it do three hundred more.
    const loop = detectLoop(rounds);
    if (loop !== undefined) {
      const report = loopReport(loop, round + 1);
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: report,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry);
      emit({
        type: "text",
        agentId: agent.id,
        agentName: agent.profile.name,
        delta: report,
      });
      // Ended, not thrown: the agent stopped for a reason it has been told, which is an outcome
      // rather than a failure of the machinery.
      return;
    }
  }

  // Out of rounds. Which of the two situations this is decides everything, and until now it was a
  // guess written as a fact — "probably looping" on a turn that may have been working steadily.
  const outcome = classifyLimit(rounds);

  if (outcome.kind === "looping") {
    const report = loopReport(outcome.finding, MAX_ROUNDS);
    registry.appendTranscript(agent.id, {
      role: "assistant",
      text: report,
      at: new Date().toISOString(),
    } satisfies TranscriptEntry);
    throw new TurnRoundLimitExceeded(report);
  }

  if (outcome.kind === "progressing" && continuation < MAX_CONTINUATIONS) {
    // A budget, not a wall. The plan and todo list are in the system prompt and unchanged, and the
    // history will be compacted on the way in — so a fresh turn resumes rather than restarts.
    const next = continuation + 1;
    const note =
      `Used all ${MAX_ROUNDS} rounds and was still making progress; continuing in a fresh turn ` +
      `(${next} of ${MAX_CONTINUATIONS}).`;
    registry.appendTranscript(agent.id, {
      role: "assistant",
      text: note,
      at: new Date().toISOString(),
    } satisfies TranscriptEntry);
    emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: note });
    console.error(`[turn] ${agent.profile.name}: ${note}`);

    // Through the same gate as any other wake. An agent continuing itself is precisely the shape the
    // wake-rate limit exists to catch, so it is checked rather than exempted.
    const permitted = deps.policy?.check({
      kind: "wake",
      agentId: agent.id,
      agentName: agent.profile.name,
      targetId: agent.id,
      targetName: agent.profile.name,
    });
    if (permitted !== undefined && !permitted.allow) {
      throw new TurnRoundLimitExceeded(
        `${note} The continuation was refused: ${permitted.reason}`
      );
    }
    return { continueWith: continuationPrompt(MAX_ROUNDS, next), continuation: next };
  }

  // Neither progressing nor obviously looping, or out of continuations. Reported as what it is
  // rather than as a diagnosis nobody checked.
  const note =
    outcome.kind === "progressing"
      ? `Stopped after ${MAX_CONTINUATIONS} continuations. Work was still moving, so this is a ` +
        `budget rather than a conclusion — say what is left.`
      : `Stopped after ${MAX_ROUNDS} rounds. Nothing repeated often enough to call it a loop, and ` +
        `neither the plan nor the todo list changed, so it is not clear anything was achieved.`;
  registry.appendTranscript(agent.id, {
    role: "assistant",
    text: note,
    at: new Date().toISOString(),
  } satisfies TranscriptEntry);
  throw new TurnRoundLimitExceeded(note);
  }
}
