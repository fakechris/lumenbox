/**
 * Conversations (docs/106 §4.2, docs/110 §2, INV-2214): what was said, as the page draws it, to a person who may reach the agent.
 *
 * A conversation is an agent's thread — `main`, an outside chat's, another — and a message is one entry the page draws of
 * it (web/transcript.ts `toDisplayEntries`, the page's own reading of the record), built here field by field. Never a prompt,
 * a tool's input or the words of a host note: a turn nobody typed is a `notice` by its label, a tool call is a step in words
 * (activity-phrase.ts, which shows the program and never the command), and a turn nobody asked for in this conversation (an
 * audit) is left out, as the page folds it away.
 *
 * Reach is the page's (reach.ts): a person reads the conversations of every agent in a box they may enter. A service token
 * reads none unless its view includes conversation text, and never writes (it has no `chat:write`).
 */

import { createHash } from "node:crypto";
import type { DisplayEntry } from "../transcript.ts";
import type { SendMessage, SendResult } from "../send-message.ts";
import type { Locale } from "../../i18n/locale.ts";
import type { AgentFact, Call } from "./frame.ts";
import { refuse } from "./frame.ts";
import { apiTime } from "./times.ts";
import { decodeCursor, encodeCursor, limitOf, sightOf } from "./visibility.ts";

/** One live event of a conversation, as the stream sends it (chat.ts maps the page's events to these). */
export type LiveEvent =
  | { kind: "text"; delta: string }
  | { kind: "step"; id?: string; tool: string; input?: unknown; state: "started" | "ended"; ok?: boolean }
  | { kind: "turn"; state: "started" | "ended" | "failed" | "stopped" }
  | { kind: "sent"; id: string };

/** An upload waiting to be sent with a message: what was put where, for whom. */
export interface UploadRecord {
  id: string; personId: string; conversationId: string; name: string; path: string; mimeType: string; kind: "image" | "voice" | "file"; sizeBytes: number; expiresAt: number;
}

/** What the conversation operations read and do (mount.ts wires it to the registry, the bus and the page's send path). */
export interface ChatAccess {
  /** An agent's conversations: `main` always, then the rest, each with when it was last written. */
  conversations(agentId: string): readonly { id: string; lastAt?: string }[];
  firstLine(agentId: string, conversation: string): string | undefined;
  kindOf(conversation: string): "main" | "chat" | "other";
  running(agentId: string, conversation: string): boolean;
  /** The current context's number and what the page draws of it. */
  display(agentId: string, conversation: string): { epoch: number; entries: readonly DisplayEntry[] };
  /** The page's own send path (send-message.ts). */
  send(input: SendMessage): Promise<SendResult>;
  /** The page's Stop, recorded with who. */
  stop(agentId: string, by: string): void;
  /** Into the conversation's inbox in the agent's sandbox, as a chat's file goes: where it landed, or why not. */
  store(agentId: string, conversation: string, file: { name: string; base64: string }, personId: string): Promise<{ name: string; path: string } | "no-box" | "refused">;
  uploads: { put(record: UploadRecord): void; get(id: string): UploadRecord | undefined };
  /** Live events of one conversation; answers how to stop listening. */
  watch(agentId: string, conversation: string, listener: (event: LiveEvent) => void): () => void;
  /** Writes `conversation` and `message` change records for what was written since the ledger last said. */
  note(): void;
}

// --- ids ---------------------------------------------------------------------------------------

/** A conversation's id: the agent and its thread, opaque to a client. */
export const conversationIdOf = (agentId: string, conversation: string): string => `c_${Buffer.from(`${agentId}\n${conversation}`).toString("base64url")}`;

export function conversationOfId(id: string): { agentId: string; conversation: string } | undefined {
  if (!id.startsWith("c_")) return undefined;
  const [agentId, conversation, ...rest] = Buffer.from(id.slice(2), "base64url").toString("utf8").split("\n");
  return agentId && conversation && rest.length === 0 && conversationIdOf(agentId, conversation) === id ? { agentId, conversation } : undefined;
}

const tagOf = (conversationId: string): string => createHash("sha256").update(conversationId).digest("base64url").slice(0, 16);
/** A message's id: its conversation (a digest, so ids from two conversations never meet), its context, and its place there. */
export const messageIdOf = (conversationId: string, epoch: number, at: readonly [number, number]): string => `m_${tagOf(conversationId)}_${epoch}_${at[0]}_${at[1]}`;
function placeOf(conversationId: string, id: string): { epoch: number; at: [number, number] } | undefined {
  const match = /^m_([A-Za-z0-9_-]{16})_(\d{1,9})_(\d{1,9})_(\d{1,4})$/.exec(id);
  return match === null || match[1] !== tagOf(conversationId) ? undefined : { epoch: Number(match[2]), at: [Number(match[3]), Number(match[4])] };
}
const after = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

// --- what the page draws, as messages -----------------------------------------------------------

type Built = { at: [number, number]; message: Record<string, unknown> };

/** The display entries as v1 messages, each with its place: entry, then the part of it (a tools entry is a steps line, cards and questions). */
export function messagesOf(conversationId: string, epoch: number, entries: readonly DisplayEntry[], locale: Locale, from = 0): Built[] {
  const built: Built[] = [];
  const add = (index: number, sub: number, fields: Record<string, unknown>) => {
    built.push({ at: [index, sub], message: { id: messageIdOf(conversationId, epoch, [index, sub]), conversationId, ...fields } });
  };
  for (let index = from; index < entries.length; index += 1) {
    const entry = entries[index]!;
    // A turn nobody asked for in this conversation: the page folds it away, and so does this.
    if (entry.background === true) continue;
    const at = "at" in entry && typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at)) ? { at: apiTime(entry.at) } : {};
    if (entry.kind === "text") {
      const from = entry.source !== undefined ? { from: entry.source } : {}, sent = entry.causedBy !== undefined && entry.causedBy.length > 0 ? { sentIds: [...entry.causedBy] } : {};
      const files = entry.files !== undefined && entry.files.length > 0 ? { files: entry.files.map(file => file.name) } : {};
      if (entry.role === "user") add(index, 0, { kind: "person", ...at, text: entry.text, ...from, ...sent });
      else add(index, 0, { kind: "agent", ...at, text: entry.text, ...(entry.aside === true ? { aside: true } : {}), ...files });
    } else if (entry.kind === "peer") {
      entry.messages.forEach((said, sub) => { add(index, sub, { kind: "teammate", ...at, from: said.from, text: said.text }); });
    } else if (entry.kind === "trigger") {
      add(index, 0, { kind: "notice", ...at, label: entry.label });
    } else if (entry.kind === "status") {
      add(index, 0, { kind: "status", ...at, text: entry.text });
    } else if (entry.kind === "tools") {
      let sub = 0, steps: string[] = [];
      const flush = () => { if (steps.length > 0) add(index, sub++, { kind: "steps", ...at, steps }); steps = []; };
      for (const tool of entry.tools) {
        if (tool.surface !== undefined) {
          flush();
          const { surfaceId, title, messages, close } = tool.surface;
          add(index, sub++, { kind: "card", ...at, card: { surfaceId, ...(title !== undefined ? { title } : {}), a2ui: JSON.stringify(messages), ...(close === true ? { closed: true } : {}) } });
        } else if (tool.question !== undefined) {
          flush();
          const { question, options, fallback } = tool.question;
          add(index, sub++, { kind: "question", ...at, question: { question, ...(options !== undefined ? { options: [...options] } : {}), ...(fallback !== undefined ? { fallback } : {}) } });
        } else {
          steps.push(tool.phrase?.[locale] ?? tool.name);
        }
      }
      flush();
    }
  }
  return built;
}

// --- reading -------------------------------------------------------------------------------------

/** The conversation a path names, if the caller may read it; 404 otherwise, as one that does not exist. */
export function conversationFor(call: Call, id: string): { id: string; agent: AgentFact; conversation: string } {
  const named = conversationOfId(id);
  const sight = sightOf(call);
  const agent = named === undefined ? undefined : call.deps.world.agents().find(fact => fact.id === named.agentId);
  if (named === undefined || agent === undefined || !sight.agent(agent.id) || !sight.text) return refuse("api-not-found");
  if (!call.deps.chat.conversations(agent.id).some(row => row.id === named.conversation)) return refuse("api-not-found");
  return { id, agent, conversation: named.conversation };
}

function conversationOf(call: Call, agent: AgentFact, row: { id: string; lastAt?: string }) {
  const { chat } = call.deps, { person, credential } = call.caller!, kind = chat.kindOf(row.id);
  const first = kind === "main" ? undefined : chat.firstLine(agent.id, row.id)?.trim().slice(0, 120);
  return {
    id: conversationIdOf(agent.id, row.id), agentId: agent.id, agentName: agent.name, kind, title: first !== undefined && first !== "" ? first : kind === "main" ? agent.name : row.id,
    ...(row.lastAt !== undefined && !Number.isNaN(Date.parse(row.lastAt)) ? { updatedAt: apiTime(row.lastAt) } : {}), running: chat.running(agent.id, row.id),
    canWrite: person.role !== "viewer" && credential.scopes.includes("chat:write"),
  };
}

const position = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string");
/** Newest first by when it was written, then by id: `[updatedAt or "", id]`. */
const before = (a: readonly [string, string], b: readonly [string, string]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1]);

export function listConversations(call: Call) {
  const sight = sightOf(call);
  const only = typeof call.params.agentId === "string" ? call.params.agentId : undefined;
  const filters = `conversations:${only ?? ""}`;
  // Conversation text is the whole of a conversation: a view without it lists none.
  const agents = sight.text ? call.deps.world.agents().filter(fact => !fact.hidden && sight.agent(fact.id) && (only === undefined || fact.id === only)) : [];
  const rows = agents.flatMap(agent => call.deps.chat.conversations(agent.id).map(row => ({ agent, row, key: [row.lastAt ?? "", conversationIdOf(agent.id, row.id)] as [string, string] })))
    .sort((a, b) => (before(a.key, b.key) ? -1 : 1));
  const from = decodeCursor(call.params.cursor, filters, position);
  const rest = from === undefined ? rows : rows.filter(row => before(from, row.key));
  const page = rest.slice(0, limitOf(call));
  return { items: page.map(entry => conversationOf(call, entry.agent, entry.row)), ...(rest.length > page.length ? { nextCursor: encodeCursor(page.at(-1)!.key, filters) } : {}) };
}

type Place = { d: "back" | "on"; e: number; p: [number, number] };
const isPlace = (value: unknown): value is Place => {
  const place = value as Place;
  return typeof value === "object" && value !== null && (place.d === "back" || place.d === "on") && Number.isSafeInteger(place.e) && Array.isArray(place.p) && place.p.length === 2 && place.p.every(Number.isSafeInteger);
};

export function listMessages(call: Call) {
  const found = conversationFor(call, String(call.params.id));
  const { epoch, entries } = call.deps.chat.display(found.agent.id, found.conversation);
  const all = messagesOf(found.id, epoch, entries, call.locale);
  const limit = limitOf(call), filters = `messages:${found.id}:${typeof call.params.after === "string" ? call.params.after : ""}`;
  const cursor = decodeCursor(call.params.cursor, filters, isPlace);
  // A cursor from an earlier context: the list it was paging is no longer the one shown.
  if (cursor !== undefined && cursor.e !== epoch) return refuse("api-cursor-invalid");
  let from: [number, number] | undefined;
  if (typeof call.params.after === "string") {
    const place = placeOf(found.id, call.params.after);
    if (place === undefined) return refuse("api-param-invalid", { name: "after", why: "a message of this conversation" });
    // One from an earlier context: everything in this one came after it.
    from = place.epoch === epoch ? place.at : undefined;
  }
  if (cursor?.d === "on" || (cursor === undefined && typeof call.params.after === "string")) {
    const start = cursor?.p ?? from;
    const rest = start === undefined ? all : all.filter(row => after(row.at, start));
    const page = rest.slice(0, limit);
    return { items: page.map(row => row.message), ...(rest.length > page.length ? { nextCursor: encodeCursor({ d: "on", e: epoch, p: page.at(-1)!.at }, filters) } : {}) };
  }
  // Without `after`: the newest, and the cursor goes back.
  const older = cursor === undefined ? all : all.filter(row => after(cursor.p, row.at));
  const page = older.slice(Math.max(0, older.length - limit));
  return { items: page.map(row => row.message), ...(older.length > page.length ? { nextCursor: encodeCursor({ d: "back", e: epoch, p: page[0]!.at }, filters) } : {}) };
}
