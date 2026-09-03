/**
 * The agent turn loop.
 *
 * A manual tool-use loop rather than the SDK's tool runner, because a turn here
 * has to be abortable mid-flight: a priority message from a teammate supersedes
 * background work, and the abort has to land between tool calls.
 */

import { createHash } from "node:crypto";
import { buildInfo } from "./build-info.ts";
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
import type { UsageKind, UsageLog } from "./usage.ts";
import { chooseRelevant } from "./memory.ts";
import { needsReview, type ReviewInput, type ReviewMode, type Verdict } from "./auto-review.ts";
import type { HookRunner } from "./hooks.ts";
import { AGENT_WAKE_CUE } from "../agents/bus.ts";
import { TEMPLATE_CUE, TEMPLATE_SETUP_TOOLS } from "./template.ts";
import {
  activeWindow,
  buildSummaryPrompt,
  compactionUrgency,
  pendingHasDrifted,
  pendingIsUsable,
  type PendingSummary,
  noteContextWindow,
  policyForModel,
  repairPairs,
  noteRealInputTokens,
  pruneOldImages,
  shouldPruneImages,
  chooseCutPoint,
  calibratedTokens,
  CompactionGuard,
  choosePinnedEntries,
  droppedEntry,
  estimateRequestTokens,
  extractAnchors,
  missingSummaryHeadings,
  estimateTokens,
  SUMMARY_WORD_CAP,
  summaryEntry,
  type HistoryEntry,
  type SummaryEntry,
} from "./compaction.ts";
import { DURABLE_RESULT_CHARS, type ResolutionConfig } from "../protocol/index.ts";
import type { BoxClass } from "../box/access.ts";
import { emptySectionFaults, buildSystemPromptParts, buildTurnPrompt,
  turnReminderFor,
} from "./prompt.ts";
import {
  closingNudge,
  guardFor,
  guardsEnabled,
  MAX_GUARD_NUDGES,
  nudgeFor,
  readsAsChinese,
  type GuardReason,
} from "./guards.ts";
import {
  BOOKKEEPING_TOOLS,
  PARALLEL_SAFE_TOOLS,
  PARALLEL_TOOL_LIMIT,
  buildTools,
  dispatchTool,
  type ToolContext,
  type ToolOutcome,
} from "./tools.ts";
import type { HostRunner } from "./host-runner.ts";
import type { Vault } from "./vault.ts";
import type { TaskStore } from "./tasks.ts";
import type { ScopeStore } from "./scopes.ts";
import type { McpManager } from "./mcp.ts";
import { TOOL_BUDGET_WARNING } from "./mcp.ts";
import { narrowTools } from "./scopes.ts";
import { conversationIdFor, MAIN_CONVERSATION } from "../agents/registry.ts";
import { summaryRuntimeFor } from "./provider.ts";
import type { Effort, ProviderProfile } from "./provider.ts";

/**
 * Round cap.
 *
 * This is a runaway guard, not a task budget. It has to be generous: one round is
 * one model turn, and a real GUI task spends a round per click, so a browser
 * workflow can legitimately run well past a hundred. Set it near the plausible
 * ceiling of honest work and treat reaching it as a fault rather than a finish —
 * a silent stop looks exactly like a completed turn, which is the worst way to
 * fail.
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

/**
 * Below this many characters, text preceding bookkeeping-only tool calls is an aside
 * ("我先把这个记下来"), not a filed answer worth promoting into the reply. The named
 * risk in the R32 plan: without a floor, a genuine one-line acknowledgement followed
 * by the write-down it announces would be delivered as the answer.
 */
const FILED_ANSWER_FLOOR = 80;

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
 * Whether re-executing this call changes nothing outside the conversation.
 *
 * The declaration a resumed turn consults before re-running an interrupted call
 * instead of marking its outcome unknown. Conservative on purpose: only pure reads.
 * `Tasks` is safe for `list` alone — the same tool's `create` makes a task, which is
 * exactly the double-effect this list exists to prevent. `computer` is excluded even
 * for screenshots, because a batch mixes actions and a batch is judged whole.
 */
function safeToReplay(name: string, input: Record<string, unknown>): boolean {
  if (name === "read_file" || name === "list_dir" || name === "ReadHistory") return true;
  if (name === "Tasks" && input.action === "list") return true;
  return false;
}

/**
 * Output this close to the intended cap counts as reaching it: tokenizers land a few
 * tokens short of a hard limit, and misreading a genuine cap stop as truncation would
 * discard a legitimate long answer and pay to regenerate it.
 */
const GENUINE_CAP_MARGIN_TOKENS = 64;

/**
 * Whether a `max_tokens` stop means "the context squeezed the output", not "the
 * answer reached its intended length".
 *
 * The stop reason alone is ambiguous. Output at (or within a margin of) the cap we
 * asked for is a genuine limit stop — append it and move on. Output well *below* that
 * cap with the same stop reason means the provider clamped the output budget to what
 * little context remained: the documented MiniMax shape (thinking eats the clamped
 * budget and an empty message comes back looking complete), and the standard shape on
 * OpenAI-wire endpoints. Such a response is not an answer; it is a symptom of a
 * request that no longer fits.
 *
 * The reference is the cap we *intended* — what this code sends as `max_tokens` —
 * which for this codebase is always `provider.maxTokens`, never a clamped value.
 */
export function isTruncatedByContext(
  response: { stop_reason: string | null; usage: { output_tokens: number } },
  intendedMaxOutput: number
): boolean {
  if (response.stop_reason !== "max_tokens") return false;
  if (intendedMaxOutput <= 0) return false;
  return response.usage.output_tokens < intendedMaxOutput - GENUINE_CAP_MARGIN_TOKENS;
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
/**
 * Transcript entries replayed into a new turn's context. A backstop, not a budget:
 * tokens are the scarce resource and compaction's token trigger governs. 400, up
 * from 60 (docs/23) — at 60, one computer-use turn (two entries per round, four
 * hundred rounds allowed *within* a turn) could exceed the cap that the *next*
 * turn's replay was held to, which is why compaction's entry trigger had to sit at
 * 50 and fired constantly. The cap exists only so a pathological entry flood cannot
 * assemble an unbounded request behind the token estimator's back.
 */
const HISTORY_LIMIT = envNumber("AGENTBOX_HISTORY_LIMIT", 400);

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
  /** The door out of the box, when an operator built one. Absent means no host tool. */
  hostRunner?: HostRunner;
  /** The credential vault, for secrets a host command asks for by grant. */
  vault?: Vault;
  /** The team's task board. Absent means no Tasks tool behaviour and no tasks section. */
  tasks?: TaskStore;
  /** The scopes registry, for an agent placed in a scope. Absent means no scoping. */
  scopes?: ScopeStore;
  /** MCP servers whose tools this turn may offer and call. Absent means none. */
  mcp?: McpManager;
  /** Puts a question to whoever drove this agent. Absent means there is nobody to ask. */
  askUser?: ToolContext["askUser"];
  /**
   * Reads Feishu documents with the bot's own workspace identity. Absent means the
   * installation has no Feishu app configured and the tool is withheld entirely.
   */
  docReader?: ToolContext["docReader"];
  /**
   * Which conversation this turn runs in. Absent means the main one — the team room.
   * The transcript read, every entry written, the compaction state and every event
   * emitted belong to this conversation and no other.
   */
  conversation?: string;
  /**
   * Asks a cheap model which memories matter for this message.
   *
   * Only consulted when the budget forces a choice. Absent means the scoring decides, which is what
   * happened before this existed and what still happens whenever everything fits.
   */
  selectMemory?: (prompt: string) => Promise<string | undefined>;
  /**
   * The per-call classifier for calls that bind the world (auto-review.ts). Absent means no
   * review, which is what every turn had before; `mode()` decides whether a BLOCK is enforced.
   */
  autoReview?: { mode(): ReviewMode; review(input: ReviewInput): Promise<Verdict> };
  /** Records which agent wrote into a skill. Absent means no record is kept. */
  skillProvenance?: ToolContext["skillProvenance"];
  /** The template this turn installs, when it is an imported bot's setup turn (docs/29). */
  templateSetup?: string;
  /** Where a packed template is staged; absent withholds PackTemplate. */
  templates?: ToolContext["templates"];
  /** Lifecycle hooks in Claude Code's dialect (hooks.ts). Absent means none are configured. */
  hooks?: HookRunner;
  resolution: ResolutionConfig | undefined;
  /**
   * What kind of box this is (docs/18). Absent means the caller did not classify it and
   * the prompt says nothing, which is the right silence: a wrong claim about who can see
   * this screen is worse than no claim.
   */
  boxAccess?: BoxClass;
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
  resumeOf?: { id: string; attempt: number; workId?: string };
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

/**
 * Which conversation an event belongs to, stamped onto every turn event by the
 * emit wrapper in runTurn — one field on the union rather than repeated in each
 * variant, because every event of a turn belongs to that turn's conversation.
 */
export type TurnEvent = TurnEventBody & { conversation?: string };

type TurnEventBody =
  | { type: "text"; agentId: string; agentName: string; delta: string }
  /**
   * The model's opening line on a person-opened turn, said alongside its first tool calls
   * (docs/31 layer 1a). Delivered to the chat at once so the person sees the acknowledgement
   * while the tools run; not part of the final reply, which `replySince` still assembles
   * from plain entries only. Once per turn.
   */
  | { type: "interim"; agentId: string; agentName: string; text: string }
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
   * The turn stopped because it was going in circles, not because it finished.
   *
   * Its own event because the *turn* ending here is an outcome rather than a failure —
   * the agent was told why it stopped, and the report is in its transcript — while for
   * anyone watching from outside it is neither done nor broken but *waiting for a
   * person*. A surface that cannot tell those apart shows a green tick over abandoned
   * work, which is the one thing a board must never do.
   */
  | { type: "stuck"; agentId: string; reason: string }
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
      /** Verbatim survivors of the summarised range — see compaction.ts SummaryEntry. */
      pinned?: HistoryEntry[];
      at: string;
    };

/** Tool-result text kept in replayed history. Enough to be evidence, not bulky. */
/** Shared with the box, which spills to a file before this cut loses anything. */
const REPLAYED_RESULT_LIMIT = DURABLE_RESULT_CHARS;

/**
 * Strips a tool result down for storage.
 *
 * Images are dropped: a turn of computer use would otherwise put a megabyte of
 * screenshots into every later request, and without compaction that ends the
 * conversation. The text stays, so the model still sees that it looked and what
 * it was told.
 */
export function storableResult(
  block: Anthropic.ToolResultBlockParam,
  /**
   * What to store instead, when a tool said the record and the model must see different
   * things. Only `RunOnHost` with vault secrets does — see `ToolOutcome.recordAs`.
   */
  recordAs?: string
): Anthropic.ToolResultBlockParam {
  if (recordAs !== undefined) {
    // Not truncated and not scanned for a spill pointer: this text was written to be
    // stored, and it is already short.
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: [{ type: "text", text: recordAs }],
      ...(block.is_error === true ? { is_error: true } : {}),
    };
  }
  // The wire type allows plain-string content as well as a block array. Every producer
  // in this repository builds the array form today, but a future MCP server or plugin
  // handing back a string would have been silently stored as "(no output)" — the one
  // wrong record that later reads as the tool having said nothing.
  const content = Array.isArray(block.content)
    ? block.content
    : typeof block.content === "string"
      ? [{ type: "text" as const, text: block.content }]
      : [];
  const texts = content
    .filter((part): part is Anthropic.TextBlockParam => part.type === "text")
    .map(part => part.text);
  const imageCount = content.filter(part => part.type === "image").length;

  const whole = texts.join("\n");
  let text = whole.slice(0, REPLAYED_RESULT_LIMIT);
  // A pointer that survives one truncation and not the next points at nothing.
  //
  // The box appends "the full output is at <path>" to the end of an over-long result;
  // this cut takes the head, so on exactly the results where the pointer matters most
  // — the big ones — it was the first thing lost. Carried across explicitly, which is
  // what lets a later ReadHistory walk from a 2,000-character remnant to the whole
  // file. Trimming is not the same as losing, but only if the trail is kept.
  if (whole.length > text.length) {
    const pointer = whole.slice(text.length).match(/\[[^\]]*full output kept:[^\]]*\]/);
    if (pointer !== null) text += `\n${pointer[0]}`;
  }
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
/** One guard per process: pauses are per conversation inside it. */
const compactionGuard = new CompactionGuard();

/**
 * Bills a model call that is not the agent thinking.
 *
 * A closure rather than the ledger itself, because the three calls this covers know their model
 * and their tokens and nothing about which agent, which work or which conversation they belong
 * to — and threading four more parameters through the compaction path to tell them would be
 * four chances to pass the wrong one.
 */
export type Meter = (
  kind: UsageKind,
  profile: ProviderProfile,
  usage: Anthropic.Message["usage"]
) => void;

/** Produces one summary of the given entries, or undefined when the model would not cooperate. */
async function summarise(
  entries: readonly HistoryEntry[],
  covers: number,
  client: Anthropic,
  summaryProvider: ProviderProfile,
  meter?: Meter
): Promise<SummaryEntry | undefined> {
  const ask = async (extra?: string): Promise<string> => {
    const response = await client.messages.create({
      model: summaryProvider.model,
      // Enough for a dense summary and no more; a summary that runs to pages defeats the purpose.
      max_tokens: Math.min(4096, summaryProvider.maxTokens),
      messages: [
        { role: "user", content: buildSummaryPrompt(entries) + (extra ?? "") },
      ],
    });
    meter?.("summarize", summaryProvider, response.usage);
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();
  };

  let text = await ask();
  // The four headings were a request; this is the check (docs/24 v3 P0 #3), tuned by
  // Grok round 3 for the production model: MiniMax writes `## Threads` or Chinese
  // heading dialects, and a strict English-bold check would retry — and pay a full
  // second history pass — on *every* compaction. The check is tolerant (any casing,
  // ## or bold or bare-colon), and the retry fires only when the draft is genuinely
  // shapeless: fewer than two of the four sections recognisable. A still-flawed
  // second answer is accepted with a loud log — the mechanical anchors and pinned
  // entries carry the exact facts either way, and a flawed narrative beats a
  // dropped-history marker.
  if (text !== "" && missingSummaryHeadings(text).length > 2) {
    const missing = missingSummaryHeadings(text).join(", ");
    console.error(`[compaction] summary is shapeless (missing ${missing}); asking once more`);
    const retry = await ask(
      `\n\nYour previous attempt was missing the required heading(s): ${missing}. ` +
        `Produce the summary again with all four headings present.`
    );
    if (retry !== "") text = retry;
  }
  if (!text) return undefined;
  // The word cap is measured, not merely requested: an unbounded narrative is the
  // compounding-summary failure shape. Twice the cap allows headings and anchors room.
  const words = text.split(/\s+/);
  if (words.length > SUMMARY_WORD_CAP * 2) {
    text = `${words.slice(0, SUMMARY_WORD_CAP * 2).join(" ")}\n[summary truncated at the mechanical cap]`;
  }

  // Exact strings, harvested from the full blocks before any rendering clip and
  // appended outside the model's output — a model paraphrases, a regex does not.
  const anchors = extractAnchors(entries);
  if (anchors.length > 0) {
    text += `\n\n**Exact references (mechanically extracted — trust these over the prose above):**\n${anchors.join("\n")}`;
  }
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
  conversation: string;
  meter?: Meter;
}): Promise<TranscriptEntry[]> {
  const { history, agent, registry, client, provider, log, onCompacted, conversation, meter } = options;
  // Speculative summaries are per conversation: each thread compacts its own history,
  // and a summary prepared for the team room must never be adopted by a Telegram chat.
  const summaryKey = `${agent.id}/${conversation}`;
  const active = activeWindow(history as HistoryEntry[]);
  // Derived from the model's real window once one response has reported it, so the same code is
  // right for a 200k model and a 1M one.
  const policy = policyForModel(provider.model);
  const urgency = compactionUrgency(active, policy);
  if (urgency === "none") {
    pendingSummaries.delete(summaryKey);
    return history;
  }

  // Forced when pre-computing: in the background band the total is still under the trigger, so the
  // ordinary gate would refuse to name a cut and nothing would ever be prepared.
  const cut = chooseCutPoint(active, policy, { force: urgency === "background" });
  if (!cut) return history;
  const olderEntries = active.slice(0, cut.index);
  // Profile and client resolved together (docs/24 v3 P0 #6): a summary provider that
  // names another endpoint gets its own client instead of riding the primary's wire.
  // Inside a guard (verification review): a misconfigured split must degrade to the
  // agent's own wire, not abort the turn before compaction even starts.
  let summaryRuntime: { client: Anthropic; profile: ProviderProfile };
  try {
    summaryRuntime = summaryRuntimeFor(provider, client);
  } catch (error) {
    log(
      `summary provider unusable (${error instanceof Error ? error.message : String(error)}); ` +
        `summarising on the agent's own wire`
    );
    summaryRuntime = { client, profile: provider };
  }
  const summaryProvider = summaryRuntime.profile;

  if (urgency === "background") {
    // Start it and walk away. Nothing here is awaited, and a failure is swallowed on purpose: this
    // is speculative work, and the `now` path will report properly if it ever becomes necessary.
    //
    // Replaced when stale, not merely absent (docs/24 v3 P0 #4): a `has` check froze the
    // first 75%-band summary forever — the history marched on to 99% while the pending
    // still described the world at 75%, and adoption then kept an unbounded tail.
    const existing = pendingSummaries.get(summaryKey);
    if (
      existing === undefined ||
      !pendingIsUsable(existing, active, policy) ||
      pendingHasDrifted(existing, active, policy)
    ) {
      log(
        `pre-summarising ${cut.index} entries in the background on ${summaryProvider.model}; ` +
          `this turn proceeds uncompacted`
      );
      pendingSummaries.set(summaryKey, {
        covers: cut.index,
        computedFrom: active.length,
        promise: summarise(olderEntries, cut.index, summaryRuntime.client, summaryProvider, meter).catch(() => undefined),
      });
    }
    return history;
  }

  // The anti-thrash gate (docs/24 P1 #8): a paused conversation sends uncompacted —
  // the trigger sits 35% below the window, so the request still fits, and a pause is
  // the honest response to "summarising demonstrably does not help here".
  if (!compactionGuard.allowed(summaryKey)) {
    log(
      `compaction paused for this conversation ` +
        `(${Math.ceil(compactionGuard.pausedForMs(summaryKey) / 60_000)}m left): ` +
        `recent passes failed or did not clear the trigger`
    );
    return history;
  }

  log(`compacting history: ${cut.reason}`);

  let entry: SummaryEntry;
  try {
    const pending = pendingSummaries.get(summaryKey);
    let ready: SummaryEntry | undefined;
    if (pendingIsUsable(pending, active, policy)) {
      ready = await pending!.promise;
      if (ready !== undefined) {
        log(`used the summary prepared in the background (${pending!.covers} entries)`);
      }
    }
    let produced = ready;
    if (produced === undefined) {
      try {
        produced = await summarise(olderEntries, cut.index, summaryRuntime.client, summaryProvider, meter);
      } catch (error) {
        // The agent's own wire before a dropped-history marker (verification review):
        // a failing split provider is a configuration problem, and losing history to
        // it would charge the user for somebody's env var.
        if (summaryRuntime.client === client) throw error;
        log(
          `summary provider failed (${error instanceof Error ? error.message : String(error)}); ` +
            `retrying on the agent's own wire`
        );
        produced = await summarise(olderEntries, cut.index, client, provider, meter);
      }
    }
    if (produced === undefined) throw new Error("the summariser returned no text");
    entry = produced;
    // Pinned survivors are chosen against the *adopted* coverage, not the fresh cut
    // (verification review, finding 1): an adopted pending may cover fewer entries
    // than the cut just computed, and the assembled tail is active.slice(covers) —
    // choosing pins against the fresh cut's tail let a pair between the two land in
    // the request twice, with duplicate tool_use ids the API rejects.
    const pinnedEntries = choosePinnedEntries(
      active.slice(0, entry.covers),
      active.slice(entry.covers)
    );
    if (pinnedEntries.length > 0) entry = { ...entry, pinned: pinnedEntries };
    // And the adopted result must actually fit: summary + pins + real tail under the
    // trigger, or pins are shed first and a still-oversized adoption is refused in
    // favour of the fresh cut.
    if (estimateTokens([entry, ...active.slice(entry.covers)]) > policy.triggerTokens) {
      const bare = { ...entry };
      delete (bare as { pinned?: unknown }).pinned;
      if (
        entry.covers !== cut.index &&
        estimateTokens([bare, ...active.slice(entry.covers)]) > policy.triggerTokens
      ) {
        log("the prepared summary no longer bounds the request; summarising the current cut instead");
        const fresh = await summarise(olderEntries, cut.index, summaryRuntime.client, summaryProvider, meter);
        if (fresh === undefined) throw new Error("the summariser returned no text");
        entry = fresh;
        const freshPins = choosePinnedEntries(active.slice(0, entry.covers), active.slice(entry.covers));
        if (freshPins.length > 0) entry = { ...entry, pinned: freshPins };
      } else {
        entry = bare as typeof entry;
      }
    }
    const detail =
      `summarised ${entry.covers} entries: about ${estimateTokens(olderEntries)} tokens ` +
      `became ${estimateTokens([entry])}` +
      (ready === undefined ? "" : " (prepared in the background)");
    log(detail);
    onCompacted({ type: "compacted", covers: entry.covers, summarised: true, detail });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A refusing summariser buys a cooldown: asking again in ten seconds costs money
    // and delays the turn for the same answer.
    compactionGuard.noteFailure(summaryKey);
    // Loud, and told to the model: the alternative was a request that cannot fit, and the
    // alternative to that was dropping history with no trace of it having happened.
    entry = droppedEntry(cut.index, reason);
    // Insurance matters *more* when the summary failed: the dropped marker carries the
    // pinned ask and tool exemplars even though it carries no narrative.
    const pinnedEntries = choosePinnedEntries(olderEntries, active.slice(cut.index));
    if (pinnedEntries.length > 0) entry = { ...entry, pinned: pinnedEntries };
    const detail = `could not summarise (${reason}); dropped ${cut.index} entries instead`;
    log(detail);
    onCompacted({ type: "compacted", covers: cut.index, summarised: false, detail });
  } finally {
    // Consumed either way: a summary that was adopted must not be adopted twice, and one that
    // failed must not be retried forever.
    pendingSummaries.delete(summaryKey);
  }

  registry.appendTranscript(agent.id, entry, conversation);
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
  // Declared here, used at the bottom: consecutive same-role messages are merged into
  // one content array (Grok round 3: the summary, a pinned ask, pinned results and a
  // tail user message can land adjacent, and the Anthropic wire rejects consecutive
  // user roles — one message holding text and tool_result blocks together is legal on
  // both wires, so merging is the shape-safe answer for every junction at once).
  const mergeAdjacent = (list: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
    const merged: Anthropic.MessageParam[] = [];
    for (const message of list) {
      const previous = merged[merged.length - 1];
      if (previous === undefined || previous.role !== message.role) {
        merged.push(message);
        continue;
      }
      const blocksOf = (m: Anthropic.MessageParam): Anthropic.ContentBlockParam[] =>
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content as Anthropic.ContentBlockParam[]);
      merged[merged.length - 1] = {
        role: previous.role,
        content: [...blocksOf(previous), ...blocksOf(message)],
      };
    }
    return merged;
  };
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
        // The verbatim survivors ride between summary and tail: the pinned ask, and
        // one successful call/result pair per tool the tail no longer demonstrates —
        // the in-context examples a weak model imitates schemas from (docs/24 v3).
        for (const kept of entry.pinned ?? []) {
          if (!("kind" in kept)) {
            if (kept.text.trim() !== "") messages.push({ role: kept.role, content: kept.text });
          } else if (kept.kind === "blocks" || kept.kind === "results") {
            if (kept.blocks.length > 0) messages.push({ role: kept.role, content: kept.blocks });
          }
        }
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
  return mergeAdjacent(repairPairs(messages));
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
  const conversation = deps.conversation ?? MAIN_CONVERSATION;
  // Every event names its conversation, so a page viewing one thread can ignore the
  // stream of another instead of splicing an outside chat's reply into the team room.
  const baseEmit = deps.onEvent ?? (() => {});
  const emit: typeof baseEmit = event => baseEmit({ ...event, conversation });
  const provider = deps.provider ?? FULL_CLAUDE;

  // Recorded before anything else, so a process that dies at any point after this leaves a begin
  // with no end — a fact, rather than a turn that simply stopped existing.
  const turnId = randomUUID();
  // The turn is the attempt; the work is what the attempts are attempts at. A resumption
  // inherits rather than mints, which is the whole point of the field: without it a turn that
  // resumed twice appears in every report as three unrelated short turns.
  const workId = deps.resumeOf?.workId ?? randomUUID();
  // Built once, here, because this is the only place that knows all four of the things an aside
  // has to be attributed to. Passing the ledger down instead would mean passing the agent, the
  // work and the conversation down with it, which is three more chances to pass the wrong one.
  const meter: Meter = (kind, profile, usage) =>
    deps.usage?.recordAside({
      kind,
      agentId: agent.id,
      agentName: agent.profile.name,
      provider: profile.label,
      model: profile.model,
      usage,
      workId,
      conversation,
      // The same principal the turn's own rows carry: summarising a person's conversation
      // is that person's cost, and billing it to nobody made per-principal totals read low.
      ...(deps.caller?.userId !== undefined ? { principal: deps.caller.userId } : {}),
    });
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
      transcript: registry.readTranscript(agent.id, conversation),
      // Read fresh, which is what makes the plan and the todo list survive a compaction: they are in
      // the prompt rather than in the history a summary replaces.
      durable: registry.readDurableState(agent.id, conversation),
      tasks: deps.tasks?.forAgent(agent.id),
      resolution: deps.resolution,
      ...(deps.boxAccess !== undefined ? { boxAccess: deps.boxAccess } : {}),
      agentsRoot: registry.root,
      hasBox: box !== undefined,
      vision: provider.vision,
      conversation,
      siblingConversations: registry
        .listConversations(agent.id)
        .filter(entry => entry.id !== conversation).length,
    });
  const promptParts = buildParts(memoryRecall);

  // A section that rendered nothing for a suspicious reason says so, once, into the log.
  // Every context bug this week arrived as an absence — a history read from the wrong
  // conversation, a task naming one that did not exist, a directory nobody created — and
  // an absence is indistinguishable from "nothing to say" unless something checks.
  for (const fault of emptySectionFaults({
    agent,
    teammates: registry.list(),
    memory: [],
    agentsRoot: registry.root,
    hasBox: box !== undefined,
    conversation,
    siblingConversations: registry
      .listConversations(agent.id)
      .filter(entry => entry.id !== conversation).length,
  })) {
    console.error(`[context] ${agent.profile.name}: ${fault}`);
  }

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

  let history = registry.readTranscript(agent.id, conversation) as TranscriptEntry[];

  // A resumed turn re-executes the safe half of an interrupted tool batch instead of
  // guessing at it. The trailing assistant entry's tool_use blocks are the durable
  // record of what was asked — nothing here mutates arguments, so the block *is* the
  // call — and a read-only call answered fresh beats a result declared unknown.
  // Everything not declared safe keeps the honest "never recorded" treatment at
  // assembly, and the model is still told to look before redoing those.
  if (deps.resumeOf !== undefined && history.length > 0) {
    const last = history[history.length - 1]!;
    if ("kind" in last && last.kind === "blocks") {
      const calls = last.blocks.filter(
        (block): block is Anthropic.ToolUseBlockParam =>
          (block as { type?: string }).type === "tool_use"
      );
      const replayed: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (!safeToReplay(call.name, input)) continue;
        // Policy is deliberately not re-consulted: the block's presence in the
        // transcript is the record that the original call already passed the gate.
        const outcome = await dispatchTool(call.name, input, {
          agent,
          registry,
          bus,
          box,
          files: deps.files,
          claims: deps.claims,
          caller: deps.caller,
          displayIndex: deps.displayIndex,
          boxOwner: deps.boxOwner,
          tasks: deps.tasks,
          turnId,
          conversation,
        });
        replayed.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: [
            {
              type: "text",
              text:
                "[Re-run on resume: this read-only call was interrupted before its result " +
                `was recorded.]\n\n${outcome.text}`,
            },
          ],
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      if (replayed.length > 0) {
        const entry = {
          role: "user",
          kind: "results",
          blocks: replayed,
          at: new Date().toISOString(),
        } satisfies TranscriptEntry;
        registry.appendTranscript(agent.id, entry, conversation);
        history = [...history, entry];
      }
    }
  }

  const turnText = buildTurnPrompt(inbound);

  // Before assembling: a conversation that has grown past what fits is summarised, once, and the
  // summary is persisted so later turns pay nothing. Measured on this system at 158KB and 40k
  // tokens after a day — the end of that road is a turn failing on a request that cannot be made
  // smaller, at the worst possible moment.
  if (deps.hooks?.has("PreCompact")) {
    await deps.hooks.run("PreCompact", { session_id: turnId, agent_name: agent.profile.name, trigger: "auto" });
  }
  history = await compactHistory({
    history,
    agent,
    registry,
    client,
    provider,
    log: line => console.error(`[compaction] ${agent.profile.name}: ${line}`),
    onCompacted: event => emit({ ...event, agentId: agent.id }),
    conversation,
    meter,
  });

  // The per-turn reminder rides the API copy of the person's message only (docs/31 layer
  // 2b): the transcript keeps what the person said, and a later replay re-appends nothing.
  const opener = inbound.some(message => message.fromId === "user")
    ? turnReminderFor(provider.model, turnText)
    : undefined;
  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(history),
    { role: "user", content: opener === undefined ? turnText : `${turnText}\n\n${opener}` },
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
  } satisfies TranscriptEntry, conversation);

  // Narrowed by this agent's profile. Withheld, not refused: a tool it may not use is not in its
  // prompt at all.
  // An agent in a scope is defined by it: the scope's tool list replaces the profile's.
  const scope = deps.scopes?.get(agent.profile.scopeId);
  // A chat bound to a scope narrows every turn it drives — an intersection with the
  // agent's own tools, never a replacement: the room's authority bounds the work, it
  // does not hand an agent tools its own definition withheld.
  const chatScope =
    conversation === MAIN_CONVERSATION
      ? undefined
      : deps.scopes?.boundTo(conversation, conversationIdFor);
  const narrowed = narrowTools(scope?.tools ?? agent.profile.tools, chatScope?.tools);
  // A template setup turn holds files and memory and a way to ask, nothing that reaches out
  // (docs/29 §5.3): the recipe it is installing is third-party text, and installing yourself
  // is not a reason to message anyone. Withheld, not refused, like every other narrowing.
  const effectiveTools =
    deps.templateSetup === undefined
      ? narrowed
      : TEMPLATE_SETUP_TOOLS.filter(tool => narrowed === undefined || narrowed.includes(tool));
  // The tools other people wrote, narrowed by the same allowlist as ours: an MCP tool
  // is an ordinary tool once it arrives, including in what an agent's profile and its
  // scope are allowed to withhold.
  const allowedMcp = (deps.templateSetup !== undefined ? [] : (deps.mcp?.tools() ?? [])).filter(
    tool => effectiveTools === undefined || effectiveTools.includes(tool.name)
  );
  // Past a certain number they stop being a list and start being a document that every
  // turn pays for. Then they go behind a lookup pair instead: one round trip when an
  // external tool is actually wanted, nothing when it is not.
  const mcpTools: Anthropic.Tool[] =
    allowedMcp.length > TOOL_BUDGET_WARNING
      ? [
          {
            name: "FindMcpTool",
            description:
              `${allowedMcp.length} tools from connected external services are available, too ` +
              "many to list in full here. Search them with this, then call one with " +
              "`UseMcpTool`. No arguments lists every service and its tools with a one-line " +
              "description each; `pattern` filters by substring; `server` narrows to one " +
              "service; `tool` returns that one tool's full description and input schema, " +
              "which is what you need before calling it.",
            input_schema: {
              type: "object",
              properties: {
                pattern: { type: "string", description: "Substring to look for." },
                server: { type: "string", description: "Only this service's tools." },
                tool: { type: "string", description: "One tool's full detail, by exact name." },
              },
            },
          },
          {
            name: "UseMcpTool",
            description:
              "Call one of the external tools found with `FindMcpTool`. Look the tool up " +
              "first — its input schema is not shown here, and guessing the arguments wastes " +
              "the call.",
            input_schema: {
              type: "object",
              properties: {
                tool: { type: "string", description: "The exact tool name, as `service__tool`." },
                arguments: { type: "object", description: "Its arguments, per its schema." },
              },
              required: ["tool"],
            },
          },
        ]
      : allowedMcp.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
        }));

  const tools = buildTools(
    box !== undefined,
    provider.vision,
    effectiveTools,
    deps.hostRunner?.enabled === true,
    // The desktop is offered only in the main conversation: an agent has one screen,
    // the operator is watching the team room's, and a side chat driving it would fight
    // for pixels with the room. Side conversations keep shell, files and the rest and
    // do their work headless — which is what lets them run at the same time as the room.
    conversation === MAIN_CONVERSATION,
    deps.docReader !== undefined,
    deps.templates !== undefined
  ).concat(mcpTools);

  // One entry per completed round, for the loop and progress judgements. Held out here rather than
  // inside runRounds so a continuation can reset it: a fresh budget deserves a fresh judgement.
  const rounds: RoundRecord[] = [];
  // Whether the person has already been handed the model's opening line this turn (docs/31
  // layer 1a). Turn-scoped, not round-scoped: a continuation restarts the round count and
  // must not greet them twice.
  let interimDelivered = false;
  const personOpened = inbound.some(message => message.fromId === "user");
  // How many tool calls this turn has made, across continuations: the structural signal the
  // guards read (docs/31 layer 1e). A ruling reached with this at zero is a ruling from memory.
  let toolCallsInTurn = 0;
  // Guard bookkeeping: how many times the model was sent back, whether a send-back is
  // awaiting its answer (so the answer can be logged as complied or not), and whether the
  // closing nudge has been spent.
  let guardNudges = 0;
  let guardPending: GuardReason | undefined;
  let closingNudged = false;
  const chinese = readsAsChinese(inbound.map(message => message.text).join("\n"));

  // The ledger opens here, not during setup. Its job is to record that a turn was *executing* — a
  // model call, a tool — when the process died, so the next startup resumes it. Everything above is
  // assembly that ran nothing; a death there loses no work (the accepted message is still in the
  // inbox) and would otherwise have left an open ledger that read a setup failure as an interrupted
  // turn and resumed one that had already reported failing.
  deps.turns?.begin({
    id: turnId,
    agentId: agent.id,
    about: inbound.map(message => message.text).join(" / "),
    workId,
    ...(conversation !== MAIN_CONVERSATION ? { conversation } : {}),
    ...(deps.resumeOf !== undefined
      ? { resumeOf: deps.resumeOf.id, attempt: deps.resumeOf.attempt }
      : {}),
    // Which model, which build, which prompt (R24). The hash covers the prompt as assembled
    // for round one; the volatile half is rebuilt on continuation, and that rewrite is the
    // same code with newer state, not a different prompt.
    model: provider.model,
    build: buildInfo(),
    promptHash: promptHashOf(promptParts.stable, promptParts.volatile),
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
      } satisfies TranscriptEntry, conversation);

      // Reassembled from the transcript, and compacted on the way, which is what the comment above
      // has always claimed and what the code did not do: a continuation used to push one more
      // message onto the array the previous four hundred rounds had built. So the turn that most
      // needs room — one still working after four hundred rounds — was the only one that never got
      // any, and proactive compaction could not help because it had already run, once, before the
      // first round.
      //
      // Everything a completed round produced is on disk by now, so re-reading loses nothing; and
      // an orphaned call left by the round limit is paired up during assembly.
      if (deps.hooks?.has("PreCompact")) {
    await deps.hooks.run("PreCompact", { session_id: turnId, agent_name: agent.profile.name, trigger: "auto" });
  }
  history = await compactHistory({
        history: registry.readTranscript(agent.id, conversation) as TranscriptEntry[],
        agent,
        registry,
        client,
        provider,
        log: line => console.error(`[compaction] ${agent.profile.name}: ${line}`),
        onCompacted: event => emit({ ...event, agentId: agent.id }),
        conversation,
        meter,
      });
      // In place: `runRounds` closes over this array.
      messages.length = 0;
      messages.push(...historyToMessages(history));

      // Rebuild the volatile system block from disk too. The durable blocks — plan, todos — are the
      // whole point of surviving compaction, and an agent updates them *mid-turn*: it marks a todo
      // done in round five, and a continuation compacts that tool result away while the system block,
      // built once at turn start, still says the todo is pending. The stable half is unchanged, so
      // only system[1] is rewritten. Memory keeps the selection made at turn start: the selector
      // chose against *this* request and the choice is still right for its continuation, while
      // re-running a plain score-based recall here quietly threw that choice away (audit 2026-09-01
      // #6). A fact remembered mid-turn reaches the next turn, not this one — the same freeze Grok
      // Bot applies per compaction epoch, and the reason the memory block stays byte-stable.
      system[1] = { type: "text", text: buildParts(memoryRecall).volatile, ...cache };

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
    deps.display?.releaseAll(agent.id);
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
  // The incompressible-floor warning fires once per turn, not once per round.
  let floorWarned = false;
  // Set once a Stop hook has sent the model back, so it can do so at most once per turn.
  let stopHookActive = false;
  // True while the model is finishing: its last round made no tool calls and only a Stop hook
  // kept the loop going. Steering is not taken then (R8) — a user message injected on a loop
  // about to stop is a dangling turn the model never really answers; left queued, it opens
  // the next turn with the whole of the model's attention instead.
  let finishing = false;
  // A one-round demand that the next response contain a tool call (docs/31 layer 1d/1e):
  // set by a guard, spent by the next request, never carried further.
  let forceTools: Anthropic.MessageCreateParams["tool_choice"] | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) {
      emit({ type: "aborted", agentId: agent.id });
      throw new TurnAborted();
    }

    // Steering: what the user said while this turn was running, consumed at the round
    // boundary instead of waiting for the whole turn to end. "Actually, also change
    // the title" lands in the next request, mid-task, with all the work so far intact
    // — the alternative was minutes of latency or an interrupt that threw the work
    // away. Only the user's own messages steer: a teammate's message is new work that
    // deserves its own turn and its own causal record, and that behaviour is pinned
    // by the race catalog. Appended at the tail, which keeps the provider's prefix
    // cache warm — the same reason compaction is the only mid-turn rewrite.
    const steered = finishing ? [] : deps.bus.takeSteering(agent.id, conversation);
    if (steered.length > 0) {
      const steerText = buildTurnPrompt(steered);
      registry.appendTranscript(agent.id, {
        role: "user",
        text: steerText,
        at: new Date().toISOString(),
        causedBy: steered.map(message => message.id),
      } satisfies TranscriptEntry, conversation);
      messages.push({ role: "user", content: steerText });
    }
    // Asked before spending anything. A stop or an exhausted budget ends the turn here, at a round
    // boundary, where the transcript is consistent — aborting mid-request would leave a call with no
    // result, which is a shape the next turn cannot replay.
    const permitted = deps.policy?.check({
      kind: "model-call",
      agentId: agent.id,
      agentName: agent.profile.name,
      round,
      ...(deps.caller?.userId !== undefined ? { principalId: deps.caller.userId } : {}),
    });
    if (permitted !== undefined && !permitted.allow) {
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: permitted.reason,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry, conversation);
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
    //
    // The whole request, not the history alone (docs/24 v3 P0 #5): the system prompt and
    // tool schemas were invisible to every earlier estimate, so an incompressible floor
    // produced rejected requests that no compaction could have prevented — and nothing
    // said so. The estimate is calibrated by what this wire actually billed last time.
    let requestEstimate = estimateRequestTokens({ messages, system, tools });
    const wire = `${provider.label}|${provider.baseUrl ?? ""}`;
    const estimated = calibratedTokens(wire, requestEstimate.total);
    // Said once per turn whether or not it is a problem: the prompt's size was invisible
    // until it was fatal, and a number nobody sees is a number nobody budgets. Grok Bot
    // treats prompt bytes as a product decision (a slim-prompt A/B, a flag that removes
    // 3.3K duplicated tokens); the first step towards that here is being able to read it.
    if (round === 0) {
      console.error(
        `[prompt] ${agent.profile.name}: system+tools ≈ ${calibratedTokens(wire, requestEstimate.floor)} ` +
          `tokens, whole request ≈ ${estimated} (${tools.length} tools)`
      );
    }
    // The floor is compared calibrated too (verification review): an uncalibrated
    // floor on a CJK-heavy prompt under-warns exactly where the warning matters.
    if (
      !floorWarned &&
      calibratedTokens(wire, requestEstimate.floor) > policyForModel(provider.model).triggerTokens
    ) {
      floorWarned = true;
      console.error(
        `[compaction] ${agent.profile.name}: the system prompt and tools alone are about ` +
          `${calibratedTokens(wire, requestEstimate.floor)} tokens — over the compaction ` +
          `trigger. Compaction cannot shrink this request; fewer tools or a shorter prompt ` +
          `is the fix.`
      );
    }
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
        // The estimate must describe the payload actually sent (verification review):
        // calibrating the wire against a pre-prune figure taught the factor that
        // requests are cheaper than they are, and every later estimate inherited it.
        requestEstimate = estimateRequestTokens({ messages, system, tools });
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
        ...(forceTools !== undefined ? { tool_choice: forceTools } : {}),
      },
      { signal: attemptControl.signal }
    );
    forceTools = undefined;

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
    // Teach the estimator what this wire actually billed for the request we just
    // estimated — the calibration loop of docs/24 v3 P0 #5.
    {
      // Every billed input class: a cached prefix is still input the estimate predicted.
      const usage = response.usage as {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const realInput =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      noteRealInputTokens(
        `${provider.label}|${provider.baseUrl ?? ""}`,
        requestEstimate.total,
        realInput > 0 ? realInput : undefined
      );
    }
    deps.usage?.record({
      agentId: agent.id,
      agentName: agent.profile.name,
      // What a report groups by. `turnId` would be the obvious key and is the wrong one: it
      // is minted per attempt, so it splits one long piece of work into several short ones.
      workId,
      // The board writes this id against every change an agent makes to a task, so it is
      // the join that answers "what did t51 cost".
      turnId,
      // Already in scope for the event stream, and free here. It does not attribute a task —
      // a task spans conversations and a conversation spans tasks — but it does make a fork
      // child costable, which is the case an estimate cares about most.
      conversation,
      // Who this spend is on behalf of. Absent when no person drove it — a wake, a
      // scheduled run — which is exactly what byPrincipalSince groups separately.
      ...(deps.caller?.userId !== undefined ? { principal: deps.caller.userId } : {}),
      // Recorded from what was actually used, with a fallback rather than an optional field: a
      // usage record whose model is missing cannot be priced later.
      provider: deps.provider?.label ?? "unknown",
      model: deps.provider?.model ?? "unknown",
      round,
      ...usage,
    });

    // A response the context squeezed rather than finished. Discarded, never
    // appended: a tool call cut mid-JSON is not evidence of anything, and an answer
    // cut mid-sentence would be continued as though it were finished. Its cost is
    // already on the books — the usage record above is written before this
    // classification *on purpose*: spend must not vanish with a response we chose to
    // throw away. Shed and retry under the same bounded counter as a rejected
    // request; when nothing further can shed, the truncated response is kept, because
    // degraded is better than dead and the truncation is at least visible.
    if (isTruncatedByContext(response, provider.maxTokens) && shed < MAX_SHED_ATTEMPTS) {
      shed += 1;
      const relief = shedForRetry(messages, "context-window");
      console.error(
        `[compaction] ${agent.profile.name}: response truncated by context ` +
          `(${usage.outputTokens} of ${provider.maxTokens} output tokens); ${relief.detail}; ` +
          `retrying round ${round}`
      );
      if (relief.dropped > 0) {
        // The watcher may have rendered the truncated stream; this is what tells the
        // page to drop it, exactly as a connection retry does.
        emit({
          type: "retrying",
          agentId: agent.id,
          round,
          attempt: shed,
          delayMs: 0,
          kind: "truncated",
          discardPartial: outputProduced,
          detail:
            `the response was cut off by context pressure (${usage.outputTokens} of ` +
            `${provider.maxTokens} output tokens); ${relief.detail}`,
        });
        round -= 1; // retry this round rather than consuming one
        continue;
      }
      console.error(
        `[compaction] ${agent.profile.name}: nothing further can be dropped; ` +
          `keeping the truncated response`
      );
    }

    // Safety classifiers can decline a request; content is empty or partial.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      const note = `The model declined this request (category: ${category}).`;
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: note,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry, conversation);
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: note });
      return;
    }

    // Append the whole content array, not just text: tool_use blocks and thinking
    // blocks have to be echoed back unchanged for the next round to be valid.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    // Conduct rule 1 ("reply first") is prompt text, and prompt text is a request, not a
    // guarantee. Log what actually happened on the opening round of a person-opened turn so
    // adherence is a number in the web log rather than an impression from a chat thread.
    if (round === 0 && inbound.some(message => message.fromId === "user")) {
      const opened = response.content.some(
        block => block.type === "text" && block.text.trim().length > 0
      );
      console.error(
        `[conduct] ${agent.profile.name}: opened ${opened ? "with a reply" : "tool-first"} ` +
          `(${toolUses.length} tool calls${opened ? ", text first" : ", no text"})`
      );
    }

    if (guardPending !== undefined) {
      console.error(
        `[conduct] ${agent.profile.name}: guard ${guardPending} ${toolUses.length > 0 ? "complied (tool calls followed)" : "ignored (answered again without a tool)"}`
      );
      guardPending = undefined;
    }

    if (toolUses.length === 0) {
      const finalText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("");

      // The guards (docs/31 layer 1e): a person-opened turn may not end on a verdict reached
      // with no tool, an offer to check instead of a check, or a promise with no call. Bounded
      // — twice per turn at most — logged, and the send-back kept out of the durable record:
      // the model's text is filed as blocks so the record has it, but it is not a reply
      // (`replySince` would have delivered the wrong verdict beside the corrected one).
      const reason =
        personOpened && guardsEnabled() && guardNudges < MAX_GUARD_NUDGES && finalText.trim() !== ""
          ? guardFor(finalText, toolCallsInTurn)
          : undefined;
      if (reason !== undefined) {
        guardNudges += 1;
        guardPending = reason;
        console.error(
          `[conduct] ${agent.profile.name}: guard ${reason} fired (${guardNudges}/${MAX_GUARD_NUDGES}, ${toolCallsInTurn} tool calls so far): "${finalText.trim().slice(0, 80)}"`
        );
        registry.appendTranscript(agent.id, {
          role: "assistant",
          kind: "blocks",
          blocks: response.content.filter((block): block is Anthropic.TextBlock => block.type === "text"),
          at: new Date().toISOString(),
        } satisfies TranscriptEntry, conversation);
        messages.push({ role: "user", content: nudgeFor(reason, chinese) });
        // A verdict or an offer is answered with a demand for a tool call, which is what the
        // wires can now carry; a trailing intent is left to the model, which already named
        // the action.
        if (reason !== "trailing-intent") forceTools = { type: "any" };
        finishing = false;
        continue;
      }

      // The closing send (Grok Bot's `turnEndedOnSilentToolCalls`, docs/31 layer 1b): the
      // person saw the opening line, then tools ran, then nothing. Once.
      if (!finalText.trim() && personOpened && interimDelivered && !closingNudged && guardsEnabled()) {
        closingNudged = true;
        console.error(`[conduct] ${agent.profile.name}: closing nudge (acknowledged, ran tools, ended silent)`);
        messages.push({ role: "user", content: closingNudge(chinese) });
        finishing = false;
        continue;
      }

      if (finalText.trim()) {
        registry.appendTranscript(agent.id, {
          role: "assistant",
          text: finalText,
          at: new Date().toISOString(),
        } satisfies TranscriptEntry, conversation);
        // A Stop hook may send the model back once: its reason becomes the next user message,
        // and `stop_hook_active` tells the hook it already did so, which is how a hook avoids
        // looping the turn forever (Claude Code's contract, kept exactly).
        if (deps.hooks?.has("Stop")) {
          const hook = await deps.hooks.run("Stop", {
            session_id: turnId,
            agent_name: agent.profile.name,
            stop_hook_active: stopHookActive,
            last_message: finalText.slice(0, 20_000),
          });
          if (hook.blocked && !stopHookActive) {
            stopHookActive = true;
            finishing = true;
            const note = `[Stop hook] ${hook.reason ?? "continue"}`;
            registry.appendTranscript(agent.id, { role: "user", text: note, at: new Date().toISOString() } satisfies TranscriptEntry, conversation);
            messages.push({ role: "user", content: note });
            continue;
          }
        }
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
      } satisfies TranscriptEntry, conversation);
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: silent });
      console.error(`[turn] ${agent.profile.name}: ended with no text on round ${round}`);
      return;
    }
    // Tool calls mean the model is working again, so steering is welcome at the next boundary.
    finishing = false;
    toolCallsInTurn += toolUses.length;

    // Text followed only by bookkeeping calls is not narration — it is the answer,
    // filed. Measured on t51: the agent wrote its whole analysis, then tidied up
    // (`Tasks.update`, `RememberFact`), and the tidying demoted the answer to a folded
    // step nobody was shown; the person's screen said "已记下。等你下一步。" Whether text
    // is "the answer" was being decided by whether a tool call happened to follow it —
    // a fact about sequencing, not content. So: when every call in the round files a
    // conclusion rather than gathers evidence, the text lands in the transcript now,
    // where the reply is read from. The floor keeps a genuine one-line "记一下" from
    // being promoted into an answer.
    const roundText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("");
    const filedAnswer =
      roundText.trim().length >= FILED_ANSWER_FLOOR &&
      toolUses.every(use => BOOKKEEPING_TOOLS.has(use.name));
    if (filedAnswer) {
      registry.appendTranscript(agent.id, {
        role: "assistant",
        text: roundText,
        at: new Date().toISOString(),
      } satisfies TranscriptEntry, conversation);
    }

    // The opening line reaches the person while the tools run (docs/31 layer 1a). Grok Bot
    // needs a SendToUser tool for this because its plain text is never shown; ours is, so
    // the same effect is one event: the text the model said beside its first calls goes to
    // the chat now, once, and stays out of the final reply. Measured on Bob's thread: the
    // line "你说得对，我先查一下" had been filed as blocks and shown to nobody.
    if (personOpened && !interimDelivered && toolUses.length > 0 && !filedAnswer && roundText.trim() !== "") {
      interimDelivered = true;
      emit({ type: "interim", agentId: agent.id, agentName: agent.profile.name, text: roundText.trim() });
      console.error(`[conduct] ${agent.profile.name}: interim line delivered (${roundText.trim().length} chars)`);
    }

    // Execute every requested tool and return all results in one user message.
    // Splitting them across messages trains the model out of parallel calls.
    //
    // Stamped before the tools run, so the `blocks` entry says when the model asked and
    // the `results` entry says when the answers were all in. Both used to share one
    // timestamp taken after the batch, which made every duration on disk derive to zero —
    // and a defect that succeeds slowly (a click that took fifteen seconds) invisible to
    // any reading of the transcript.
    const requestedAt = new Date().toISOString();
    const results: Anthropic.ToolResultBlockParam[] = [];
    /** Tool-use ids whose stored text differs from what the model was shown. */
    const withheld = new Map<string, string>();
    const runOne = async (
      toolUse: Anthropic.ToolUseBlock
    ): Promise<{ block: Anthropic.ToolResultBlockParam; recordAs?: string }> => {
      emit({
        type: "tool_start",
        agentId: agent.id,
        agentName: agent.profile.name,
        tool: toolUse.name,
        input: toolUse.input,
      });

      // Auto-review, for the binding class only. Shadow mode classifies beside the call and
      // records the verdict; enforce mode waits for it and hands a BLOCK back to the model as the
      // tool's answer, with the reason, so the agent can ask rather than guess.
      const toolInput = (toolUse.input ?? {}) as Record<string, unknown>;
      const reviewWhy = deps.autoReview === undefined ? undefined : needsReview(toolUse.name, toolInput);
      let blocked: Verdict | undefined;
      if (reviewWhy !== undefined && deps.autoReview !== undefined && deps.autoReview.mode() !== "off") {
        const reviewInput = reviewInputFor({
          agentName: agent.profile.name,
          inbound,
          transcript: registry.readTranscript(agent.id, conversation) as TranscriptEntry[],
          messages,
          tool: toolUse.name,
          input: toolInput,
          why: reviewWhy,
        });
        if (deps.autoReview.mode() === "enforce") {
          const verdict = await deps.autoReview.review(reviewInput);
          if (verdict.verdict === "BLOCK") blocked = verdict;
        } else {
          void deps.autoReview.review(reviewInput);
        }
      }

      // PreToolUse hooks, after auto-review: a person's own script gets the same veto, with the
      // same shape of answer to the model.
      let hookBlock: string | undefined;
      if (blocked === undefined && deps.hooks?.has("PreToolUse", toolUse.name)) {
        const hook = await deps.hooks.run("PreToolUse", {
          session_id: turnId,
          agent_name: agent.profile.name,
          tool_name: toolUse.name,
          tool_input: toolInput,
        });
        if (hook.blocked) hookBlock = hook.reason ?? "blocked by a PreToolUse hook";
      }

      let outcome: ToolOutcome;
      if (hookBlock !== undefined) {
        outcome = { text: `Blocked by a PreToolUse hook: ${hookBlock}`, isError: true };
      } else if (blocked !== undefined) {
        outcome = {
          text:
            `Auto-review refused this call: ${blocked.reason || "the person did not ask for it"}. ` +
            "If they did ask, quote where; otherwise ask them before doing this.",
          isError: true,
        };
      } else try {
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
            hostRunner: deps.hostRunner,
            vault: deps.vault,
            tasks: deps.tasks,
            scopes: deps.scopes,
            mcp: deps.mcp,
            askUser: deps.askUser,
            docReader: deps.docReader,
            skillProvenance: deps.skillProvenance,
            ...(deps.templateSetup !== undefined ? { templateSetup: deps.templateSetup } : {}),
            ...(deps.templates !== undefined ? { templates: deps.templates } : {}),
            turnId,
            conversation,
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

      // A model without vision must not be handed image blocks it cannot decode — the
      // request would be refused outright. The text keeps the fact that there was an
      // image, so the agent can route around its own blindness (OCR, a teammate).
      if (provider.vision === false && outcome.images !== undefined && outcome.images.length > 0) {
        const { images: _unseen, ...rest } = outcome;
        outcome = {
          ...rest,
          text: `${outcome.text}\n[an image was attached, but this model cannot see images]`,
        };
      }
      // PostToolUse hooks see the result; a block here is a note appended for the model, which is
      // what Claude Code does with a hook's stderr on exit 2.
      if (deps.hooks?.has("PostToolUse", toolUse.name)) {
        const hook = await deps.hooks.run("PostToolUse", {
          session_id: turnId,
          agent_name: agent.profile.name,
          tool_name: toolUse.name,
          tool_input: toolInput,
          tool_response: outcome.text.slice(0, 20_000),
          is_error: outcome.isError === true,
        });
        if (hook.blocked && hook.reason !== undefined && hook.reason !== "") {
          outcome = { ...outcome, text: `${outcome.text}\n\n[PostToolUse hook] ${hook.reason}` };
        }
      }
      // `recordAs` kept beside the result rather than inside it: what the API is sent and
      // what the record keeps are two different things, and the block that goes to the
      // model must not carry the substitute anywhere it could be mistaken for the answer.
      return {
        block: toolResultBlock(toolUse.id, outcome),
        ...(outcome.recordAs !== undefined ? { recordAs: outcome.recordAs } : {}),
      };
    };

    // Reads run side by side, everything else alone, all in the model's order (docs/31
    // layer 1c). Three searches asked for together used to cost three round-trips of wall
    // time; the results still land in the order the calls were made, so nothing downstream
    // can tell the difference except the clock.
    const done: ({ block: Anthropic.ToolResultBlockParam; recordAs?: string } | undefined)[] =
      toolUses.map(() => undefined);
    let at = 0;
    while (at < toolUses.length) {
      const first = toolUses[at]!;
      if (!PARALLEL_SAFE_TOOLS.has(first.name)) {
        done[at] = await runOne(first);
        at += 1;
        continue;
      }
      let until = at;
      while (
        until < toolUses.length &&
        until - at < PARALLEL_TOOL_LIMIT &&
        PARALLEL_SAFE_TOOLS.has(toolUses[until]!.name)
      ) {
        until += 1;
      }
      const batch = await Promise.all(toolUses.slice(at, until).map(use => runOne(use)));
      batch.forEach((entry, offset) => {
        done[at + offset] = entry;
      });
      at = until;
    }
    for (const entry of done) {
      if (entry === undefined) continue;
      results.push(entry.block);
      if (entry.recordAs !== undefined) withheld.set(entry.block.tool_use_id, entry.recordAs);
    }

    // Persist the exchange as blocks, in the order the API requires: the calling
    // assistant turn, then its results. Thinking blocks are not kept — they are
    // only valid within the turn that produced them. Text promoted as a filed answer
    // above is left out here: it already stands as a plain entry just before this
    // one, and keeping both would replay the same paragraph twice into every later
    // request.
    registry.appendTranscript(agent.id, {
      role: "assistant",
      kind: "blocks",
      blocks: response.content.filter(
        (block): block is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
          (block.type === "text" && !filedAnswer) || block.type === "tool_use"
      ),
      at: requestedAt,
    } satisfies TranscriptEntry, conversation);
    registry.appendTranscript(agent.id, {
      role: "user",
      kind: "results",
      blocks: results.map(block => storableResult(block, withheld.get(block.tool_use_id))),
      at: new Date().toISOString(),
    } satisfies TranscriptEntry, conversation);

    messages.push({ role: "user", content: results });

    // What this round did, reduced to what decides whether anything is happening. Recorded after the
    // tools ran, so a todo ticked off during the round counts as the change it is.
    rounds.push({
      signatures: toolUses.map(use => signatureOf(use.name, use.input)),
      stateHash: stateHashOf(registry.readDurableState(agent.id, conversation)),
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
      } satisfies TranscriptEntry, conversation);
      emit({
        type: "text",
        agentId: agent.id,
        agentName: agent.profile.name,
        delta: report,
      });
      // Said twice, to two audiences: as prose to whoever is reading the conversation,
      // and as an event to whoever is tracking whether this work needs a person now.
      emit({ type: "stuck", agentId: agent.id, reason: report });
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
    } satisfies TranscriptEntry, conversation);
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
    } satisfies TranscriptEntry, conversation);
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
  } satisfies TranscriptEntry, conversation);
  throw new TurnRoundLimitExceeded(note);
  }
}

/**
 * What the classifier is shown for one call: the person's words in this conversation as the only
 * trusted block, and everything else — teammates' messages, the agent's own narration this
 * turn — as untrusted. Wake prompts are teammates speaking and go on the untrusted side even
 * though the transcript stores them as user entries.
 */
export function reviewInputFor(options: {
  agentName: string;
  inbound: readonly InboundMessage[];
  transcript: readonly TranscriptEntry[];
  messages: readonly Anthropic.MessageParam[];
  tool: string;
  input: Record<string, unknown>;
  why: string;
}): ReviewInput {
  const trusted: string[] = [];
  const untrusted: string[] = [];
  // A template setup cue is a user entry too, and its names — the template's, its creator's, its
  // skills' — are third-party text; it goes on the untrusted side with the wakes.
  const harnessSpeaking = (text: string): boolean => text.startsWith(AGENT_WAKE_CUE) || text.startsWith(TEMPLATE_CUE);
  for (const entry of options.transcript) {
    if (entry.role !== "user" || "kind" in entry || typeof entry.text !== "string") continue;
    (harnessSpeaking(entry.text) ? untrusted : trusted).push(entry.text);
  }
  // The turn's own messages are usually already the transcript's last entries; only what is not
  // there yet is added, so nothing is shown to the classifier twice.
  for (const message of options.inbound) {
    const side = message.fromId === "user" && !harnessSpeaking(message.text) ? trusted : untrusted;
    if (!trusted.includes(message.text) && !untrusted.includes(message.text)) side.push(message.text);
  }
  for (const message of options.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() !== "") untrusted.push(block.text);
    }
  }
  return {
    agentName: options.agentName,
    trusted: trusted.slice(-12),
    untrusted: untrusted.slice(-12),
    tool: options.tool,
    input: options.input,
    why: options.why,
  };
}

/** A short, stable digest of an assembled prompt, for the turn ledger's `promptHash`. */
export function promptHashOf(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\u0000");
  return hash.digest("hex").slice(0, 16);
}
