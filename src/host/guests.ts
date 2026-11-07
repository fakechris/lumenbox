/**
 * The guest desk (INV-1708, docs/97): what an organisation decided about guests, and what its
 * agents did for them.
 *
 * Three things, kept apart from everything a member turn reads:
 *
 *   - **who each agent answers in group chats**: `members` (the default) or `guests`;
 *   - **the knowledge public to guests**: entries an Admin wrote, each a title and a text. It is
 *     not memory and nothing copies into it by itself; only an Admin adds or removes an entry;
 *   - **the guest turns**: one line per turn in `guest-turns.jsonl`, the guest's record, which no
 *     transcript, memory or board ever reads. The per-group daily cap is counted from it, so a
 *     restart keeps the count.
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
  | { kind: "knowledge-removed"; at: string; by: string; id: string };

/** Clipped so a guest who pastes a novel does not grow the record without bound. */
const CLIP = 2_000;
const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);

export class GuestDesk {
  private readonly modes = new Map<string, GuestAnswerMode>();
  private readonly entries = new Map<string, GuestKnowledgeEntry>();
  private perGroupPerDay = DEFAULT_GUEST_TURNS_PER_DAY;
  /** Guest turns per `day\0door\0chat`, counted from the turns ledger. */
  private readonly counts = new Map<string, number>();
  /** Group chats already told today that the cap was reached. */
  private readonly told = new Set<string>();

  constructor(
    private readonly paths: { settings?: string; turns?: string } = {},
    private readonly now: () => Date = () => new Date()
  ) {
    for (const line of readLines(paths.settings)) this.apply(line as Line);
    for (const line of readLines(paths.turns)) {
      const turn = line as Partial<GuestTurnRecord>;
      if (typeof turn.at !== "string" || typeof turn.door !== "string" || typeof turn.chatKey !== "string") continue;
      if (turn.outcome === "over-cap") continue;
      const key = this.keyFor(turn.door, turn.chatKey, new Date(turn.at));
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
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

  /** The knowledge public to guests, oldest first. */
  knowledge(): GuestKnowledgeEntry[] {
    return [...this.entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  entry(id: string): GuestKnowledgeEntry | undefined {
    return this.entries.get(id);
  }

  addKnowledge(input: { title: string; text: string }, by: string): GuestKnowledgeEntry {
    const title = input.title.trim();
    const text = input.text.trim();
    if (title === "" || text === "") throw new Error("An entry needs a title and a text");
    const entry: GuestKnowledgeEntry = { id: `g${randomUUID().slice(0, 8)}`, title: title.slice(0, 200), text: text.slice(0, 20_000), at: this.now().toISOString(), by };
    this.write({ kind: "knowledge", at: entry.at, by, entry });
    return entry;
  }

  removeKnowledge(id: string, by: string): boolean {
    if (!this.entries.has(id)) return false;
    this.write({ kind: "knowledge-removed", at: this.now().toISOString(), by, id });
    return true;
  }

  /** The entries best related to a query, best first: the memory ranking, over this list only. */
  search(query: string, limit = 5): GuestKnowledgeEntry[] {
    const all = this.knowledge();
    const records = all.map(entry => ({ at: entry.at, kind: "fact", text: `${entry.title}\n${entry.text}`, source: entry.id }) as MemoryRecord);
    const ranked = rankRelated(query, records).map(scored => this.entries.get(scored.record.source ?? ""));
    const found = ranked.filter((entry): entry is GuestKnowledgeEntry => entry !== undefined);
    return (found.length > 0 ? found : query.trim() === "" ? all : []).slice(0, limit);
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
    return (readLines(this.paths.turns) as GuestTurnRecord[]).slice(-limit);
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
  }
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
