/**
 * The four facts a person needs about each conversation before opening it (INV-1625):
 * when it last moved, when they last looked, how much arrived in between, and whether the
 * agent is waiting on them.
 *
 * On 2026-11-05 two commands sat waiting for consent for a day, and the person found them by
 * opening chats one by one: the agent list knew only "busy". A list that answers "what needs
 * me" needs state per conversation that outlives the page and the process, so it lives here, in
 * one ledger under the home, and the page reads it rather than inferring it.
 *
 * What counts as activity is the whole point, so it is a rule and not a judgement:
 * - the agent said something to the person, a message came in through a door, or the person
 *   spoke: activity — the row floats and, unless the person was looking, the count goes up;
 * - a teammate's message, a host-written prompt (origin `host:*`), a tool call, a job ending:
 *   **not** activity. Agents talk to each other all day; if that floated rows and raised
 *   counts, the list would again say nothing about the person.
 * The person's own message counts as activity (the conversation moved) but never as unread.
 *
 * Awaiting is separate from unread, and wins over it on the row: a conversation the person has
 * read but whose agent is parked on an approval is blocked, not quiet. It is set and cleared by
 * whoever knows — the policy gate, the question watch, the handoff, the spend line — this module
 * only keeps it, and clears it when the person speaks, because an answer in the chat is an
 * answer.
 *
 * Viewed is a moment, not a scroll position: opening the conversation while the window is
 * focused, or the window regaining focus on it, marks it viewed and clears the count; a message
 * that arrives while the person is looking is read as it lands. "Mark as unread" puts one back.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendLine, type LedgerKind } from "./jsonl.ts";

/** A state ledger: the file is a log of changes, rewritten as one line per conversation when it grows. */
export const LEDGER_KIND: LedgerKind = "state";

/** Lines past which the ledger is rewritten as its current state. */
export const COMPACT_AT = 5_000;

export type ActivityKind = "agentSaid" | "channelIn" | "personSaid";
/** Arrivals that never count: kept as a type so a caller cannot pass one by mistake. */
export type QuietKind = "peerMessage" | "hostPrompt";
export type AwaitingKind = "approval" | "question" | "handoff" | "spend-limit" | "provider-resting";

export interface Awaiting {
  kind: AwaitingKind;
  /** One line for the row: "Waiting for you: {reason}". */
  reason: string;
  since: string;
}

export interface ConversationFacts {
  agentId: string;
  conversation: string;
  lastActivityAt?: string;
  lastViewedAt?: string;
  unreadCount: number;
  awaiting?: Awaiting;
}

export interface ActivityEvent {
  kind: ActivityKind | QuietKind;
  agentId: string;
  conversation: string;
  at?: string;
  /** True when the person had this conversation open in a focused window: read as it lands. */
  looking?: boolean;
}

type Line =
  | { kind: "activity"; agentId: string; conversation: string; at: string; unread: boolean }
  | { kind: "viewed"; agentId: string; conversation: string; at: string }
  | { kind: "unread"; agentId: string; conversation: string; at: string }
  | { kind: "awaiting"; agentId: string; conversation: string; awaiting: Awaiting | null }
  | { kind: "state"; facts: ConversationFacts };

const key = (agentId: string, conversation: string): string => `${agentId}\u0000${conversation}`;

export class ConversationState {
  private readonly facts = new Map<string, ConversationFacts>();
  private lines = 0;

  constructor(private readonly path?: string, private readonly now: () => Date = () => new Date()) {
    if (path !== undefined) this.restore(path);
  }

  /** Something arrived or was said. Quiet kinds are accepted and change nothing, so a caller needs no branch. */
  note(event: ActivityEvent): ConversationFacts {
    if (event.kind === "peerMessage" || event.kind === "hostPrompt") return this.summary(event.agentId, event.conversation);
    const at = event.at ?? this.now().toISOString();
    const unread = event.kind !== "personSaid" && event.looking !== true;
    this.write({ kind: "activity", agentId: event.agentId, conversation: event.conversation, at, unread });
    // The person spoke: whatever the agent was waiting for, the chat now has an answer.
    if (event.kind === "personSaid" && this.summary(event.agentId, event.conversation).awaiting !== undefined) this.setAwaiting(event.agentId, event.conversation, undefined);
    return this.summary(event.agentId, event.conversation);
  }

  /** The person looked: opened the conversation while focused, or focus came back to it. */
  viewed(agentId: string, conversation: string, at = this.now().toISOString()): ConversationFacts {
    this.write({ kind: "viewed", agentId, conversation, at });
    return this.summary(agentId, conversation);
  }

  /** The person wants to come back to this: one unread, and the view time moved behind the last activity. */
  markUnread(agentId: string, conversation: string): ConversationFacts {
    this.write({ kind: "unread", agentId, conversation, at: this.now().toISOString() });
    return this.summary(agentId, conversation);
  }

  /** What the agent waits on the person for, or nothing. Set by whoever knows; the same awaiting twice is written once. */
  setAwaiting(agentId: string, conversation: string, awaiting: Awaiting | undefined): ConversationFacts {
    const current = this.summary(agentId, conversation).awaiting;
    if (sameAwaiting(current, awaiting)) return this.summary(agentId, conversation);
    this.write({ kind: "awaiting", agentId, conversation, awaiting: awaiting ?? null });
    return this.summary(agentId, conversation);
  }

  summary(agentId: string, conversation: string): ConversationFacts {
    const found = this.facts.get(key(agentId, conversation));
    return found !== undefined ? { ...found, ...(found.awaiting !== undefined ? { awaiting: { ...found.awaiting } } : {}) } : { agentId, conversation, unreadCount: 0 };
  }

  /** Every conversation with a fact on it, for the roster. */
  all(): ConversationFacts[] {
    return [...this.facts.values()].map(facts => ({ ...facts }));
  }

  /** Whether the conversation has something the person has not seen. */
  hasUnread(agentId: string, conversation: string): boolean {
    const facts = this.summary(agentId, conversation);
    return facts.unreadCount > 0 || (facts.lastActivityAt !== undefined && (facts.lastViewedAt === undefined || facts.lastActivityAt > facts.lastViewedAt));
  }

  private write(line: Line): void {
    this.apply(line);
    if (this.path === undefined) return;
    try {
      appendLine(this.path, JSON.stringify(line));
      this.lines += 1;
      if (this.lines > COMPACT_AT) this.compact();
    } catch {
      // A ledger that cannot write still answers for this process.
    }
  }

  private apply(line: Line): void {
    if (line.kind === "state") {
      this.facts.set(key(line.facts.agentId, line.facts.conversation), { ...line.facts, unreadCount: line.facts.unreadCount ?? 0 });
      return;
    }
    const k = key(line.agentId, line.conversation);
    const facts = this.facts.get(k) ?? { agentId: line.agentId, conversation: line.conversation, unreadCount: 0 };
    switch (line.kind) {
      case "activity":
        facts.lastActivityAt = line.at;
        if (line.unread) facts.unreadCount += 1;
        else facts.lastViewedAt = line.at; // the person was looking, or speaking: seen as it lands
        break;
      case "viewed":
        facts.lastViewedAt = line.at;
        facts.unreadCount = 0;
        break;
      case "unread":
        facts.unreadCount = Math.max(facts.unreadCount, 1);
        // The view time steps behind the last activity, so "new since you" has something to sit above.
        if (facts.lastActivityAt !== undefined) facts.lastViewedAt = new Date(Date.parse(facts.lastActivityAt) - 1).toISOString();
        break;
      case "awaiting":
        if (line.awaiting === null) delete facts.awaiting;
        else facts.awaiting = { ...line.awaiting };
        break;
    }
    this.facts.set(k, facts);
  }

  /** The file as one line per conversation: the state is what matters, not the history of clicks. */
  private compact(): void {
    if (this.path === undefined) return;
    const lines = [...this.facts.values()].map(facts => JSON.stringify({ kind: "state", facts } satisfies Line));
    writeFileSync(this.path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    this.lines = lines.length;
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const text of raw.split("\n")) {
      if (text.trim() === "") continue;
      try {
        this.apply(JSON.parse(text) as Line);
        this.lines += 1;
      } catch {
        // A torn line is skipped; the facts before and after it still hold.
      }
    }
  }
}

function sameAwaiting(a: Awaiting | undefined, b: Awaiting | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.reason === b.reason;
}

/** The row's one marker, in the order that matters to a person: blocked beats unread beats working. */
export function rowMarker(facts: Pick<ConversationFacts, "unreadCount" | "awaiting">, working: boolean): "blocked" | "unread" | "working" | undefined {
  if (facts.awaiting !== undefined) return "blocked";
  if (facts.unreadCount > 0) return "unread";
  return working ? "working" : undefined;
}

/** What an inbound bus message is to this ledger: the person's words, a door's, a teammate's, or the host's own. */
export function activityOfInbound(message: { fromId: string; synthetic?: boolean; origin?: string; messageId?: string }): ActivityKind | QuietKind {
  if (message.synthetic === true || message.origin !== undefined) return "hostPrompt";
  // A message with the door's own id came through a door (INV-613); the web and MCP mint none.
  if (message.fromId === "user") return message.messageId !== undefined ? "channelIn" : "personSaid";
  return "peerMessage";
}
