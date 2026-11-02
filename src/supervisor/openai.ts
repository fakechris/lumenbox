/**
 * The supervisor's model, through OpenAI's Responses API (INV-1518).
 *
 * Responses, not Chat Completions: on the gpt-6.1 models, function tools with reasoning are only
 * served there (Chat Completions answers 400). A conversation is carried by `previous_response_id`,
 * so each wake sends only what is new — the event and the record, or the tool results.
 * The key is a parameter; nothing here reads the environment or writes it anywhere.
 */

export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type InputItem =
  | { role: "user"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ModelTurn {
  id: string;
  calls: { callId: string; name: string; arguments: Record<string, unknown> }[];
  text: string;
  usage: { input: number; output: number; reasoning: number };
}

export type ModelAsk = (request: { instructions: string; input: InputItem[]; tools: FunctionTool[]; previous?: string }) => Promise<ModelTurn>;

export function openaiResponses(options: { token: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ModelAsk {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async request => {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools.map(tool => ({ type: "function", ...tool })),
        ...(request.previous !== undefined ? { previous_response_id: request.previous } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
    const body = (await response.json()) as {
      id?: string;
      error?: { message?: string } | null;
      output?: { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[];
      usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
    };
    if (!response.ok || body.error) throw new Error(`model ${options.model}: HTTP ${response.status} ${body.error?.message ?? ""}`.trim());
    const calls = (body.output ?? []).filter(item => item.type === "function_call").map(item => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>; } catch { args = { _unparsed: item.arguments ?? "" }; }
      return { callId: item.call_id ?? "", name: item.name ?? "", arguments: args };
    });
    const text = (body.output ?? []).filter(item => item.type === "message").flatMap(item => item.content ?? []).map(part => part.text ?? "").join("\n").trim();
    return {
      id: body.id ?? "",
      calls,
      text,
      usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0, reasoning: body.usage?.output_tokens_details?.reasoning_tokens ?? 0 },
    };
  };
}
