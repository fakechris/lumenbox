/**
 * Who may read a memory record, and whether it may be recalled (INV-1725, docs/98 §4 and §6).
 *
 * The organisation's knowledge is not a new store: it is one item shape over the memory record,
 * and one check that runs before anything is ranked. This module owns both.
 *
 * - **The shape.** `KnowledgeFields` are the fields docs/98 §4 adds to a record. An agent's own
 *   records (L3) leave all of them absent and mean exactly what they meant before.
 * - **Admission.** `admitted` keeps the records whose scope admits the reader, and drops the
 *   rest before `rankRelated` ever sees them. `agent` is the agent that holds the record;
 *   `box:<id>` is the reader's own box — memory follows the place (INV-424) — that the
 *   principal may enter (`mayEnterBox`, docs/22 §2); `org` is any reader of the installation.
 *   A scope this code does not know, or a box that does not exist, admits nobody: failing
 *   closed is the only safe reading of a field somebody else wrote.
 * - **Surface.** `recallable` keeps what agents may surface on their own. A `cite-only` record
 *   is read only by id (`citedById`), never ranked, never in the prompt's memory sections; an
 *   unknown surface is treated as `cite-only`, for the same reason.
 *
 * Records written before the fields existed are mapped explicitly by `scopeOf`, so each keeps
 * the visibility it had: an own-tier record is `agent`; a shared record is its `box`; a shared
 * record an agent promoted with `audience: "everyone"` and nobody holds is `org` (INV-1722, until
 * that field is retired, docs/98 §9 row 4); a shared record from before boxes (no `box`) is `org`,
 * as it was visible everywhere.
 */

import type { BoxEntry } from "../box/boxes.ts";
import { mayEnterBox } from "../box/membership.ts";
import type { MemoryRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";

/** `agent` · `box:<id>` · `org`. Guests' public knowledge keeps its own ledger and is never a scope. */
export type MemoryScope = "agent" | `box:${string}` | "org";

/** `recall`: agents may surface it on their own. `cite-only`: read only when cited by id. */
export type MemorySurface = "recall" | "cite-only";

/** What an `evidence` reference points at (docs/98 §4); a bare `<conversation>@<time>` is a conversation. */
export type EvidenceKind = "task" | "deliverable" | "receipt" | "routine" | "inv" | "commit" | "doc" | "conversation";

/** The fields docs/98 §4 adds to a memory record. All optional: an L3 record carries none of them. */
export interface KnowledgeFields {
  scope?: MemoryScope;
  surface?: MemorySurface;
  /** The principal accountable for the item (docs/98 §10 question 2). */
  owner?: string;
  /** Typed references: `task:t12`, `inv:INV-1581`, `commit:<sha>`, `doc:docs/98`, `receipt:<id>`, `<conversation>@<time>`. */
  evidence?: string[];
  /** When the statement is true in the world, ISO 8601. */
  validFrom?: string;
  validUntil?: string;
  /** The version (`versionOf`) of the item this one replaces. */
  supersedes?: string;
  /** Who stands behind it, when, and when it must be looked at again. */
  verifiedBy?: string;
  verifiedAt?: string;
  reviewBy?: string;
}

/** Which tier a record was read from: the agent's own file, or the shared tier. */
export type MemoryTier = "own" | "shared";

/** The asker a scope is checked against. */
export interface MemoryReader {
  agentId: string;
  /** The box the reading agent is in. */
  boxId: string;
  /** The person the turn is for; absent for the operator's own credential (docs/22 §2). */
  principalId?: string;
  /** The registry's boxes, asked, not copied (docs/98 §10 question 1). */
  boxById: (id: string) => Pick<BoxEntry, "id" | "members"> | undefined;
}

const EVIDENCE_PREFIXES: readonly EvidenceKind[] = ["task", "deliverable", "receipt", "routine", "inv", "commit", "doc"];

/** The kind of an `evidence` reference, or undefined when it is not one this record shape names. */
export function evidenceKind(ref: string): EvidenceKind | undefined {
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const prefix = ref.slice(0, colon) as EvidenceKind;
    if (EVIDENCE_PREFIXES.includes(prefix) && ref.length > colon + 1) return prefix;
  }
  return /^[^\s@:]+@\S+$/.test(ref) ? "conversation" : undefined;
}

/**
 * A record's scope, with records older than the field mapped to the visibility they had.
 * Returns the stored value as given when present — `admits` decides what an unknown one means.
 */
export function scopeOf(record: MemoryRecord, tier: MemoryTier): string {
  if (record.scope !== undefined) return record.scope;
  if (tier === "own") return "agent";
  if (record.audience === "everyone" && record.held === undefined) return "org";
  return record.box !== undefined ? `box:${record.box}` : "org";
}

/** Whether `record`, held by agent `holder` (its file's agent, or the shared writer `via`), admits `reader`. */
export function admits(record: MemoryRecord, tier: MemoryTier, holder: string | undefined, reader: MemoryReader): boolean {
  return scopeAdmits(scopeOf(record, tier), holder, reader);
}

/** Whether a scope, on whatever it is stamped (a record, a site learnings file — INV-1728), admits `reader`. */
export function scopeAdmits(scope: unknown, holder: string | undefined, reader: MemoryReader): boolean {
  if (scope === "agent") return holder !== undefined && holder === reader.agentId;
  if (scope === "org") return true;
  if (typeof scope !== "string" || !scope.startsWith("box:")) return false;
  const box = reader.boxById(scope.slice("box:".length));
  return box !== undefined && box.id === reader.boxId && mayEnterBox(box, reader.principalId);
}

/**
 * The one admission check, before ranking: the records of `tier` this reader may read at all.
 * An own-tier record is held by the reader (it is the reader's file); a shared one by its writer.
 */
export function admitted(records: readonly MemoryRecord[], tier: MemoryTier, reader: MemoryReader): MemoryRecord[] {
  return records.filter(record => admits(record, tier, tier === "own" ? reader.agentId : record.via, reader));
}

/** What may enter recall and the prompt: everything but `cite-only` (and a surface nobody defined). */
export function recallable(records: readonly MemoryRecord[]): MemoryRecord[] {
  return records.filter(record => record.surface === undefined || record.surface === "recall");
}

/** An admitted record by its version id, whatever its surface: the only way a `cite-only` item is read. */
export function citedById(admittedRecords: readonly MemoryRecord[], id: string): MemoryRecord | undefined {
  return admittedRecords.find(record => record.kind !== "retraction" && versionOf(record) === id);
}
