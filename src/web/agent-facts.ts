/**
 * The four facts a sidebar row is drawn from, per agent (INV-1625): when something last
 * happened, when the person last looked, how much they have not read, and whether the agent is
 * waiting on them. The conversation-state ledger keeps the first three; the fourth is read from
 * the things that actually wait — a pending approval, a question with a clock, a spend pause —
 * so it clears the moment the thing is answered, with no second record to drift.
 *
 * A row is one agent, so its conversations are folded: unread adds up, the newest activity
 * wins, and any conversation waiting makes the agent waiting. The marker order is the one a
 * person needs: blocked over unread over working.
 */

import { activityOfInbound, type Awaiting, type ConversationFacts, type ConversationState, rowMarker } from "../host/conversation-state.ts";

export interface AgentFactsDeps {
  /** Pending approvals, by agent. */
  approvals: () => readonly { agentId: string; description: string; requestedAt: string }[];
  /** Questions to a person still open, by agent and conversation. */
  questions: () => readonly { agentId: string; conversation: string; question: string; askedAt: number }[];
  /** Agents paused at their spend line (INV-1615). */
  pausedForSpend: () => readonly { agentId: string; day: string }[];
  /** Mid-turn right now. */
  working: (agentId: string) => boolean;
}

export interface AgentRowFacts {
  lastActivityAt?: string;
  lastViewedAt?: string;
  unreadCount: number;
  awaiting?: Awaiting;
  marker?: "blocked" | "unread" | "working";
}

export class AgentFacts {
  /** Conversations the agent has spoken in since its turn began, so a streamed reply counts once. */
  private readonly spoke = new Set<string>();

  constructor(readonly state: ConversationState, private readonly deps: AgentFactsDeps) {}

  /** A turn's events: the first prose of a turn in a conversation is the agent speaking; the turn's end resets. */
  noteTurnEvent(event: { type: string; agentId?: string; conversation?: string }): void {
    if (event.agentId === undefined) return;
    const conversation = event.conversation ?? "main";
    const key = `${event.agentId}\u0000${conversation}`;
    if (event.type === "text") {
      if (this.spoke.has(key)) return;
      this.spoke.add(key);
      this.state.note({ kind: "agentSaid", agentId: event.agentId, conversation });
    } else if (event.type === "turn_finished" || event.type === "turn_failed" || event.type === "turn_interrupted") {
      for (const had of [...this.spoke]) if (had.startsWith(`${event.agentId}\u0000`)) this.spoke.delete(had);
    }
  }

  /** A message on its way to the agent: the person's own words are activity; the host's and a teammate's are not. */
  noteInbound(agentId: string, conversation: string, message: { fromId: string; synthetic?: boolean; origin?: string; messageId?: string }): void {
    this.state.note({ kind: activityOfInbound(message), agentId, conversation });
  }

  /** What this agent waits on, from the records that wait: the newest reason wins. */
  awaitingFor(agentId: string, conversation?: string): Awaiting | undefined {
    const found: Awaiting[] = [];
    for (const approval of this.deps.approvals()) if (approval.agentId === agentId) found.push({ kind: "approval", reason: approval.description.replace(/\s+/g, " ").slice(0, 120), since: approval.requestedAt });
    for (const q of this.deps.questions()) if (q.agentId === agentId && (conversation === undefined || q.conversation === conversation)) found.push({ kind: "question", reason: q.question.slice(0, 120), since: new Date(q.askedAt).toISOString() });
    for (const paused of this.deps.pausedForSpend()) if (paused.agentId === agentId) found.push({ kind: "spend-limit", reason: `paused at its spend line for ${paused.day}`, since: `${paused.day}T00:00:00.000Z` });
    for (const facts of this.state.all()) if (facts.agentId === agentId && facts.awaiting !== undefined && (conversation === undefined || facts.conversation === conversation)) found.push(facts.awaiting);
    return found.sort((a, b) => b.since.localeCompare(a.since))[0];
  }

  /** The row's facts: the agent's conversations folded, and the marker. */
  forAgent(agentId: string): AgentRowFacts {
    const own = this.state.all().filter(facts => facts.agentId === agentId);
    const latest = (pick: (facts: ConversationFacts) => string | undefined): string | undefined =>
      own.map(pick).filter((at): at is string => at !== undefined).sort().at(-1);
    const unreadCount = own.reduce((sum, facts) => sum + facts.unreadCount, 0);
    const awaiting = this.awaitingFor(agentId);
    const marker = rowMarker({ unreadCount, ...(awaiting !== undefined ? { awaiting } : {}) }, this.deps.working(agentId));
    return {
      ...(latest(f => f.lastActivityAt) !== undefined ? { lastActivityAt: latest(f => f.lastActivityAt) } : {}),
      ...(latest(f => f.lastViewedAt) !== undefined ? { lastViewedAt: latest(f => f.lastViewedAt) } : {}),
      unreadCount,
      ...(awaiting !== undefined ? { awaiting } : {}),
      ...(marker !== undefined ? { marker } : {}),
    };
  }
}

/** The page's two writes: it looked at a conversation, or asked to be reminded of one. */
export async function agentFactsRoute(
  route: string,
  state: ConversationState,
  deps: { readJson: () => Promise<Record<string, unknown>>; refused: () => boolean; hasAgent: (id: string) => boolean }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "POST /api/agents/viewed" && route !== "POST /api/agents/unread") return undefined;
  if (deps.refused()) return { status: 0, body: null };
  const body = await deps.readJson();
  const id = String(body.id ?? "");
  if (!deps.hasAgent(id)) return { status: 404, body: { error: `No agent ${id}` } };
  const conversation = String(body.conversation ?? "main") || "main";
  return { status: 200, body: route === "POST /api/agents/viewed" ? state.viewed(id, conversation) : state.markUnread(id, conversation) };
}
