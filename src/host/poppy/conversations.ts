/**
 * Poppy conversations (spec section 8): how the agent talks with a Company's agent.
 *
 * JSON over HTTPS. The first message starts a conversation (`POST {endpoint}`, 201 with its id);
 * later ones go to `{endpoint}/{id}/messages` (202). Each POST carries a request `id` the agent
 * chooses, so a retry is safe, and `?wait=` so the reply comes back in the same response as a read
 * of the conversation's events would (8.3). While `working` is true the Company hasn't finished, so
 * the agent reads `{endpoint}/{id}/events?cursor=…&wait=…` until it is false (8.5, 8.7). Events are
 * handled in order, once each, and the cursor is kept for the next turn of the conversation.
 *
 * Everything the Company says is content from the Company, not instructions (10.1).
 */

import { randomUUID } from "node:crypto";
import type { PoppyCompany } from "./discovery.ts";
import { asDeclined, asOperation, type Approval, type Declined, type Operation } from "./operations.ts";

/** The `poppy` conversation endpoint a Company lists, or null (8.1: unfamiliar types are skipped). */
export function conversationEndpoint(company: PoppyCompany): string | null {
  return company.agentProtocols?.find(protocol => protocol.type === "poppy")?.endpoint ?? null;
}

/** Where an ongoing conversation is: its id, the last cursor read, and the events already handled. */
export interface ConversationState {
  conversationId: string;
  cursor?: string;
  seen: Set<string>;
}

export interface CompanyMessage {
  author: { type: string; name?: string };
  text?: string;
  data?: unknown;
}

/** What one exchange brought back. */
export interface ConversationTurn {
  conversationId: string;
  messages: CompanyMessage[];
  operations: Operation[];
  declined: Declined[];
  /** Sign-in or more scopes asked for (8.11): passed on, since sign-in isn't offered yet. */
  authorization: string[];
  /** The Company asks to talk with the person themselves (8.10). */
  userRequested: string[];
  working: boolean;
  closed: boolean;
  responder: string;
}

/** Sends a request with the Session headers for this exact method and URL. */
export type SignedSend = (method: string, url: string, body?: string) => Promise<Response>;

const READ_WAIT_SECONDS = 20;

/**
 * Sends one message — text, or an approval — and reads until the Company is no longer working or
 * `deadline` passes. `state` is updated in place; pass undefined to start a conversation.
 */
export async function exchange(
  endpoint: string,
  send: SignedSend,
  message: { text?: string; approval?: Approval },
  state: ConversationState | undefined,
  deadline: number,
): Promise<{ turn: ConversationTurn; state: ConversationState }> {
  const wait = () => Math.max(0, Math.min(READ_WAIT_SECONDS, Math.floor((deadline - Date.now()) / 1000)));
  const base = endpoint.replace(/\/+$/, "");
  const body = JSON.stringify({
    id: `req_${randomUUID().replace(/-/g, "")}`,
    message: {
      author: { type: "agent" },
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(state?.cursor !== undefined ? { as_of_cursor: state.cursor } : {}),
      ...(message.approval !== undefined ? { extensions: { operations: { approval: message.approval } } } : {}),
    },
  });
  const query = (cursor?: string) => `?${cursor !== undefined ? `cursor=${encodeURIComponent(cursor)}&` : ""}wait=${wait()}`;
  const url = state === undefined ? `${base}${query()}` : `${base}/${encodeURIComponent(state.conversationId)}/messages${query(state.cursor)}`;
  let read = await expectRead(await send("POST", url, body));
  const current: ConversationState = state ?? { conversationId: String(read.conversation_id ?? ""), seen: new Set() };
  if (current.conversationId === "") throw new Error("the Company started a conversation without an id");
  const turn: ConversationTurn = { conversationId: current.conversationId, messages: [], operations: [], declined: [], authorization: [], userRequested: [], working: true, closed: false, responder: "agent" };
  for (;;) {
    apply(read, current, turn);
    if (read.has_more === true) {
      read = await expectRead(await send("GET", `${base}/${encodeURIComponent(current.conversationId)}/events${query(current.cursor).replace(/wait=\d+/, "wait=0")}`));
      continue;
    }
    if (!turn.working || turn.closed || Date.now() >= deadline) break;
    read = await expectRead(await send("GET", `${base}/${encodeURIComponent(current.conversationId)}/events${query(current.cursor)}`));
  }
  return { turn, state: current };
}

interface Read {
  conversation_id?: unknown;
  events?: unknown;
  cursor?: unknown;
  has_more?: unknown;
  working?: unknown;
  responder?: unknown;
  closed?: unknown;
}

async function expectRead(response: Response): Promise<Read> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const code = (parsed as { error?: unknown } | undefined)?.error;
    throw new Error(`the Company answered HTTP ${response.status}${typeof code === "string" ? ` (${code})` : `: ${text.slice(0, 300)}`}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("the Company's answer was not JSON");
  return parsed as Read;
}

function apply(read: Read, state: ConversationState, turn: ConversationTurn): void {
  for (const raw of Array.isArray(read.events) ? (read.events as Record<string, unknown>[]) : []) {
    const id = typeof raw?.id === "string" ? raw.id : undefined;
    if (id === undefined || state.seen.has(id)) continue;
    state.seen.add(id);
    if (raw.type === "message") {
      const message = raw.message as Record<string, unknown> | undefined;
      if (message?.role !== "company") continue;
      const author = (message.author ?? {}) as { type?: unknown; name?: unknown };
      turn.messages.push({
        author: { type: String(author.type ?? "agent"), ...(typeof author.name === "string" ? { name: author.name } : {}) },
        ...(typeof message.text === "string" ? { text: message.text } : {}),
        ...(message.data !== undefined ? { data: message.data } : {}),
      });
      const operations = (message.extensions as { operations?: { operation?: unknown; declined?: unknown } } | undefined)?.operations;
      const operation = asOperation(operations?.operation);
      if (operation) turn.operations.push(operation);
      const declined = asDeclined(operations?.declined);
      if (declined) turn.declined.push(declined);
    } else if (raw.type === "authorization") {
      turn.authorization.push(String(raw.error ?? "sign-in required"));
    } else if (raw.type === "user_requested") {
      turn.userRequested.push(String(raw.reason ?? ""));
    }
    // Other types — state, direct_opened, ones from later versions — are skipped (8.5); state is read below.
  }
  if (typeof read.cursor === "string") state.cursor = read.cursor;
  turn.working = read.working === true;
  turn.closed = read.closed === true;
  turn.responder = typeof read.responder === "string" ? read.responder : turn.responder;
}
