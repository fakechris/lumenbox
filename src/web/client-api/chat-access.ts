/**
 * What the conversation operations read and do, from the server's parts (mount.ts passes them): conversations and what the page
 * draws of them, the page's send path and Stop, a chat's files, and the page's events as they happen.
 *
 * Two things are made here from the page's events (server.ts `broadcast`):
 * - **the live stream** of one conversation: its words as they come, its steps, its turn starting and ending, a message taken —
 *   transient, to whoever has it on screen (`watch`);
 * - **change records** (`changes.jsonl`): a conversation that was sent in or written in is noted, and once its entries are read
 *   again each new message gets a `message` record, routed by its agent. A conversation the ledger has never named is noted
 *   once with no backlog of messages: a client fetches it whole. Never the words.
 */

import type { AgentRegistry } from "../../agents/registry.ts";
import { MAIN_CONVERSATION, conversationIdFor } from "../../agents/registry.ts";
import { mayEnterBox } from "../../box/membership.ts";
import type { BoxEntry } from "../../box/boxes.ts";
import type { BoxClient } from "../../box/client.ts";
import { chatFilesRoot } from "../../host/prompt.ts";
import type { SendMessage, SendResult } from "../send-message.ts";
import type { DisplayEntry } from "../transcript.ts";
import type { ChangeLedger, ChangeLine } from "./change-ledger.ts";
import { type ChatAccess, type LiveEvent, type UploadRecord, conversationIdOf, messagesOf } from "./conversations.ts";

/** The server's side: mount.ts is handed it. */
export interface ChatWorld {
  send(input: SendMessage): Promise<SendResult>;
  /** The page's Stop for an agent's turn, recorded with who. */
  stop(agentId: string, by: string): void;
  /** Whether the agent is in a turn in this conversation now. */
  active(agentId: string, conversation: string): boolean;
  /** What the page draws of a conversation (transcript.ts `toDisplayEntries`, as `GET /api/transcript` reads it). */
  display(agentId: string, conversation: string): readonly DisplayEntry[];
  /** The outside chat a conversation belongs to, when it belongs to one. */
  chatKeyFor(conversation: string): string | undefined;
  /** The box an agent's chat files are on, and a chat's way of putting files there (chat-files.ts). */
  boxOf(agentId: string): { client: BoxClient | undefined; box: BoxEntry };
  receiveFiles(chatKey: string, files: { name: string; base64: string }[], agent?: string, identity?: string): Promise<string[] | undefined>;
}

/** The page's events this reads; any other is passed by. */
type PageEvent = { type: string; agentId?: string; conversation?: string; delta?: unknown; tool?: unknown; input?: unknown; toolUseId?: unknown; isError?: unknown; messageId?: unknown };

const NOTE_MS = 2_000;
/** Events after which a conversation's record may have grown. */
const WRITES = new Set(["prompt", "turn_started", "turn_finished", "tool_end", "told", "aborted"]);

export function chatAccess(world: ChatWorld, registry: Pick<AgentRegistry, "listConversations" | "conversationFirstLine" | "contextStore">, changes: ChangeLedger, log: (line: string) => void) {
  const watchers = new Map<string, Set<(event: LiveEvent) => void>>();
  /** Conversations of each agent with a turn open, for the events that name only the agent. */
  const open = new Map<string, Set<string>>();
  const dirty = new Set<string>(), sentIn = new Set<string>();
  const keyOf = (agentId: string, conversation: string) => `${agentId}\n${conversation}`;
  const uploads = new Map<string, UploadRecord>();
  // The ledger's last word on each conversation: read once, then kept as it is written.
  const last = new Map<string, ChangeLine>(changes.lastOf("conversation"));

  const tell = (agentId: string, conversation: string, event: LiveEvent) => {
    for (const listener of watchers.get(keyOf(agentId, conversation)) ?? []) {
      try { listener(event); } catch (error) { log(`conversation stream: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  function live(event: PageEvent): void {
    const agentId = event.agentId;
    if (typeof agentId !== "string") return;
    // A turn that failed or was interrupted names only its agent: it ends what that agent had open.
    if (event.type === "turn_failed" || event.type === "turn_interrupted") {
      for (const conversation of open.get(agentId) ?? []) { tell(agentId, conversation, { kind: "turn", state: event.type === "turn_failed" ? "failed" : "stopped" }); dirty.add(keyOf(agentId, conversation)); }
      open.delete(agentId);
      return;
    }
    const conversation = typeof event.conversation === "string" && event.conversation !== "" ? event.conversation : MAIN_CONVERSATION;
    if (WRITES.has(event.type)) {
      const key = keyOf(agentId, conversation);
      // A conversation the ledger has not named yet is named now, before this event's writes, so they come as messages.
      if (!last.has(conversationIdOf(agentId, conversation))) noteOne(key, false);
      dirty.add(key);
    }
    const turns = open.get(agentId) ?? new Set<string>();
    if (event.type === "turn_started") { turns.add(conversation); open.set(agentId, turns); tell(agentId, conversation, { kind: "turn", state: "started" }); }
    else if (event.type === "turn_finished" || event.type === "aborted") { turns.delete(conversation); tell(agentId, conversation, { kind: "turn", state: event.type === "aborted" ? "stopped" : "ended" }); }
    else if (event.type === "text" && typeof event.delta === "string") tell(agentId, conversation, { kind: "text", delta: event.delta });
    else if (event.type === "tool_start" || event.type === "tool_end") {
      tell(agentId, conversation, {
        kind: "step", tool: String(event.tool ?? "tool"), state: event.type === "tool_start" ? "started" : "ended", ...(typeof event.toolUseId === "string" ? { id: event.toolUseId } : {}),
        ...(event.type === "tool_start" ? { input: event.input } : { ok: event.isError !== true }),
      });
    } else if (event.type === "prompt" && typeof event.messageId === "string") {
      sentIn.add(keyOf(agentId, conversation));
      tell(agentId, conversation, { kind: "sent", id: event.messageId });
    }
  }

  /** What was written since the ledger last said, per conversation touched: its record, and a record per new message. */
  function note(): void {
    for (const key of [...dirty]) { dirty.delete(key); noteOne(key, sentIn.delete(key)); }
  }
  function noteOne(key: string, sent: boolean): void {
    const [agentId, conversation] = key.split("\n") as [string, string];
    try {
      const id = conversationIdOf(agentId, conversation), epoch = registry.contextStore(agentId, conversation).current().epoch;
      const entries = world.display(agentId, conversation), through = `${epoch}:${entries.length}`, before = last.get(id);
      if (before !== undefined && before.through === through && !sent) return;
      if (before !== undefined) {
        const [was, length] = (before.through ?? "0:0").split(":").map(Number) as [number, number];
        for (const row of messagesOf(id, epoch, entries, "en", was === epoch ? length : 0)) changes.append({ type: "message", id: String(row.message.id), op: "upsert", assigneeId: agentId, conversationId: id });
      }
      last.set(id, changes.append({ type: "conversation", id, op: "upsert", assigneeId: agentId, through }));
    } catch (error) {
      log(`conversation changes: ${conversation} of ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const timer = setInterval(note, NOTE_MS);
  timer.unref();

  const access: ChatAccess = {
    conversations: agentId => registry.listConversations(agentId),
    firstLine: (agentId, conversation) => registry.conversationFirstLine(agentId, conversation),
    kindOf: conversation => (conversation === MAIN_CONVERSATION ? "main" : world.chatKeyFor(conversation) !== undefined ? "chat" : "other"),
    running: (agentId, conversation) => world.active(agentId, conversation),
    display: (agentId, conversation) => ({ epoch: registry.contextStore(agentId, conversation).current().epoch, entries: world.display(agentId, conversation) }),
    send: input => world.send(input),
    stop: (agentId, by) => world.stop(agentId, by),
    store: async (agentId, conversation, file, personId) => {
      const { client, box } = world.boxOf(agentId);
      if (client === undefined) return "no-box";
      if (!mayEnterBox(box, personId)) return "refused";
      // Where a chat's file goes, under a name that never overwrites (chat-files.ts): the conversation's inbox in the agent's box.
      const saved = (await world.receiveFiles(conversation, [file], agentId, personId))?.[0];
      if (saved === undefined) return "refused";
      const name = saved.replace(/^inbox\//, "");
      return { name, path: `${chatFilesRoot(conversationIdFor(conversation), box)}/inbox/${name}` };
    },
    uploads: {
      put: record => { const now = Date.now(); for (const [id, kept] of uploads) if (kept.expiresAt < now) uploads.delete(id); uploads.set(record.id, record); },
      get: id => uploads.get(id),
    },
    watch: (agentId, conversation, listener) => {
      const key = keyOf(agentId, conversation), set = watchers.get(key) ?? new Set();
      set.add(listener);
      watchers.set(key, set);
      return () => { set.delete(listener); if (set.size === 0) watchers.delete(key); };
    },
    note,
  };
  return { access, live, close: () => { clearInterval(timer); watchers.clear(); } };
}
