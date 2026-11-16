/**
 * Poppy Conversations (spec section 8.2).
 *
 * A Company can expose a conversation endpoint (agent.protocols type "poppy")
 * that the personal agent connects to via SSE. Messages flow both ways:
 * the personal agent sends on behalf of the user, the Company agent responds.
 *
 * This is a structured channel — not a browser, not an API call — specifically
 * for agent-to-agent dialogue.
 */

import type { PoppyCompany } from "./discovery.ts";
import type { PoppySession } from "./session.ts";
import { poppyRequest } from "./http.ts";

// ── Types ─────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationEndpoint {
  endpoint: string;
  description?: string;
  access?: string;
}

export type ConversationEventHandler = (event: ConversationEvent) => void;

export type ConversationEvent =
  | { type: "message"; message: ConversationMessage }
  | { type: "error"; error: string }
  | { type: "done" }
  | { type: "operation"; operation: OperationRequest };

/** An operation the Company agent wants the user to approve (spec 8.4). */
export interface OperationRequest {
  id: string;
  type: string;
  description: string;
  parameters?: Record<string, unknown>;
  requiresApproval: boolean;
}

// ── Conversation Client ───────────────────────────────────────

/**
 * Finds the Poppy conversation endpoint from a Company's protocols.
 */
export function conversationEndpoint(company: PoppyCompany): ConversationEndpoint | null {
  const proto = company.agentProtocols?.find(
    p => p.type === "poppy" || p.type === "poppy-conversation"
  );
  if (!proto) return null;
  return {
    endpoint: proto.endpoint,
    description: proto.description,
    access: proto.access,
  };
}

/**
 * Sends a message to the Company's conversation endpoint and streams
 * the response via SSE.
 *
 * Returns an AbortController that can cancel the stream.
 */
export async function sendMessage(
  endpoint: ConversationEndpoint,
  session: PoppySession,
  message: string,
  onEvent: ConversationEventHandler,
  options?: { accessToken?: string; conversationId?: string },
): Promise<AbortController> {
  const controller = new AbortController();
  const headers = await session.headers("POST", endpoint.endpoint, options?.accessToken);

  // On the Company's own site, through the guarded door (http.ts).
  const response = await poppyRequest(endpoint.endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      message: { role: "user", content: message },
      ...(options?.conversationId ? { conversation_id: options.conversationId } : {}),
    }),
    signal: controller.signal,
  }, session.company.domain);

  if (!response.ok) {
    onEvent({ type: "error", error: `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}` });
    onEvent({ type: "done" });
    return controller;
  }

  // Process SSE stream.
  void processStream(response, onEvent).catch(error => {
    if (error instanceof Error && error.name === "AbortError") return;
    onEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
    onEvent({ type: "done" });
  });

  return controller;
}

/**
 * Reads an event stream as the SSE format defines it: an event is the lines up to a blank line,
 * however the bytes were split into reads; lines end in \n, \r\n or \r; several `data:` lines
 * are one value joined by \n; one space after the colon is dropped and no more. Earlier this
 * reset its event at every read, so an event split across two reads lost its `event:` name and an
 * operation arrived as a message.
 */
export class SseReader {
  private pending = "";
  private event = "";
  private data: string[] = [];

  constructor(private readonly emit: (event: string, data: string) => void) {}

  /** Feeds decoded text; emits every event it completes. */
  push(text: string): void {
    this.pending += text;
    // A trailing \r may be the first half of \r\n: keep it until the next read says which.
    const cut = this.pending.endsWith("\r") ? this.pending.length - 1 : this.pending.length;
    const lines = this.pending.slice(0, cut).split(/\r\n|\r|\n/);
    this.pending = (lines.pop() ?? "") + this.pending.slice(cut);
    for (const line of lines) this.line(line);
  }

  /** The stream ended: an event with no blank line after it is still dispatched. */
  end(): void {
    if (this.pending !== "") this.line(this.pending.replace(/\r$/, ""));
    this.pending = "";
    this.line("");
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) this.emit(this.event, this.data.join("\n"));
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}

async function processStream(
  response: Response,
  onEvent: ConversationEventHandler,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    onEvent({ type: "error", error: "No response body" });
    onEvent({ type: "done" });
    return;
  }

  const decoder = new TextDecoder();
  const sse = new SseReader((event, data) => dispatchSseEvent(event, data, onEvent));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(decoder.decode(value, { stream: true }));
    }
    sse.push(decoder.decode());
    sse.end();
  } finally {
    reader.releaseLock();
    onEvent({ type: "done" });
  }
}

function dispatchSseEvent(
  event: string,
  data: string,
  onEvent: ConversationEventHandler,
): void {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;

    if (event === "message" || (!event && parsed.role)) {
      onEvent({
        type: "message",
        message: {
          role: String(parsed.role ?? "assistant") as "user" | "assistant",
          content: String(parsed.content ?? ""),
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
          metadata: typeof parsed.metadata === "object" && parsed.metadata !== null
            ? parsed.metadata as Record<string, unknown>
            : undefined,
        },
      });
    } else if (event === "operation" && parsed.id) {
      onEvent({
        type: "operation",
        operation: {
          id: String(parsed.id),
          type: String(parsed.type ?? ""),
          description: String(parsed.description ?? ""),
          parameters: typeof parsed.parameters === "object" && parsed.parameters !== null
            ? parsed.parameters as Record<string, unknown>
            : undefined,
          requiresApproval: parsed.requires_approval === true,
        },
      });
    } else if (event === "error") {
      onEvent({ type: "error", error: String(parsed.message ?? parsed.error ?? data) });
    } else if (event === "done" || event === "[DONE]") {
      // Stream finished; processStream will emit `done` on reader close.
    }
  } catch {
    // Non-JSON data line; treat as plain text message.
    if (data.trim()) {
      onEvent({
        type: "message",
        message: { role: "assistant", content: data },
      });
    }
  }
}
