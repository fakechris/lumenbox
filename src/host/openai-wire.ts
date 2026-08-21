/**
 * The OpenAI-compatible wire, presented as the client the turn engine already speaks.
 *
 * Half the vendors worth supporting implement the Anthropic Messages API and half
 * implement OpenAI chat completions; the turn engine speaks Anthropic. Rather than
 * teach four hundred lines of turn logic a second dialect, this file translates at the
 * edge: requests go out as chat completions, responses come back shaped as
 * `Anthropic.Message`, and the stream object honours exactly the surface the engine
 * uses — `on("streamEvent")`, `on("text")`, `finalMessage()` — nothing more. The cast
 * to `Anthropic` at the call site is load-bearing and deliberate: the alternative is a
 * structural type threaded through every signature for the benefit of no reader.
 *
 * What does not survive translation, by design rather than accident:
 *   - `thinking` and `output_config.effort` are never sent — providers on this wire
 *     have those capability flags off, so the engine never asks.
 *   - Prompt caching: `cache_control` fields are dropped silently; the wire has no
 *     equivalent and the flag is off.
 *   - Images inside tool results: chat completions tool messages carry text only, so
 *     screenshots ride in a user message appended immediately after — the same
 *     information, one position later. Vendors that cannot see images have vision
 *     off and never receive any.
 */

import type Anthropic from "@anthropic-ai/sdk";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIRequest {
  model: string;
  max_tokens: number;
  messages: OpenAIMessage[];
  tools?: { type: "function"; function: object }[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

/** The subset of Anthropic request params the engine actually sends. */
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => String(b.text ?? ""))
    .join("\n");
}

function imagePartsOf(content: unknown): OpenAIContentPart[] {
  if (!Array.isArray(content)) return [];
  const parts: OpenAIContentPart[] = [];
  for (const block of content as {
    type?: string;
    source?: { type?: string; media_type?: string; data?: string };
  }[]) {
    if (block?.type === "image" && block.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  return parts;
}

/** Anthropic-shaped request → chat completions body. Exported for its tests. */
export function toOpenAIRequest(params: CreateParams): OpenAIRequest {
  const out: OpenAIMessage[] = [];

  const system =
    typeof params.system === "string" ? params.system : textOf(params.system ?? []);
  if (system.trim() !== "") out.push({ role: "system", content: system });

  for (const message of params.messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = textOf(message.content);
      const calls: OpenAIToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "tool_use") {
          calls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    // A user message: tool results become `tool` messages, in order; everything else
    // (prose, images) follows as one user message so nothing is dropped.
    const trailing: OpenAIContentPart[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content:
            textOf(block.content) +
            (block.is_error ? "\n[This tool call failed.]" : ""),
        });
        const images = imagePartsOf(block.content);
        if (images.length > 0) {
          trailing.push(
            { type: "text", text: "Result of the tool call above, as an image:" },
            ...images
          );
        }
      } else if (block.type === "text") {
        trailing.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        trailing.push(...imagePartsOf([block]));
      }
    }
    if (trailing.length > 0) {
      const onlyText = trailing.every(part => part.type === "text");
      out.push({
        role: "user",
        content: onlyText
          ? trailing.map(part => part.text ?? "").join("\n")
          : trailing,
      });
    }
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: out,
    ...(params.tools !== undefined && params.tools.length > 0
      ? {
          tools: params.tools.map(tool => ({
            type: "function" as const,
            function: {
              name: (tool as Anthropic.Tool).name,
              description: (tool as Anthropic.Tool).description,
              parameters: (tool as Anthropic.Tool).input_schema,
            },
          })),
        }
      : {}),
  };
}

interface OpenAIChoiceMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

/** Chat completion response → Anthropic.Message. Exported for its tests. */
export function fromOpenAIResponse(body: {
  id?: string;
  model?: string;
  choices?: { message?: OpenAIChoiceMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): Anthropic.Message {
  const choice = body.choices?.[0];
  const content: Anthropic.ContentBlock[] = [];
  const text = choice?.message?.content;
  if (typeof text === "string" && text !== "") {
    content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments === "" ? {} : JSON.parse(call.function.arguments);
    } catch {
      // Malformed arguments are the model's failure, surfaced as an empty call the
      // tool will reject with a readable message rather than a crash here.
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    } as Anthropic.ToolUseBlock);
  }

  const finish = choice?.finish_reason ?? "stop";
  const stop_reason: Anthropic.Message["stop_reason"] =
    finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";

  return {
    id: body.id ?? "openai-wire",
    type: "message",
    role: "assistant",
    model: body.model ?? "",
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

/** What a streamed response accumulates before it becomes a Message. */
interface StreamTally {
  id: string;
  model: string;
  text: string;
  calls: Map<number, { id: string; name: string; args: string }>;
  finish: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The stream shim: the three members the engine uses, over SSE chat completions.
 *
 * Every delta — text or tool-call fragment — fires a `streamEvent`, because that is
 * the engine's first-token deadline signal; only text deltas fire `text`, because that
 * is what reaches the person watching.
 */
class OpenAIWireStream {
  private textHandlers: ((delta: string) => void)[] = [];
  private eventHandlers: ((event: { type: string }) => void)[] = [];
  private readonly done: Promise<Anthropic.Message>;

  constructor(
    baseUrl: string,
    key: string | undefined,
    params: CreateParams,
    signal?: AbortSignal
  ) {
    this.done = this.run(baseUrl, key, params, signal);
    // A rejection that lands before finalMessage() is awaited must not be an unhandled
    // rejection; finalMessage() re-observes it.
    this.done.catch(() => {});
  }

  on(event: "streamEvent" | "text", handler: (payload: never) => void): this {
    if (event === "text") this.textHandlers.push(handler as (delta: string) => void);
    else this.eventHandlers.push(handler as (event: { type: string }) => void);
    return this;
  }

  finalMessage(): Promise<Anthropic.Message> {
    return this.done;
  }

  private async run(
    baseUrl: string,
    key: string | undefined,
    params: CreateParams,
    signal?: AbortSignal
  ): Promise<Anthropic.Message> {
    const request = {
      ...toOpenAIRequest(params),
      stream: true,
      stream_options: { include_usage: true },
    };
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok || response.body === null) {
      // The vendor's own words, status included: "invalid api key" from the horse's
      // mouth beats any paraphrase, and overflow classification reads this text.
      const detail = await response.text().catch(() => "");
      throw new Error(`${response.status} ${detail.slice(0, 2000)}`);
    }

    const tally: StreamTally = {
      id: "openai-wire",
      model: params.model,
      text: "",
      calls: new Map(),
      finish: "stop",
      promptTokens: 0,
      completionTokens: 0,
    };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          this.absorb(tally, payload);
        }
      }
    }

    return fromOpenAIResponse({
      id: tally.id,
      model: tally.model,
      choices: [
        {
          message: {
            content: tally.text === "" ? null : tally.text,
            tool_calls: [...tally.calls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, call]) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.args },
              })),
          },
          finish_reason: tally.finish,
        },
      ],
      usage: {
        prompt_tokens: tally.promptTokens,
        completion_tokens: tally.completionTokens,
      },
    });
  }

  private absorb(tally: StreamTally, payload: string): void {
    let parsed: {
      id?: string;
      model?: string;
      choices?: {
        delta?: { content?: string | null; tool_calls?: Partial<OpenAIToolCall & { index: number; function: { name?: string; arguments?: string } }>[] };
        finish_reason?: string | null;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // A torn frame; the next one is whole.
    }
    if (parsed.id) tally.id = parsed.id;
    if (parsed.model) tally.model = parsed.model;
    if (parsed.usage) {
      tally.promptTokens = parsed.usage.prompt_tokens ?? tally.promptTokens;
      tally.completionTokens = parsed.usage.completion_tokens ?? tally.completionTokens;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) tally.finish = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content !== "") {
      tally.text += delta.content;
      for (const handler of this.eventHandlers) handler({ type: "content_block_delta" });
      for (const handler of this.textHandlers) handler(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const call = tally.calls.get(index) ?? { id: "", name: "", args: "" };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.args += fragment.function.arguments;
      tally.calls.set(index, call);
      // Progress for the first-token deadline: a round that is entirely tool calls
      // must not read as a stall.
      for (const handler of this.eventHandlers) handler({ type: "content_block_delta" });
    }
  }
}

/**
 * The client. Presents `{ messages: { create, stream } }`, which is the entire
 * surface the engine, the summariser, the extractor and the connection test use.
 */
export class OpenAIWireClient {
  readonly messages: {
    create: (params: CreateParams) => Promise<Anthropic.Message>;
    stream: (params: CreateParams, options?: { signal?: AbortSignal }) => OpenAIWireStream;
  };

  constructor(options: { baseURL: string; key?: string }) {
    const { baseURL, key } = options;
    this.messages = {
      create: async params => {
        const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(toOpenAIRequest(params)),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`${response.status} ${detail.slice(0, 2000)}`);
        }
        return fromOpenAIResponse(
          (await response.json()) as Parameters<typeof fromOpenAIResponse>[0]
        );
      },
      stream: (params, streamOptions) =>
        new OpenAIWireStream(baseURL, key, params, streamOptions?.signal),
    };
  }
}
