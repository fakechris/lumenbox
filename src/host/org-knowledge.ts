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
 *   `verifiedAt`) and that is not stale. Anything else — `cite-only`, unverified — is read only
 *   when cited by id (`cite`, `citedById`), with its state said (docs/98 §6.3).
 * - **Stale** (INV-1731, org-knowledge-staleness.ts): its `reviewBy` passed, or its evidence
 *   changed state. A stale item leaves the Recall tool's search, but a verified one stays in the
 *   prompt marked and after everything current, so it is the first to give way to the budget and
 *   an agent is told not to rely on it unchecked; its owner has it on their "needs you" list.
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
 * - **The correction verbs** (INV-1730, docs/98 §7) are lines too, never an edit or a delete:
 *   *unverify* (anyone who may read the item, with a reason: from then on it is read as `cite-only`
 *   and unverified, and its owner is told), *retract* (the owner or an Admin: a `retraction` line
 *   naming the item) and *supersede* (the owner or an Admin: a new item whose `supersedes` names
 *   the old one, whose `validUntil` is then the new line's `at` — derived, as the old line is never
 *   rewritten). A correction line carries `correction` and is not itself an item. A superseded or
 *   retracted item stays readable by id, saying what replaced or withdrew it: the chain is traced
 *   from the log, both ways (`view`).
 *
 * Writing L1 by promotion and review is INV-1729; this module is the ledger, its read path and
 * its corrections.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import type { InstallationMode } from "./installation.ts";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { dedupe, dedupeKey, type MemoryRecord, validateRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";
import { rankRelated } from "./memory-relevance.ts";
import { admitted, citedById, evidenceKind, recallable, scopeAdmitsPerson, type MemoryReader } from "./memory-scope.ts";
import { describeStaleness, type EvidenceWatch, type Staleness } from "./org-knowledge-staleness.ts";

export const LEDGER_KIND: LedgerKind = "record";

/** The ledger's file name under the installation's home. */
export const ORG_KNOWLEDGE_FILE = "org-knowledge.jsonl";

/** The pinned "how we work" items' own budget, beside the team's (1,500, `SHARED_CHAR_BUDGET`). */
export const PINNED_CHAR_BUDGET = 1_200;

/** How much of the prompt searchable L1 items the turn's words touch may take. */
export const ORG_RECALL_BUDGET = 1_000;

/** A correction applied to an item (INV-1730): which verb, to which item (`versionOf`), by whom, and why. */
export interface OrgCorrection {
  verb: "unverify" | "retract";
  of: string;
  /** The principal accountable: the person, or the person an agent's turn was for ("operator" for the installation's own credential). */
  by: string;
  reason: string;
  /** The agent that applied it in that person's turn, when it was an agent. */
  agent?: string;
}

/** An L1 line: the extended memory record, and whether it is read on every turn. */
export interface OrgKnowledgeItem extends MemoryRecord {
  /** A "how we work" item: in every turn's prompt, within `PINNED_CHAR_BUDGET`. */
  pinned?: boolean;
  /** Set on a correction line, which is a verb applied to another item and not itself an item. */
  correction?: OrgCorrection;
}

/** Where an item stands, as a person and a citation read it. */
export type OrgItemState = "standing" | "unverified" | "stale" | "superseded" | "retracted" | "expired" | "restated";

/** One item with its state and its place in the supersession chain: what Settings → Memory and a citation show. */
export interface OrgItemView {
  id: string;
  item: OrgKnowledgeItem;
  state: OrgItemState;
  /** The id this item replaced, and the id that replaced it. */
  supersedes?: string;
  supersededBy?: string;
  /** For a superseded item, when it stopped standing: the superseding line's `at`. */
  validUntil?: string;
  /** The unverify or retraction that applies to it. */
  correction?: OrgCorrection & { at: string };
}

/** What an owner is told when one of their items is marked unverified. */
export interface OrgUnverifiedNotice {
  id: string;
  text: string;
  by: string;
  reason: string;
}

/** Who asks for a correction: the person accountable, and the agent acting for them in a turn, if any. */
export interface OrgCorrector {
  /** The principal; undefined is the operator holding the installation's own credential. */
  principalId: string | undefined;
  agentId?: string;
}

export type CorrectionResult =
  | { ok: true; line: OrgKnowledgeItem; view: OrgItemView }
  | { ok: false; code: "org-item-unknown" | "org-item-not-standing" | "org-correction-not-owner" | "org-correction-reason" | "org-correction-evidence" | "org-correction-text"; why: string };

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
  /** What the items' evidence says now (INV-1731); absent, only the review date makes an item stale. */
  evidence?: Pick<EvidenceWatch, "changeOf">;
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
  const fix = item.correction;
  if (fix !== undefined) {
    if (fix.verb !== "unverify" && fix.verb !== "retract") return "A correction is `unverify` or `retract`; a supersession is a new item naming the old one in `supersedes`.";
    if (fix.verb === "retract" && item.kind !== "retraction") return "A retract line is a `retraction`.";
    if (typeof fix.of !== "string" || !/^[0-9a-f]{12}$/.test(fix.of)) return "A correction names the item it applies to by its version.";
    if (typeof fix.by !== "string" || fix.by === "") return "A correction says who is accountable for it.";
    if (typeof fix.reason !== "string" || fix.reason.trim() === "") return "A correction says why.";
  }
  return undefined;
}

function readable(raw: unknown): raw is OrgKnowledgeItem {
  const item = raw as Partial<OrgKnowledgeItem> | null;
  return item !== null && typeof item === "object" && typeof item.at === "string" && typeof item.kind === "string" && typeof item.text === "string";
}

/** Whether a person put their name to the item. */
export function verified(item: OrgKnowledgeItem): boolean {
  return item.verifiedBy !== undefined && item.verifiedBy !== "" && item.verifiedAt !== undefined;
}

/** Why the item is not to be relied on unchecked, or undefined: its evidence changed (stale), else its review date passed (review due). */
export function stalenessOf(item: OrgKnowledgeItem, now: number, evidence?: Pick<EvidenceWatch, "changeOf">): Staleness | undefined {
  const changed = evidence?.changeOf(item);
  if (changed !== undefined) return changed;
  if (item.reviewBy !== undefined && Date.parse(item.reviewBy) <= now) return { kind: "review-due", since: item.reviewBy };
  return undefined;
}

/** The order pinned items keep their place in: the latest review date (none last), then the latest verification, then the id. */
export function pinnedOrder(a: OrgKnowledgeItem, b: OrgKnowledgeItem): number {
  const review = (item: OrgKnowledgeItem) => (item.reviewBy === undefined ? -Infinity : Date.parse(item.reviewBy));
  const verified = (item: OrgKnowledgeItem) => (item.verifiedAt === undefined ? -Infinity : Date.parse(item.verifiedAt));
  return review(b) - review(a) || verified(b) - verified(a) || versionOf(a).localeCompare(versionOf(b));
}

/** One prompt line for an item: its id, its text, who stands behind it, and — when stale — the marker (INV-1731). */
export function renderItem(item: OrgKnowledgeItem, staleness?: Staleness): string {
  const review = item.reviewBy === undefined || staleness?.kind === "review-due" ? "" : `, review by ${item.reviewBy.slice(0, 10)}`;
  const stood = item.verifiedAt === undefined ? "unverified" : `verified ${item.verifiedAt.slice(0, 10)}`;
  const marker = staleness === undefined ? "" : ` — ${describeStaleness(staleness)}; check before relying on it`;
  return `- [${orgItemId(item)}] ${item.text} — owner ${item.owner ?? "unknown"}, ${stood}${review}${marker}`;
}

/** Fills `budget` in order, stopping at the first line that does not fit: a later item never jumps a better one. */
function fill(items: readonly { item: OrgKnowledgeItem; staleness?: Staleness }[], budget: number): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  for (const { item, staleness } of items) {
    const line = renderItem(item, staleness);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, omitted: items.length - lines.length };
}

/** An item read as unverified: `cite-only`, with nobody standing behind it. The line itself is untouched. */
function asUnverified(item: OrgKnowledgeItem): OrgKnowledgeItem {
  const { verifiedBy: _by, verifiedAt: _at, ...rest } = item;
  return { ...rest, surface: "cite-only" };
}

/** What a citation adds about where the item stands. */
function citedState(view: OrgItemView, recalled: boolean, staleness: Staleness | undefined): string {
  const fix = view.correction;
  if (view.state === "superseded") return ` (superseded by ${view.supersededBy} on ${view.validUntil!.slice(0, 10)}: cite that one)`;
  if (view.state === "retracted") return ` (retracted${fix !== undefined ? ` by ${fix.by} on ${fix.at.slice(0, 10)}: ${fix.reason}` : ""}; no longer the organisation's)`;
  if (view.state === "expired" || view.state === "restated") return ` (${view.state}; no longer stands)`;
  const unverified = fix?.verb === "unverify" ? ` Marked unverified by ${fix.by} on ${fix.at.slice(0, 10)}: ${fix.reason}.` : "";
  const replaces = view.supersedes !== undefined ? ` It supersedes ${view.supersedes}.` : "";
  return `${recalled ? "" : ` (not recalled on its own: ${staleness !== undefined ? "stale" : "cite-only or unverified"})`}${unverified}${replaces}`;
}

export class OrgKnowledge {
  private readonly log: OrgKnowledgeItem[] = [];
  /** Replaced by the server, which knows whether this is the desktop app (`boxRegistrationModeAt`). */
  mode: () => InstallationMode;
  /** Set by the server, which holds the task board, the documents and the Involute credential (INV-1731). */
  evidence: Pick<EvidenceWatch, "changeOf"> | undefined;
  /** Whether a principal is an Admin; undefined is the operator, who is. Replaced by the server, which holds the roster. */
  isAdmin: (principalId: string | undefined) => boolean = principalId => principalId === undefined;
  /** Tells an item's owner it was marked unverified, on their channels, in their words. Replaced by the server; nobody to tell in a test or a headless host. */
  notify: (owner: string, notice: OrgUnverifiedNotice) => void = () => {};

  constructor(private readonly path: string | undefined, private readonly deps: OrgKnowledgeDeps) {
    this.mode = deps.mode;
    this.evidence = deps.evidence;
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

  /** The items, as opposed to the corrections applied to them, and none held for review. */
  private statements(): OrgKnowledgeItem[] {
    return this.log.filter(line => line.correction === undefined);
  }

  /** What the correction lines and supersessions say, by item version. A held item supersedes nothing until it is approved. */
  private corrections(): { unverified: Map<string, OrgKnowledgeItem>; retracted: Map<string, OrgKnowledgeItem>; supersededBy: Map<string, OrgKnowledgeItem> } {
    const unverified = new Map<string, OrgKnowledgeItem>();
    const retracted = new Map<string, OrgKnowledgeItem>();
    const supersededBy = new Map<string, OrgKnowledgeItem>();
    for (const line of this.log) {
      if (line.correction?.verb === "unverify") unverified.set(line.correction.of, line);
      else if (line.correction?.verb === "retract") retracted.set(line.correction.of, line);
      else if (line.supersedes !== undefined && line.held === undefined && !supersededBy.has(line.supersedes)) supersededBy.set(line.supersedes, line);
    }
    return { unverified, retracted, supersededBy };
  }

  /** What stands now: not held, not retracted, not superseded, inside its validity; an unverified item read as `cite-only` and unverified. */
  live(): OrgKnowledgeItem[] {
    const now = this.now().getTime();
    // A held line supersedes nothing: a proposal to replace an item (a promotion, maintenance's, INV-1732) waits for a person (`corrections`).
    const { unverified, retracted, supersededBy } = this.corrections();
    return (dedupe(this.statements()) as OrgKnowledgeItem[])
      .filter(item =>
        !supersededBy.has(versionOf(item)) && !retracted.has(versionOf(item))
        && (item.validFrom === undefined || !(Date.parse(item.validFrom) > now))
        && (item.validUntil === undefined || !(Date.parse(item.validUntil) <= now)))
      .map(item => (unverified.has(versionOf(item)) ? asUnverified(item) : item));
  }

  /**
   * Every item that was ever approved (not held, not a correction), with its state and its place in
   * the supersession chain, oldest first. The admission check is the caller's: `viewFor` for a
   * person, `cite` for an agent.
   */
  view(): OrgItemView[] {
    const now = this.now().getTime();
    const { unverified, retracted, supersededBy } = this.corrections();
    const live = new Set(this.live().map(item => versionOf(item)));
    const statements = this.statements().filter(item => item.held === undefined && item.kind !== "retraction");
    const retractedText = (item: OrgKnowledgeItem) => this.statements().some(line => line.kind === "retraction" && line.at >= item.at && dedupeKey(line.text) === dedupeKey(item.text));
    return statements.map(item => {
      const version = versionOf(item);
      const unverify = unverified.get(version);
      const retraction = retracted.get(version);
      const successor = supersededBy.get(version);
      const correction = retraction ?? unverify;
      const state: OrgItemState = live.has(version)
        ? unverify !== undefined || !verified(item) ? "unverified" : this.staleOf(item) === undefined ? "standing" : "stale"
        : successor !== undefined ? "superseded"
          : retraction !== undefined || retractedText(item) ? "retracted"
            : (item.validUntil !== undefined && Date.parse(item.validUntil) <= now) || (item.validFrom !== undefined && Date.parse(item.validFrom) > now) ? "expired" : "restated";
      return {
        id: orgItemId(item),
        item: unverify !== undefined ? asUnverified(item) : item,
        state,
        ...(item.supersedes !== undefined ? { supersedes: `${ID_PREFIX}${item.supersedes}` } : {}),
        ...(successor !== undefined ? { supersededBy: orgItemId(successor), validUntil: successor.at } : {}),
        ...(correction?.correction !== undefined ? { correction: { ...correction.correction, at: correction.at } } : {}),
      };
    });
  }

  /** What a person may read in Settings → Memory: every item an Admin may; a member, the ones whose scope admits them. None on a personal installation. */
  viewFor(principalId: string | undefined, admin: boolean): OrgItemView[] {
    if (this.mode() === "single-machine") return [];
    const boxes = this.deps.boxes();
    return this.view().filter(view => admin || scopeAdmitsPerson(view.item.scope, principalId, id => boxes.boxById(id)));
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

  /** Why this item is stale now, or undefined. */
  staleOf(item: OrgKnowledgeItem): Staleness | undefined {
    return stalenessOf(item, this.now().getTime(), this.evidence);
  }

  /** The admitted `recall` items a person verified, each with its staleness: what the prompt may show. */
  private surfacedFor(agentId: string, principalId: string | undefined): { item: OrgKnowledgeItem; staleness?: Staleness }[] {
    return (recallable(this.admittedFor(agentId, principalId)) as OrgKnowledgeItem[]).filter(verified).map(item => {
      const staleness = this.staleOf(item);
      return staleness === undefined ? { item } : { item, staleness };
    });
  }

  /** What may enter recall: admitted, `recall`, verified, and not stale. */
  recalledFor(agentId: string, principalId: string | undefined): OrgKnowledgeItem[] {
    return this.surfacedFor(agentId, principalId).filter(entry => entry.staleness === undefined).map(entry => entry.item);
  }

  /** Every verified item that is stale now, whoever may read it: for its owner's "needs you" list (INV-1731). */
  staleItems(): { id: string; item: OrgKnowledgeItem; staleness: Staleness }[] {
    if (this.log.length === 0 || this.mode() === "single-machine") return [];
    return this.live().filter(item => item.kind !== "retraction" && item.held === undefined && verified(item)).flatMap(item => {
      const staleness = this.staleOf(item);
      return staleness === undefined ? [] : [{ id: orgItemId(item), item, staleness }];
    });
  }

  /**
   * An item by its id (`org:<version>` or the bare version), whatever its surface and whether or not
   * it still stands, when this reader may read it; with its state. Superseded and retracted items
   * are the history, and a citation of one says what replaced or withdrew it.
   */
  cite(agentId: string, principalId: string | undefined, id: string): { item: OrgKnowledgeItem; recalled: boolean; view: OrgItemView } | undefined {
    if (this.log.length === 0 || this.mode() === "single-machine") return undefined;
    const version = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
    const views = this.view();
    const readable = admitted(views.map(view => view.item), "shared", this.reader(agentId, principalId));
    const item = citedById(readable, version) as OrgKnowledgeItem | undefined;
    if (item === undefined) return undefined;
    const view = views.find(entry => entry.id === `${ID_PREFIX}${version}`)!;
    return { item, view, recalled: this.recalledFor(agentId, principalId).some(other => versionOf(other) === version) };
  }

  /** The item a correction names, as it stands now, when `who` may read it; or why not. */
  private target(id: string, who: OrgCorrector): { item: OrgKnowledgeItem; view: OrgItemView } | Extract<CorrectionResult, { ok: false }> {
    const version = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
    const view = who.agentId !== undefined
      ? this.cite(who.agentId, who.principalId, version)?.view
      : this.viewFor(who.principalId, this.isAdmin(who.principalId)).find(entry => entry.id === `${ID_PREFIX}${version}`);
    if (view === undefined) return { ok: false, code: "org-item-unknown", why: `There is no organisation item ${ID_PREFIX}${version} you may read.` };
    const item = this.statements().find(line => versionOf(line) === version)!;
    if (view.state === "superseded" || view.state === "retracted" || view.state === "expired" || view.state === "restated") {
      return { ok: false, code: "org-item-not-standing", why: `${view.id} is ${view.state}${view.supersededBy !== undefined ? ` by ${view.supersededBy}` : ""}; a correction applies to what still stands.` };
    }
    return { item, view };
  }

  /** Whether `who` may retract or supersede `item`: its owner, or an Admin (docs/98 §7). */
  private mayReplace(item: OrgKnowledgeItem, who: OrgCorrector): Extract<CorrectionResult, { ok: false }> | undefined {
    if (this.isAdmin(who.principalId) || (who.principalId !== undefined && who.principalId === item.owner)) return undefined;
    return { ok: false, code: "org-correction-not-owner", why: `Only ${orgItemId(item)}'s owner (${item.owner ?? "unknown"}) or an Admin may retract or supersede it; anyone who reads it may mark it unverified.` };
  }

  private correctionLine(item: OrgKnowledgeItem, verb: OrgCorrection["verb"], who: OrgCorrector, reason: string): OrgKnowledgeItem {
    const correction: OrgCorrection = { verb, of: versionOf(item), by: who.principalId ?? "operator", reason: reason.trim(), ...(who.agentId !== undefined ? { agent: who.agentId } : {}) };
    return { at: this.now().toISOString(), kind: verb === "retract" ? "retraction" : item.kind, text: item.text, ...(item.scope !== undefined ? { scope: item.scope } : {}), ...(item.owner !== undefined ? { owner: item.owner } : {}), correction };
  }

  private applied(line: OrgKnowledgeItem, id: string): CorrectionResult {
    const view = this.view().find(entry => entry.id === id)!;
    return { ok: true, line, view };
  }

  /** Unverify: anyone who may read the item, with a reason. It leaves recall, stays citable by id, and its owner is told. */
  unverify(id: string, who: OrgCorrector, reason: string): CorrectionResult {
    if (reason.trim() === "") return { ok: false, code: "org-correction-reason", why: "Say why the item is in doubt: its owner reads the reason." };
    const target = this.target(id, who);
    if ("ok" in target) return target;
    const line = this.append(this.correctionLine(target.item, "unverify", who, reason));
    if (target.item.owner !== undefined && target.item.owner !== who.principalId) {
      this.notify(target.item.owner, { id: target.view.id, text: target.item.text, by: line.correction!.by, reason: line.correction!.reason });
    }
    return this.applied(line, target.view.id);
  }

  /** Retract: the owner or an Admin. A retraction line naming the item; the item stays in the history. */
  retract(id: string, who: OrgCorrector, reason: string): CorrectionResult {
    if (reason.trim() === "") return { ok: false, code: "org-correction-reason", why: "Say why the item is withdrawn." };
    const target = this.target(id, who);
    if ("ok" in target) return target;
    const refused = this.mayReplace(target.item, who);
    if (refused !== undefined) return refused;
    return this.applied(this.append(this.correctionLine(target.item, "retract", who, reason)), target.view.id);
  }

  /**
   * Supersede: the owner or an Admin. A new item, in the old one's scope, surface and place, owned by
   * the old one's owner and verified by whoever superseded it; the old one stops standing at its `at`.
   * Evidence is required unless an Admin writes it ("Admin's word", docs/98 §7).
   */
  supersede(id: string, who: OrgCorrector, text: string, evidence: readonly string[] = []): CorrectionResult {
    const target = this.target(id, who);
    if ("ok" in target) return target;
    const refused = this.mayReplace(target.item, who);
    if (refused !== undefined) return refused;
    const invalid = validateRecord(text);
    if (invalid !== undefined) return { ok: false, code: "org-correction-text", why: invalid.reason };
    if (evidence.length === 0 && !this.isAdmin(who.principalId)) return { ok: false, code: "org-correction-evidence", why: "A superseding item needs at least one evidence reference (task:, inv:, commit:, doc:, …) unless an Admin writes it." };
    const at = this.now().toISOString();
    const old = target.item;
    const line = this.append({
      at, kind: old.kind === "note" ? "note" : "fact", text, scope: old.scope!, surface: old.surface ?? "recall", owner: old.owner!,
      ...(evidence.length > 0 ? { evidence: [...evidence] } : {}), ...(old.pinned === true ? { pinned: true } : {}),
      supersedes: versionOf(old), verifiedBy: who.principalId ?? "operator", verifiedAt: at,
    });
    return this.applied(line, orgItemId(line));
  }

  /** The prompt section for one turn, or undefined when there is nothing to show. Stale items come after every current one, marked. */
  section(agentId: string, principalId: string | undefined, query: string): string | undefined {
    const entries = this.surfacedFor(agentId, principalId);
    if (entries.length === 0) return undefined;
    const freshFirst = <T extends { staleness?: Staleness }>(list: T[]): T[] => [...list.filter(entry => entry.staleness === undefined), ...list.filter(entry => entry.staleness !== undefined)];
    const pinned = fill(freshFirst(entries.filter(entry => entry.item.pinned === true).sort((a, b) => pinnedOrder(a.item, b.item))), PINNED_CHAR_BUDGET);
    const searchable = entries.filter(entry => entry.item.pinned !== true);
    const related = query.trim() === "" ? [] : rankRelated(query, searchable.map(entry => entry.item)).map(entry => searchable.find(candidate => candidate.item === entry.record)!);
    const recalled = fill(freshFirst(related), ORG_RECALL_BUDGET);
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
      const staleness = found === undefined ? undefined : this.staleOf(found.item);
      const state = found === undefined ? "" : citedState(found.view, found.recalled, staleness);
      return { cited: found === undefined ? `No organisation item ${asked} you may read.` : `${renderItem(found.item, staleness)}${state}${found.item.evidence?.length ? `\nEvidence: ${found.item.evidence.join(", ")}` : ""}`, items: [] };
    }
    return { items: this.recalledFor(agentId, principalId) };
  }
}
