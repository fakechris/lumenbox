/**
 * One record of the person, kept by the host and read by every agent (INV-1653).
 *
 * Each agent had its own USER.md and its own memories, and the team tier held fragments agents
 * wrote; nothing was *the* account of who the person is — what they are responsible for, what
 * they are pushing, what they want in the long run, what they care about, how they work, what
 * they prefer — that every turn reads the same way and that a sensing routine can rank by.
 *
 * Lines, not a document: each entry names its field, who wrote it (the person, or an agent whose
 * candidate the memory judge cleared, or a routine), and when; it can be retracted and it can
 * expire. The person's own lines outrank an agent's on the same field. Rendered for the prompt
 * as a short section, and shown in Settings → Mine to edit. USER.md stays what it was: one
 * agent's own notes about the person, on top of this.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { appendLine, type LedgerKind } from "./jsonl.ts";
import type { Installation } from "./installation.ts";

export const LEDGER_KIND: LedgerKind = "record";

export const PERSON_FIELDS = ["responsibilities", "projects", "goals", "interests", "habits", "preferences"] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];

export const FIELD_LABEL: Record<PersonField, string> = {
  responsibilities: "Responsibilities",
  projects: "Projects under way",
  goals: "Long-term goals",
  interests: "Interests",
  habits: "Habits and working hours",
  preferences: "Preferences",
};

export interface PersonEntry {
  id: string;
  at: string;
  field: PersonField;
  text: string;
  /** "person" when they wrote it themselves; "agent:<id>" for a judged candidate; "routine:<slug>" for a sensing routine's. */
  source: string;
  expiresAt?: string;
}

type Line =
  | { kind: "entry"; principal: string; entry: PersonEntry }
  | { kind: "retract"; principal: string; id: string; at: string; by: string };

/** The key a turn uses when no person is signed in, on an installation with no Owner: the installation's one operator. */
export const OPERATOR = "me";

/**
 * Who the signed-out operator is (INV-1705, docs/22 §1a): on a personal installation, the Owner —
 * the same person who speaks from Feishu as `local:owner` — so the desktop and the chats read one
 * record; elsewhere the placeholder `me`.
 */
export function operatorKey(installation: Installation): string {
  return installation.mode === "single-machine" && installation.ownerId !== undefined && installation.ownerId !== "" ? installation.ownerId : OPERATOR;
}

/** How many entries a field shows the model; the rest are on the record and in Settings. */
const PER_FIELD = 6;

export function isPersonField(raw: unknown): raw is PersonField {
  return typeof raw === "string" && (PERSON_FIELDS as readonly string[]).includes(raw);
}

export class PersonRecords {
  private readonly entries = new Map<string, PersonEntry[]>();
  private readonly retracted = new Set<string>();
  /** The key for "nobody signed in"; `useOperator` sets it once the roster says who that is. */
  operator: string = OPERATOR;

  constructor(private readonly path?: string, private readonly now: () => Date = () => new Date()) {
    if (path !== undefined && existsSync(path)) {
      for (const raw of readFileSync(path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        let line: Line;
        try { line = JSON.parse(raw) as Line; } catch { continue; }
        this.apply(line);
      }
    }
  }

  /**
   * The signed-out operator is `id` from now on (`operatorKey`). Lines already read under the
   * placeholder are theirs too: the start rewrote the file first (`adoptOperatorNotes`), and this
   * keeps the copy in memory the same.
   */
  useOperator(id: string): void {
    this.operator = id;
    const placeholder = this.entries.get(OPERATOR);
    if (id === OPERATOR || placeholder === undefined) return;
    this.entries.set(id, [...(this.entries.get(id) ?? []), ...placeholder]);
    this.entries.delete(OPERATOR);
  }

  private apply(line: Line): void {
    if (line.kind === "entry") {
      const list = this.entries.get(line.principal) ?? [];
      list.push(line.entry);
      this.entries.set(line.principal, list);
    } else this.retracted.add(line.id);
  }

  private write(line: Line): void {
    this.apply(line);
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendLine(this.path, JSON.stringify(line));
  }

  /** Adds a line; the text is bounded, and the same text on the same field is not added twice. */
  add(principal: string, input: { field: PersonField; text: string; source: string; expiresAt?: string }): PersonEntry | undefined {
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (text === "") return undefined;
    if (this.live(principal).some(entry => entry.field === input.field && entry.text.toLowerCase() === text.toLowerCase())) return undefined;
    const entry: PersonEntry = { id: randomUUID(), at: this.now().toISOString(), field: input.field, text, source: input.source, ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}) };
    this.write({ kind: "entry", principal, entry });
    return entry;
  }

  retract(principal: string, id: string, by: string): boolean {
    if (!(this.entries.get(principal) ?? []).some(entry => entry.id === id) || this.retracted.has(id)) return false;
    this.write({ kind: "retract", principal, id, at: this.now().toISOString(), by });
    return true;
  }

  /** What stands now: not retracted, not expired; the person's own lines first within a field. */
  live(principal: string): PersonEntry[] {
    const now = this.now().getTime();
    const rank = (entry: PersonEntry): number => (entry.source === "person" ? 0 : entry.source.startsWith("agent:") ? 1 : 2);
    return (this.entries.get(principal) ?? [])
      .filter(entry => !this.retracted.has(entry.id) && (entry.expiresAt === undefined || Date.parse(entry.expiresAt) > now))
      .sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id)); // the id breaks a same-millisecond tie, so the order is the same on every run
  }

  /** The section a turn reads, or nothing when the record is empty. */
  render(principal: string, name = "the person"): string | undefined {
    const live = this.live(principal);
    if (live.length === 0) return undefined;
    const parts: string[] = [];
    for (const field of PERSON_FIELDS) {
      const lines = live.filter(entry => entry.field === field).slice(0, PER_FIELD);
      if (lines.length === 0) continue;
      parts.push(`${FIELD_LABEL[field]}:\n${lines.map(entry => `- ${entry.text}${entry.source === "person" ? "" : ` (${entry.source.startsWith("agent:") ? "learned" : "sensed"})`}`).join("\n")}`);
    }
    return `## About ${name}\n\nKept by the host and read by every agent; the person's own lines outrank what was learned. Use it to judge what matters to them and how to speak to them.\n\n${parts.join("\n\n")}`;
  }

  /**
   * A memory the judge kept becomes a line here, under the field its words point at, for the
   * person who was driving. Only a preference, or a standing fact that names the person, is
   * taken; the judge already decided it came from the content and contradicts nothing.
   */
  absorb(records: readonly { kind: string; text: string; about?: string; types?: Record<string, number>; held?: unknown; via?: string }[], agentId: string, driver: { principal?: string; name?: string } = {}): PersonEntry[] {
    const added: PersonEntry[] = [];
    for (const record of records) {
      const about = record.about ?? driver.principal ?? this.operator;
      if (record.held !== undefined || (record.kind !== "fact" && record.kind !== "note")) continue;
      const preference = record.types?.preference ?? 0;
      const semantic = record.types?.semantic ?? 0;
      // A preference is about the person by its nature; a standing fact only when it names them.
      const named = driver.name !== undefined && driver.name !== "" && record.text.toLowerCase().includes(driver.name.toLowerCase());
      if (preference < 0.6 && !(semantic >= 0.7 && named)) continue;
      const field = fieldOf(record.text, preference >= 0.6);
      const entry = this.add(about, { field, text: record.text, source: `agent:${record.via ?? agentId}` });
      if (entry !== undefined) added.push(entry);
    }
    return added;
  }
}

/** Which field a line belongs to, from its words; a preference-scored line defaults to preferences. */
export function fieldOf(text: string, preferred = false): PersonField {
  // Goals before responsibilities: "wants to run a marathon" is a goal, though it says "run".
  // Chinese words carry no word boundary, so they are matched bare.
  if (/\b(goal|aim|by (next )?(year|quarter)|long[- ]term|wants? to)\b|目标|计划(在)?|长期/i.test(text)) return "goals";
  if (/\b(responsible|owns?|in charge|runs?|leads?|role)\b|负责|主管|职责/i.test(text)) return "responsibilities";
  if (/\b(project|shipping|building|working on|launch)\b|项目|在做|推进/i.test(text)) return "projects";
  if (/\b(interested|likes?|enjoys?|follows?|fan of)\b|兴趣|喜欢|关注/i.test(text)) return "interests";
  if (/\b(usually|every (morning|day|week)|hours?|timezone|mornings?|evenings?)\b|习惯|每天|时区|上午|晚上/i.test(text)) return "habits";
  return "preferences";
}
