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

  const response = await fetch(endpoint.endpoint, {
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
  });

  if (!response.ok) {
    onEvent({ type: "error", error: `HTTP ${response.status}: ${await response.text()}` });
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
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData += line.slice(5).trim();
        } else if (line === "") {
          if (currentData) {
            dispatchSseEvent(currentEvent, currentData, onEvent);
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }
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
