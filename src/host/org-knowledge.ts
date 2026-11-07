/**
 * The organisation's knowledge, L1 (INV-1726, docs/98 §3, §6 and §10 decision 1).
 *
 * One ledger of its own, `~/.agentbox/org-knowledge.jsonl`, beside `people.jsonl` and
 * `guests.jsonl` — not in `shared-memory/`, which is sharded by writing agent, because an L1
 * item's writer is a person's approval, not an agent. Each line is the extended memory record
 * (`MemoryRecord` with memory-scope.ts's fields), plus `pinned`.
 *
 * - **Append-only, replayed at start, written whole.** Nothing is edited in place: a correction is
 *   a later line (`supersedes`, a `retraction`, an approval after a hold). The file is read once
 *   when the host starts; a torn or unreadable line is skipped. Each append is one `write` of one
 *   line, the torn tail closed first and `fsync`ed before it is believed (`appendLineDurably`).
 * - **Who reads it.** A member turn, through the same admission check as team memory
 *   (`admitted`, before anything is ranked): `org` admits every reader of the installation,
 *   `box:<id>` the members of that box. Held items (a promotion waiting for review) are read by
 *   nobody. A guest turn never reads it: guest-turn.ts takes no store and does not import this
 *   module (docs/97 §0). An isolated turn (clean, recovering) does not read it either.
 * - **What is recalled.** Only a `recall` item that a person stands behind (`verifiedBy` and
 *   `verifiedAt`) and whose `reviewBy` has not passed. Anything else — `cite-only`, unverified,
 *   stale — is read only when cited by id (`cite`, `citedById`), with its state said (docs/98 §6.3).
 * - **The prompt.** Pinned "how we work" items go into every turn in a fixed budget of their own
 *   (`PINNED_CHAR_BUDGET`). Over budget, the items kept are those with the latest review date
 *   (none last), then the most recently verified; the rest are counted, "N more". Searchable items
 *   the turn's words touch follow, ranked by the one ranker (`rankRelated`), in their own budget.
 *   Every line carries its id, `org:<version>`, and the section asks that an answer built on one
 *   cite it.
 * - **A personal installation never writes it** (docs/95 §5, docs/96 §0, docs/98 §8): `append`
 *   refuses with `PersonalInstallationNeverWrites`, and a personal installation reads no L1 either —
 *   it has none. The installation's mode is asked at the moment of the write, never cached.
 *
 * Writing L1 — promotion, review, the correction verbs — is INV-1729 and later; this module is
 * the ledger and its read path.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import type { InstallationMode } from "./installation.ts";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { dedupe, type MemoryRecord, validateRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";
import { rankRelated } from "./memory-relevance.ts";
import { admitted, citedById, evidenceKind, recallable, type MemoryReader } from "./memory-scope.ts";

export const LEDGER_KIND: LedgerKind = "record";

/** The ledger's file name under the installation's home. */
export const ORG_KNOWLEDGE_FILE = "org-knowledge.jsonl";

/** The pinned "how we work" items' own budget, beside the team's (1,500, `SHARED_CHAR_BUDGET`). */
export const PINNED_CHAR_BUDGET = 1_200;

/** How much of the prompt searchable L1 items the turn's words touch may take. */
export const ORG_RECALL_BUDGET = 1_000;

/** An L1 line: the extended memory record, and whether it is read on every turn. */
export interface OrgKnowledgeItem extends MemoryRecord {
  /** A "how we work" item: in every turn's prompt, within `PINNED_CHAR_BUDGET`. */
  pinned?: boolean;
}

/** The refusal a personal installation's write meets, whoever asked for it. */
export class PersonalInstallationNeverWrites extends Error {
  constructor() {
    super("A personal installation has no organisation knowledge and never writes it (docs/98 §8). Promote it inside the organisation's own installation.");
  }
}

/** The boxes, asked rather than copied: the registry owns membership (docs/98 §10 question 1). */
export interface OrgBoxes {
  boxOf(agentId: string): Pick<BoxEntry, "id">;
  boxById(id: string): Pick<BoxEntry, "id" | "members"> | undefined;
}

export interface OrgKnowledgeDeps {
  /** The installation's mode, asked at each read and write. */
  mode: () => InstallationMode;
  boxes: () => OrgBoxes;
  now?: () => Date;
}

const ID_PREFIX = "org:";

/** The id a person and an answer cite an item by. */
export function orgItemId(item: Pick<MemoryRecord, "at" | "kind" | "text" | "from">): string {
  return `${ID_PREFIX}${versionOf(item)}`;
}

/** Why `item` cannot be an L1 line, or undefined when it can. Says what would be accepted. */
export function validateItem(item: OrgKnowledgeItem): string | undefined {
  if (item.kind !== "fact" && item.kind !== "note" && item.kind !== "retraction") return "An organisation item is a fact, a note or a retraction.";
  if (typeof item.at !== "string" || Number.isNaN(Date.parse(item.at))) return "An organisation item needs `at`, an ISO 8601 time.";
  const text = validateRecord(item.text ?? "");
  if (text !== undefined) return text.reason;
  if (item.scope !== "org" && !(typeof item.scope === "string" && /^box:\S+$/.test(item.scope))) return "An organisation item's scope is `org` or `box:<id>`; an agent's own knowledge is not kept here.";
  if (item.surface !== undefined && item.surface !== "recall" && item.surface !== "cite-only") return "`surface` is `recall` or `cite-only`.";
  if (item.kind !== "retraction" && (typeof item.owner !== "string" || item.owner === "")) return "Every organisation item has an owner: the principal accountable for it.";
  const bad = (item.evidence ?? []).find(ref => evidenceKind(ref) === undefined);
  if (bad !== undefined) return `\`${bad}\` is not an evidence reference: task:, deliverable:, receipt:, routine:, inv:, commit:, doc:, or <conversation>@<time>.`;
  if (item.pinned !== undefined && typeof item.pinned !== "boolean") return "`pinned` is true or false.";
  return undefined;
}

function readable(raw: unknown): raw is OrgKnowledgeItem {
  const item = raw as Partial<OrgKnowledgeItem> | null;
  return item !== null && typeof item === "object" && typeof item.at === "string" && typeof item.kind === "string" && typeof item.text === "string";
}

/** Whether a person stands behind the item now: verified, and its review date not passed. */
export function standsNow(item: OrgKnowledgeItem, now: number): boolean {
  if (item.verifiedBy === undefined || item.verifiedBy === "" || item.verifiedAt === undefined) return false;
  return item.reviewBy === undefined || !(Date.parse(item.reviewBy) <= now);
}

/** The order pinned items keep their place in: the latest review date (none last), then the latest verification, then the id. */
export function pinnedOrder(a: OrgKnowledgeItem, b: OrgKnowledgeItem): number {
  const review = (item: OrgKnowledgeItem) => (item.reviewBy === undefined ? -Infinity : Date.parse(item.reviewBy));
  const verified = (item: OrgKnowledgeItem) => (item.verifiedAt === undefined ? -Infinity : Date.parse(item.verifiedAt));
  return review(b) - review(a) || verified(b) - verified(a) || versionOf(a).localeCompare(versionOf(b));
}

/** One prompt line for an item: its id, its text, and who stands behind it. */
export function renderItem(item: OrgKnowledgeItem): string {
  const review = item.reviewBy === undefined ? "" : `, review by ${item.reviewBy.slice(0, 10)}`;
  const verified = item.verifiedAt === undefined ? "unverified" : `verified ${item.verifiedAt.slice(0, 10)}`;
  return `- [${orgItemId(item)}] ${item.text} — owner ${item.owner ?? "unknown"}, ${verified}${review}`;
}

/** Fills `budget` in order, stopping at the first line that does not fit: a later item never jumps a better one. */
function fill(items: readonly OrgKnowledgeItem[], budget: number): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const line = renderItem(item);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, omitted: items.length - lines.length };
}

export class OrgKnowledge {
  private readonly log: OrgKnowledgeItem[] = [];
  /** Replaced by the server, which knows whether this is the desktop app (`boxRegistrationModeAt`). */
  mode: () => InstallationMode;

  constructor(private readonly path: string | undefined, private readonly deps: OrgKnowledgeDeps) {
    this.mode = deps.mode;
    if (path === undefined || !existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; } // a torn final line, left by a crash mid-append
      if (readable(line)) this.log.push(line);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Appends one line, written and synced before it is believed. Refused on a personal installation, and for a line that is not an L1 item. */
  append(item: OrgKnowledgeItem): OrgKnowledgeItem {
    if (this.mode() === "single-machine") throw new PersonalInstallationNeverWrites();
    const reason = validateItem(item);
    if (reason !== undefined) throw new Error(reason);
    const line: OrgKnowledgeItem = { ...item, text: item.text.trim() };
    if (this.path !== undefined) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendLineDurably(this.path, JSON.stringify(line));
    }
    this.log.push(line);
    return line;
  }

  /** Every line, in order, as written: the history. */
  lines(): readonly OrgKnowledgeItem[] {
    return this.log;
  }

  /** What stands now: not held, not retracted, not superseded, inside its validity. */
  live(): OrgKnowledgeItem[] {
    const now = this.now().getTime();
    const superseded = new Set(this.log.map(item => item.supersedes).filter((id): id is string => id !== undefined));
    return (dedupe(this.log) as OrgKnowledgeItem[]).filter(item =>
      !superseded.has(versionOf(item))
      && (item.validFrom === undefined || !(Date.parse(item.validFrom) > now))
      && (item.validUntil === undefined || !(Date.parse(item.validUntil) <= now)));
  }

  private reader(agentId: string, principalId: string | undefined): MemoryReader {
    const boxes = this.deps.boxes();
    return { agentId, boxId: boxes.boxOf(agentId).id, boxById: id => boxes.boxById(id), ...(principalId !== undefined ? { principalId } : {}) };
  }

  /** The live items this agent, for this person, may read at all — the one admission check, before ranking. None on a personal installation. */
  admittedFor(agentId: string, principalId: string | undefined): OrgKnowledgeItem[] {
    if (this.log.length === 0 || this.mode() === "single-machine") return [];
    return admitted(this.live(), "shared", this.reader(agentId, principalId)) as OrgKnowledgeItem[];
  }

  /** What may enter recall and the prompt: admitted, `recall`, and stood behind now. */
  recalledFor(agentId: string, principalId: string | undefined): OrgKnowledgeItem[] {
    const now = this.now().getTime();
    return (recallable(this.admittedFor(agentId, principalId)) as OrgKnowledgeItem[]).filter(item => standsNow(item, now));
  }

  /** An item by its id (`org:<version>` or the bare version), whatever its surface, when this reader may read it; with its state. */
  cite(agentId: string, principalId: string | undefined, id: string): { item: OrgKnowledgeItem; recalled: boolean } | undefined {
    const version = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
    const item = citedById(this.admittedFor(agentId, principalId), version) as OrgKnowledgeItem | undefined;
    if (item === undefined) return undefined;
    return { item, recalled: this.recalledFor(agentId, principalId).some(other => versionOf(other) === version) };
  }

  /** The prompt section for one turn, or undefined when there is nothing to show. */
  section(agentId: string, principalId: string | undefined, query: string): string | undefined {
    const items = this.recalledFor(agentId, principalId);
    if (items.length === 0) return undefined;
    const pinned = fill(items.filter(item => item.pinned === true).sort(pinnedOrder), PINNED_CHAR_BUDGET);
    const searchable = items.filter(item => item.pinned !== true);
    const related = query.trim() === "" ? [] : rankRelated(query, searchable).map(entry => entry.record as OrgKnowledgeItem);
    const recalled = fill(related, ORG_RECALL_BUDGET);
    if (pinned.lines.length === 0 && pinned.omitted === 0 && recalled.lines.length === 0) return undefined;
    const parts = [
      "## How we work: the organisation's knowledge",
      "",
      "Kept by the organisation and verified by a person. About the organisation, it outranks what your team or you learned. When an answer rests on one of these, cite its id, e.g. (org:…).",
    ];
    if (pinned.lines.length > 0 || pinned.omitted > 0) parts.push("", ...pinned.lines, ...(pinned.omitted > 0 ? [`${pinned.omitted} more pinned items are not shown.`] : []));
    if (recalled.lines.length > 0) parts.push("", "Related to this conversation:", ...recalled.lines, ...(recalled.omitted > 0 ? [`${recalled.omitted} more are related; Recall finds them.`] : []));
    return parts.join("\n");
  }

  /** For the Recall tool: an id cited, read whole with its state; otherwise the recalled items, to search with the rest of memory. */
  forRecall(agentId: string, principalId: string | undefined, search: string): { cited?: string; items: OrgKnowledgeItem[] } {
    const asked = search.trim();
    if (/^org:[0-9a-f]{12}$/.test(asked)) {
      const found = this.cite(agentId, principalId, asked);
      const state = found === undefined ? "" : found.recalled ? "" : " (not recalled on its own: cite-only, unverified or past its review date)";
      return { cited: found === undefined ? `No organisation item ${asked} you may read.` : `${renderItem(found.item)}${state}${found.item.evidence?.length ? `\nEvidence: ${found.item.evidence.join(", ")}` : ""}`, items: [] };
    }
    return { items: this.recalledFor(agentId, principalId) };
  }
}
