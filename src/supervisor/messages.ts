/**
 * The supervisor on any configured provider (INV-1528): the Messages API with tool use, through
 * the app's own provider layer (`createClient`), so a key set in Settings → Model is the key used
 * and OpenAI-wire endpoints are translated as they are for the agents. The conversation lives in
 * this closure, one per run. OpenAI's gpt-6 models are the exception and keep the Responses
 * adapter (openai.ts): their Chat Completions endpoint refuses function tools.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelAsk } from "./openai.ts";

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };

export function messagesAdapter(client: Pick<Anthropic, "messages">, model: string, maxTokens = 2_048): ModelAsk {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  return async request => {
    messages.push({
      role: "user",
      content: request.input.map(item => ("role" in item ? { type: "text", text: item.content } : { type: "tool_result", tool_use_id: item.call_id, content: item.output })),
    });
    const response = (await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: request.instructions,
      messages: messages as never,
      tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as never })),
    })) as { id: string; content: Block[]; usage?: { input_tokens?: number; output_tokens?: number } };
    messages.push({ role: "assistant", content: response.content });
    return {
      id: response.id,
      calls: response.content.filter(block => block.type === "tool_use").map(block => ({ callId: block.id ?? "", name: block.name ?? "", arguments: (block.input ?? {}) as Record<string, unknown> })),
      text: response.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n").trim(),
      usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0, reasoning: 0 },
    };
  };
}
