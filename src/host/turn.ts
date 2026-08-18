/**
 * The agent turn loop.
 *
 * A manual tool-use loop rather than the SDK's tool runner, because a turn here
 * has to be abortable mid-flight: a priority message from a teammate supersedes
 * background work, and the abort has to land between tool calls.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { AgentBus, InboundMessage } from "../agents/bus.ts";
import type { BoxClient } from "../box/client.ts";
import type { DisplayLease } from "../box/display-lease.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { buildSystemPromptParts, buildTurnPrompt } from "./prompt.ts";
import { buildTools, dispatchTool, type ToolOutcome } from "./tools.ts";
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
const MAX_ROUNDS = Number(process.env.AGENTBOX_MAX_ROUNDS ?? 400);
/** Transcript entries replayed into a new turn's context. */
const HISTORY_LIMIT = 60;

export interface TurnDeps {
  client: Anthropic;
  registry: AgentRegistry;
  bus: AgentBus;
  box: BoxClient | undefined;
  /** Which desktop this agent drives. Each agent has its own. */
  displayIndex?: number;
  /** Guards one desktop against two agents; moot when each has its own. */
  display?: DisplayLease;
  resolution: ResolutionConfig | undefined;
  /** Which endpoint and what it can do. Omitted in tests to mean full Claude. */
  provider?: ProviderProfile;
  effort?: Effort;
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
  | { type: "aborted"; agentId: string }
  | {
      type: "usage";
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
type TranscriptEntry =
  | { role: "user" | "assistant"; text: string; at: string }
  /** An assistant turn that called tools; carries text and tool_use blocks. */
  | { role: "assistant"; kind: "blocks"; blocks: Anthropic.ContentBlockParam[]; at: string }
  /** The matching results. Must immediately follow its `blocks` entry. */
  | {
      role: "user";
      kind: "results";
      blocks: Anthropic.ToolResultBlockParam[];
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
function historyToMessages(
  entries: readonly TranscriptEntry[]
): Anthropic.MessageParam[] {
  const window = entries.slice(-HISTORY_LIMIT);

  // A results entry at the front has lost its call.
  while (window.length > 0 && "kind" in window[0]! && window[0]!.kind === "results") {
    window.shift();
  }
  // A blocks entry at the end has lost its results.
  while (
    window.length > 0 &&
    "kind" in window.at(-1)! &&
    (window.at(-1) as { kind?: string }).kind === "blocks"
  ) {
    window.pop();
  }

  const messages: Anthropic.MessageParam[] = [];
  for (const entry of window) {
    if ("kind" in entry) {
      if (entry.blocks.length === 0) continue;
      messages.push({ role: entry.role, content: entry.blocks });
    } else if (entry.text.trim() !== "") {
      messages.push({ role: entry.role, content: entry.text });
    }
  }
  return messages;
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

  const promptParts = buildSystemPromptParts({
    agent,
    teammates: registry.list(),
    memory: registry.readMemory(agent.id),
    resolution: deps.resolution,
    agentsRoot: registry.root,
    hasBox: box !== undefined,
    vision: provider.vision,
  });

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

  const history = registry.readTranscript(agent.id) as TranscriptEntry[];
  const turnText = buildTurnPrompt(inbound);

  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(history),
    { role: "user", content: turnText },
  ];

  registry.appendTranscript(agent.id, {
    role: "user",
    text: turnText,
    at: new Date().toISOString(),
  } satisfies TranscriptEntry);

  const tools = buildTools(box !== undefined, provider.vision);

  try {
    await runRounds();
  } finally {
    // Release the desktop however the turn ends — normally, by abort, or by
    // throwing. A lease leaked here would lock every other agent out of the
    // screen for the lifetime of the process.
    deps.display?.release(agent.id);
  }

  async function runRounds(): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) {
      emit({ type: "aborted", agentId: agent.id });
      throw new TurnAborted();
    }
    emit({ type: "round", agentId: agent.id, round });

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
      { signal }
    );

    stream.on("text", delta => {
      emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta });
    });

    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
    } catch (error) {
      if (signal.aborted) {
        emit({ type: "aborted", agentId: agent.id });
        throw new TurnAborted();
      }
      throw error;
    }

    emit({
      type: "usage",
      agentId: agent.id,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
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
      }
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
            display: deps.display,
            displayIndex: deps.displayIndex,
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
  }

  // Reaching the cap is a fault, not an ending. Recording it as an ordinary
  // assistant message would leave a stuck agent looking like a finished one, and
  // the user with no reason to ask why nothing happened.
  const note =
    `Stopped after ${MAX_ROUNDS} tool rounds without finishing — the agent is ` +
    "probably looping rather than making progress.";
  registry.appendTranscript(agent.id, {
    role: "assistant",
    text: note,
    at: new Date().toISOString(),
  } satisfies TranscriptEntry);
  throw new TurnRoundLimitExceeded(note);
  }
}
