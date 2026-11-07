/**
 * The guest desk (INV-1708, docs/97): what an organisation decided about guests, and what its
 * agents did for them.
 *
 * Kept apart from everything a member turn reads:
 *
 *   - **who each agent answers in group chats**: `members` (the default) or `guests`;
 *   - **the knowledge public to guests**, in named **knowledge collections** (知识集, INV-1713):
 *     entries an Admin wrote, each a title and a text, each in one collection. It is not memory
 *     and nothing copies into it by itself; only an Admin adds or removes an entry. Each agent
 *     ticks the collections it may use, and a guest turn of that agent reads those and no other
 *     (`viewFor`). The default collection, 组织通用 (`general`), holds every entry written before
 *     collections existed, and an agent nobody ticked uses it — the old single list, migrated by
 *     reading it;
 *   - **the short window** (INV-1713): a guest's last few questions and answers in one group
 *     chat, in memory only, per group chat and guest, gone when they expire or the host restarts.
 *     Never a transcript, never memory, never another guest's;
 *   - **the guest turns**: one line per turn in `guest-turns.jsonl`, the guest's record, which no
 *     transcript, memory or board ever reads. The per-group daily cap is counted from it, so a
 *     restart keeps the count;
 *   - **the reviews** (INV-1713): one line per verdict on a guest answer in `guest-reviews.jsonl`,
 *     and whether a group chat holds answers until the review passes (先审后发).
 *
 * The settings and the knowledge are one `state` ledger, `guests.jsonl`, replayed on start: a
 * later line for the same agent or the same entry replaces the earlier one.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLine } from "./jsonl.ts";
import { rankRelated } from "./memory-relevance.ts";
import type { MemoryRecord } from "./memory.ts";
import { dayOf } from "./spend-limits.ts";

/** Who an agent answers in group chats. */
export type GuestAnswerMode = "members" | "guests";

export const GUEST_ANSWER_MODES: readonly GuestAnswerMode[] = ["members", "guests"];

/** Guest turns per group chat per local day, when an Admin has not set the number. */
export const DEFAULT_GUEST_TURNS_PER_DAY = 20;

/** An entry of the knowledge public to guests. */
export interface GuestKnowledgeEntry {
  id: string;
  title: string;
  text: string;
  at: string;
  by: string;
  /** Its knowledge collection; absent on an entry written before collections (INV-1713), which is 组织通用's. */
  collection?: string;
}

/** The default knowledge collection, 组织通用: the old single list, and what an unticked agent uses. */
export const GENERAL_COLLECTION = "general";

/** A knowledge collection (知识集). The default one's name is empty until an Admin names it: the page says 组织通用 / General. */
export interface GuestCollection {
  id: string;
  name: string;
  at: string;
  by: string;
}

/** One question and its answer in a guest's short window. */
export interface GuestExchange {
  at: string;
  question: string;
  answer: string;
}

/** The short window, when an Admin has not set it: 5 exchanges or 30 minutes, whichever ends first. */
export const DEFAULT_GUEST_WINDOW = { exchanges: 5, minutes: 30 } as const;
/** The most an Admin can extend it to. 0 exchanges turns it off. */
export const GUEST_WINDOW_LIMIT = { exchanges: 20, minutes: 24 * 60 } as const;

/** What happened to a reviewed answer: sent and reviewed after (`shadow`), passed and sent, held for an Admin, then approved or discarded. */
export type GuestReviewStatus = "shadow" | "sent" | "held" | "approved" | "discarded";

/** A verdict on a guest answer, as its line in `guest-reviews.jsonl` says it. */
export interface GuestReview {
  at: string;
  turnId: string;
  category: string;
  confidence: number;
  reason: string;
  /** Red in the audit list: anything but PASS and UNKNOWN, so PROMISE and NOT_IN_KNOWLEDGE among them. */
  flagged: boolean;
  status: GuestReviewStatus;
  by?: string;
  /** A held answer, whole, so approving it sends what the turn wrote. */
  answer?: string;
}

/** A guest turn as the audit list shows it: the turn's line and its latest review. */
export interface GuestAuditRow extends GuestTurnRecord {
  review?: GuestReview;
}

/** A category the review raises a flag for. */
export function flaggedCategory(category: string): boolean {
  return category !== "PASS" && category !== "UNKNOWN";
}

/** What one guest turn did, as its line in `guest-turns.jsonl` says it. */
export interface GuestTurnRecord {
  at: string;
  /** Always `guest`: the line says whose record it is, in the file and wherever it is copied. */
  source: "guest";
  turnId: string;
  agentId: string;
  agentName: string;
  door: string;
  chatKey: string;
  identity: string;
  senderLabel: string;
  question: string;
  answer: string;
  offered: string[];
  calls: { name: string; ran: boolean }[];
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  outcome: "answered" | "rounds" | "spend" | "error" | "over-cap";
}

type Line =
  | { kind: "answers"; at: string; by: string; agentId: string; mode: GuestAnswerMode }
  | { kind: "cap"; at: string; by: string; perGroupPerDay: number }
  | { kind: "knowledge"; at: string; by: string; entry: GuestKnowledgeEntry }
  | { kind: "knowledge-removed"; at: string; by: string; id: string }
  | { kind: "collection"; at: string; by: string; collection: GuestCollection }
  | { kind: "collection-removed"; at: string; by: string; id: string }
  | { kind: "ticks"; at: string; by: string; agentId: string; collections: string[] }
  | { kind: "window"; at: string; by: string; exchanges: number; minutes: number }
  | { kind: "hold"; at: string; by: string; door: string; chatKey: string; hold: boolean };

/** Clipped so a guest who pastes a novel does not grow the record without bound. */
const CLIP = 2_000;
const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);

export class GuestDesk {
  private readonly modes = new Map<string, GuestAnswerMode>();
  private readonly entries = new Map<string, GuestKnowledgeEntry>();
  private readonly collectionsById = new Map<string, GuestCollection>([[GENERAL_COLLECTION, { id: GENERAL_COLLECTION, name: "", at: "", by: "" }]]);
  private readonly ticks = new Map<string, string[]>();
  private perGroupPerDay = DEFAULT_GUEST_TURNS_PER_DAY;
  private windowLimits: { exchanges: number; minutes: number } = { ...DEFAULT_GUEST_WINDOW };
  /** The short windows, per `door\0chat\0guest`: memory only, so a restart forgets them. */
  private readonly windows = new Map<string, GuestExchange[]>();
  /** Group chats that hold answers until the review passes, per `door\0chat`. */
  private readonly holds = new Set<string>();
  private readonly turns: GuestTurnRecord[] = [];
  /** The latest review of each turn. */
  private readonly reviews = new Map<string, GuestReview>();
  /** Guest turns per `day\0door\0chat`, counted from the turns ledger. */
  private readonly counts = new Map<string, number>();
  /** Group chats already told today that the cap was reached. */
  private readonly told = new Set<string>();

  constructor(
    private readonly paths: { settings?: string; turns?: string; reviews?: string } = {},
    private readonly now: () => Date = () => new Date()
  ) {
    for (const line of readLines(paths.settings)) this.apply(line as Line);
    for (const line of readLines(paths.turns)) {
      const turn = line as Partial<GuestTurnRecord>;
      if (typeof turn.at !== "string" || typeof turn.door !== "string" || typeof turn.chatKey !== "string") continue;
      this.turns.push(turn as GuestTurnRecord);
      if (turn.outcome === "over-cap") continue;
      const key = this.keyFor(turn.door, turn.chatKey, new Date(turn.at));
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
    for (const line of readLines(paths.reviews)) {
      const review = line as Partial<GuestReview>;
      if (typeof review.turnId === "string" && typeof review.category === "string") this.reviews.set(review.turnId, review as GuestReview);
    }
  }

  modeOf(agentId: string): GuestAnswerMode {
    return this.modes.get(agentId) ?? "members";
  }

  setMode(agentId: string, mode: GuestAnswerMode, by: string): GuestAnswerMode {
    if (!GUEST_ANSWER_MODES.includes(mode)) throw new Error(`Unknown answer mode ${String(mode)}`);
    this.write({ kind: "answers", at: this.now().toISOString(), by, agentId, mode });
    return this.modeOf(agentId);
  }

  cap(): number {
    return this.perGroupPerDay;
  }

  setCap(perGroupPerDay: number, by: string): number {
    if (!Number.isInteger(perGroupPerDay) || perGroupPerDay < 1) throw new Error("perGroupPerDay must be a whole number of at least 1");
    this.write({ kind: "cap", at: this.now().toISOString(), by, perGroupPerDay });
    return this.perGroupPerDay;
  }

  /** The knowledge public to guests, in every collection, oldest first. */
  knowledge(): GuestKnowledgeEntry[] {
    return [...this.entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  entry(id: string): GuestKnowledgeEntry | undefined {
    return this.entries.get(id);
  }

  /** The knowledge collections, the default one first. */
  collections(): GuestCollection[] {
    const all = [...this.collectionsById.values()];
    return [all[0]!, ...all.slice(1).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))];
  }

  addCollection(name: string, by: string): GuestCollection {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("A knowledge collection needs a name");
    const collection: GuestCollection = { id: `k${randomUUID().slice(0, 8)}`, name: trimmed.slice(0, 80), at: this.now().toISOString(), by };
    this.write({ kind: "collection", at: collection.at, by, collection });
    return collection;
  }

  renameCollection(id: string, name: string, by: string): GuestCollection | undefined {
    const current = this.collectionsById.get(id);
    const trimmed = name.trim();
    if (current === undefined) return undefined;
    if (trimmed === "") throw new Error("A knowledge collection needs a name");
    this.write({ kind: "collection", at: this.now().toISOString(), by, collection: { ...current, name: trimmed.slice(0, 80) } });
    return this.collectionsById.get(id);
  }

  /** Removes a collection and its entries. The default one stays: it is where the old list lives and what an unticked agent uses. */
  removeCollection(id: string, by: string): boolean {
    if (id === GENERAL_COLLECTION || !this.collectionsById.has(id)) return false;
    this.write({ kind: "collection-removed", at: this.now().toISOString(), by, id });
    return true;
  }

  /** The collections an agent may use in a guest turn; 组织通用 until an Admin ticks others. */
  ticksOf(agentId: string): string[] {
    return (this.ticks.get(agentId) ?? [GENERAL_COLLECTION]).filter(id => this.collectionsById.has(id));
  }

  setTicks(agentId: string, collections: readonly string[], by: string): string[] {
    const unknown = collections.filter(id => !this.collectionsById.has(id));
    if (unknown.length > 0) throw new Error(`No knowledge collection ${unknown.join(", ")}`);
    this.write({ kind: "ticks", at: this.now().toISOString(), by, agentId, collections: [...new Set(collections)] });
    return this.ticksOf(agentId);
  }

  /**
   * What one agent's guest turn may read: the entries of the collections it ticked, and nothing
   * else — `entry` answers undefined for an id in another collection, `search` never ranks one.
   */
  viewFor(agentId: string): { knowledge(): GuestKnowledgeEntry[]; entry(id: string): GuestKnowledgeEntry | undefined; search(query: string, limit?: number): GuestKnowledgeEntry[] } {
    const ticked = new Set(this.ticksOf(agentId));
    const visible = () => this.knowledge().filter(entry => ticked.has(entry.collection ?? GENERAL_COLLECTION));
    return {
      knowledge: visible,
      entry: id => visible().find(entry => entry.id === id),
      search: (query, limit = 5) => searchIn(visible(), query, limit),
    };
  }

  addKnowledge(input: { title: string; text: string; collection?: string }, by: string): GuestKnowledgeEntry {
    const title = input.title.trim();
    const text = input.text.trim();
    const collection = input.collection ?? GENERAL_COLLECTION;
    if (title === "" || text === "") throw new Error("An entry needs a title and a text");
    if (!this.collectionsById.has(collection)) throw new Error(`No knowledge collection ${collection}`);
    const entry: GuestKnowledgeEntry = { id: `g${randomUUID().slice(0, 8)}`, title: title.slice(0, 200), text: text.slice(0, 20_000), at: this.now().toISOString(), by, collection };
    this.write({ kind: "knowledge", at: entry.at, by, entry });
    return entry;
  }

  removeKnowledge(id: string, by: string): boolean {
    if (!this.entries.has(id)) return false;
    this.write({ kind: "knowledge-removed", at: this.now().toISOString(), by, id });
    return true;
  }

  /** The entries best related to a query, best first, over every collection. A guest turn searches `viewFor(agent)` instead. */
  search(query: string, limit = 5): GuestKnowledgeEntry[] {
    return searchIn(this.knowledge(), query, limit);
  }

  /** The short window's limits. `exchanges` 0 means off. */
  window(): { exchanges: number; minutes: number } {
    return { ...this.windowLimits };
  }

  setWindow(exchanges: number, minutes: number, by: string): { exchanges: number; minutes: number } {
    if (!Number.isInteger(exchanges) || exchanges < 0 || exchanges > GUEST_WINDOW_LIMIT.exchanges) throw new Error(`exchanges must be a whole number from 0 to ${GUEST_WINDOW_LIMIT.exchanges}`);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > GUEST_WINDOW_LIMIT.minutes) throw new Error(`minutes must be a whole number from 1 to ${GUEST_WINDOW_LIMIT.minutes}`);
    this.write({ kind: "window", at: this.now().toISOString(), by, exchanges, minutes });
    return this.window();
  }

  /** This guest's last exchanges in this group chat, oldest first, within the window; expired ones are dropped here. */
  windowFor(door: string, chatKey: string, identity: string): GuestExchange[] {
    this.sweep();
    return [...(this.windows.get(windowKey(door, chatKey, identity)) ?? [])];
  }

  /** Keeps an exchange the guest saw in their window. Nothing else reads it. */
  remember(door: string, chatKey: string, identity: string, question: string, answer: string): void {
    if (this.windowLimits.exchanges === 0) return;
    const key = windowKey(door, chatKey, identity);
    this.windows.set(key, [...(this.windows.get(key) ?? []), { at: this.now().toISOString(), question: clip(question), answer: clip(answer) }]);
    this.sweep();
  }

  /** Whether this group chat holds a guest answer until the review passes (先审后发). */
  holdsIn(door: string, chatKey: string): boolean {
    return this.holds.has(`${door}\0${chatKey}`);
  }

  setHold(door: string, chatKey: string, hold: boolean, by: string): boolean {
    this.write({ kind: "hold", at: this.now().toISOString(), by, door, chatKey, hold });
    return this.holdsIn(door, chatKey);
  }

  /** Writes a review's line: the verdict on a guest answer and what happened to it. */
  recordReview(review: Omit<GuestReview, "at" | "flagged">): GuestReview {
    const full: GuestReview = { at: this.now().toISOString(), ...review, flagged: flaggedCategory(review.category) };
    this.reviews.set(full.turnId, full);
    if (this.paths.reviews !== undefined) {
      mkdirSync(dirname(this.paths.reviews), { recursive: true });
      appendLine(this.paths.reviews, JSON.stringify(full));
    }
    return full;
  }

  reviewOf(turnId: string): GuestReview | undefined {
    return this.reviews.get(turnId);
  }

  /**
   * Settles a held answer: `approved` keeps the verdict, records who approved it, and puts the
   * exchange in the guest's window (the caller has sent it); `discarded` sends nothing. Undefined
   * when the turn is not held.
   */
  settle(turnId: string, status: "approved" | "discarded", by: string): { turn: GuestTurnRecord; answer: string } | undefined {
    const review = this.reviews.get(turnId);
    const turn = this.turns.find(line => line.turnId === turnId);
    if (review?.status !== "held" || turn === undefined) return undefined;
    const answer = review.answer ?? turn.answer;
    this.recordReview({ turnId, category: review.category, confidence: review.confidence, reason: review.reason, status, by });
    if (status === "approved") this.remember(turn.door, turn.chatKey, turn.identity, turn.question, answer);
    return { turn, answer };
  }

  /** The held answer of a turn, whole, or undefined when the turn is not held. */
  held(turnId: string): { turn: GuestTurnRecord; answer: string } | undefined {
    const review = this.reviews.get(turnId);
    const turn = this.turns.find(line => line.turnId === turnId);
    return review?.status === "held" && turn !== undefined ? { turn, answer: review.answer ?? turn.answer } : undefined;
  }

  /** The audit list: guest turns with their latest review, newest first, narrowed by group chat, agent, time and the red flag. */
  audit(filter: { chatKey?: string; agentId?: string; since?: string; flagged?: boolean; held?: boolean; limit?: number } = {}): GuestAuditRow[] {
    const rows: GuestAuditRow[] = [];
    for (let i = this.turns.length - 1; i >= 0 && rows.length < (filter.limit ?? 200); i--) {
      const turn = this.turns[i]!;
      const review = this.reviews.get(turn.turnId);
      if (filter.chatKey !== undefined && turn.chatKey !== filter.chatKey) continue;
      if (filter.agentId !== undefined && turn.agentId !== filter.agentId) continue;
      if (filter.since !== undefined && turn.at < filter.since) continue;
      if (filter.flagged === true && review?.flagged !== true) continue;
      if (filter.held === true && review?.status !== "held") continue;
      rows.push(review === undefined ? { ...turn } : { ...turn, review });
    }
    return rows;
  }

  /** Every group chat that has had a guest turn or holds answers, with whether it holds them. */
  groups(): { door: string; chatKey: string; hold: boolean }[] {
    const seen = new Map<string, { door: string; chatKey: string }>();
    for (const turn of this.turns) seen.set(`${turn.door}\0${turn.chatKey}`, { door: turn.door, chatKey: turn.chatKey });
    for (const key of this.holds) { const [door, chatKey] = key.split("\0") as [string, string]; seen.set(key, { door, chatKey }); }
    return [...seen.values()].map(group => ({ ...group, hold: this.holdsIn(group.door, group.chatKey) })).sort((a, b) => a.chatKey.localeCompare(b.chatKey));
  }

  /** Guest turns this group chat has had today. */
  turnsToday(door: string, chatKey: string): number {
    return this.counts.get(this.keyFor(door, chatKey, this.now())) ?? 0;
  }

  /**
   * Whether this group chat may have another guest turn today. Past the cap, the first refusal of
   * the day says so (`notify`), and every later one is silent.
   */
  admit(door: string, chatKey: string): "yes" | "notify" | "silent" {
    const key = this.keyFor(door, chatKey, this.now());
    if ((this.counts.get(key) ?? 0) < this.perGroupPerDay) return "yes";
    if (this.told.has(key)) return "silent";
    this.told.add(key);
    return "notify";
  }

  /** Writes a guest turn's line; one that ran counts toward the group chat's day. */
  recordTurn(record: Omit<GuestTurnRecord, "at" | "source">): GuestTurnRecord {
    const full: GuestTurnRecord = { at: this.now().toISOString(), source: "guest", ...record, question: clip(record.question), answer: clip(record.answer) };
    this.turns.push(full);
    if (full.outcome !== "over-cap") {
      const key = this.keyFor(full.door, full.chatKey, new Date(full.at));
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
    if (this.paths.turns !== undefined) {
      mkdirSync(dirname(this.paths.turns), { recursive: true });
      appendLine(this.paths.turns, JSON.stringify(full));
    }
    return full;
  }

  /** The most recent guest turns, newest last, for the page. */
  recentTurns(limit = 50): GuestTurnRecord[] {
    return this.turns.slice(-limit);
  }

  /** Drops every exchange older than the window and keeps the last `exchanges` of each, whichever ends first. */
  private sweep(): void {
    const { exchanges, minutes } = this.windowLimits;
    const oldest = new Date(this.now().getTime() - minutes * 60_000).toISOString();
    for (const [key, list] of this.windows) {
      const kept = exchanges === 0 ? [] : list.filter(exchange => exchange.at >= oldest).slice(-exchanges);
      if (kept.length === 0) this.windows.delete(key);
      else this.windows.set(key, kept);
    }
  }

  private keyFor(door: string, chatKey: string, at: Date): string {
    return `${dayOf(at)}\0${door}\0${chatKey}`;
  }

  private write(line: Line): void {
    this.apply(line);
    if (this.paths.settings === undefined) return;
    mkdirSync(dirname(this.paths.settings), { recursive: true });
    appendLine(this.paths.settings, JSON.stringify(line));
  }

  private apply(line: Line): void {
    if (line.kind === "answers" && GUEST_ANSWER_MODES.includes(line.mode)) {
      if (line.mode === "members") this.modes.delete(line.agentId);
      else this.modes.set(line.agentId, line.mode);
    } else if (line.kind === "cap" && Number.isInteger(line.perGroupPerDay) && line.perGroupPerDay >= 1) this.perGroupPerDay = line.perGroupPerDay;
    else if (line.kind === "knowledge" && line.entry !== undefined) this.entries.set(line.entry.id, line.entry);
    else if (line.kind === "knowledge-removed") this.entries.delete(line.id);
    else if (line.kind === "collection" && line.collection !== undefined && typeof line.collection.id === "string") this.collectionsById.set(line.collection.id, line.collection);
    else if (line.kind === "collection-removed" && line.id !== GENERAL_COLLECTION) {
      this.collectionsById.delete(line.id);
      for (const [id, entry] of this.entries) if (entry.collection === line.id) this.entries.delete(id);
    } else if (line.kind === "ticks" && Array.isArray(line.collections)) this.ticks.set(line.agentId, line.collections.filter((id): id is string => typeof id === "string"));
    else if (line.kind === "window" && Number.isInteger(line.exchanges) && Number.isInteger(line.minutes)) {
      this.windowLimits = { exchanges: Math.max(0, Math.min(GUEST_WINDOW_LIMIT.exchanges, line.exchanges)), minutes: Math.max(1, Math.min(GUEST_WINDOW_LIMIT.minutes, line.minutes)) };
      this.sweep();
    } else if (line.kind === "hold") {
      if (line.hold === true) this.holds.add(`${line.door}\0${line.chatKey}`);
      else this.holds.delete(`${line.door}\0${line.chatKey}`);
    }
  }
}

const windowKey = (door: string, chatKey: string, identity: string) => `${door}\0${chatKey}\0${identity}`;

/** The entries best related to a query, best first: the memory ranking, over these entries only. */
function searchIn(entries: readonly GuestKnowledgeEntry[], query: string, limit: number): GuestKnowledgeEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const records = entries.map(entry => ({ at: entry.at, kind: "fact", text: `${entry.title}\n${entry.text}`, source: entry.id }) as MemoryRecord);
  const found = rankRelated(query, records).map(scored => byId.get(scored.record.source ?? "")).filter((entry): entry is GuestKnowledgeEntry => entry !== undefined);
  return (found.length > 0 ? found : query.trim() === "" ? [...entries] : []).slice(0, limit);
}

function readLines(path: string | undefined): unknown[] {
  if (path === undefined || !existsSync(path)) return [];
  const out: unknown[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // A torn last line from a crash: the lines before it still stand.
    }
  }
  return out;
}
