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
import type { ResolutionConfig } from "../protocol/index.ts";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.ts";
import { buildTools, dispatchTool, type ToolOutcome } from "./tools.ts";

export const DEFAULT_MODEL = "claude-opus-5";
/** Streaming, so a long turn cannot trip an HTTP timeout. */
const MAX_TOKENS = 64_000;
/** A turn that has gone this many rounds is looping, not working. */
const MAX_ROUNDS = 40;
/** Transcript entries replayed into a new turn's context. */
const HISTORY_LIMIT = 60;

export interface TurnDeps {
  client: Anthropic;
  registry: AgentRegistry;
  bus: AgentBus;
  box: BoxClient | undefined;
  resolution: ResolutionConfig | undefined;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  onEvent?: (event: TurnEvent) => void;
}

export type TurnEvent =
  | { type: "text"; agentId: string; agentName: string; delta: string }
  | { type: "tool_start"; agentId: string; agentName: string; tool: string; input: unknown }
  | { type: "tool_end"; agentId: string; agentName: string; tool: string; summary: string }
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

/** A transcript record. Only user/assistant text is persisted, not tool traffic. */
interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  at: string;
}

function historyToMessages(
  entries: readonly TranscriptEntry[]
): Anthropic.MessageParam[] {
  return entries
    .slice(-HISTORY_LIMIT)
    .filter(entry => entry.text.trim() !== "")
    .map(entry => ({ role: entry.role, content: entry.text }));
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

  const systemPrompt = buildSystemPrompt({
    agent,
    teammates: registry.list(),
    memory: registry.readMemory(agent.id),
    resolution: deps.resolution,
    agentsRoot: registry.root,
    hasBox: box !== undefined,
  });

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

  const tools = buildTools(box !== undefined);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) {
      emit({ type: "aborted", agentId: agent.id });
      throw new TurnAborted();
    }
    emit({ type: "round", agentId: agent.id, round });

    const stream = client.messages.stream(
      {
        model: deps.model ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        // Adaptive thinking with a summary, so the caller can show progress
        // instead of a silent pause on a long turn.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: deps.effort ?? "high" },
        // The system prompt is stable per agent across a conversation, so one
        // breakpoint at its end caches both the tool definitions and the prompt.
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ],
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
          { agent, registry, bus, box }
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
      });
      results.push(toolResultBlock(toolUse.id, outcome));
    }

    messages.push({ role: "user", content: results });
  }

  const note =
    `Stopped after ${MAX_ROUNDS} tool rounds without finishing. ` +
    "The task may need to be broken into smaller steps.";
  registry.appendTranscript(agent.id, {
    role: "assistant",
    text: note,
    at: new Date().toISOString(),
  } satisfies TranscriptEntry);
  emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: `\n${note}\n` });
}
