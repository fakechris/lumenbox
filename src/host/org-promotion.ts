/**
 * Promotion into the organisation's knowledge, and its review (INV-1729, docs/98 §5 and §10
 * decisions 2 and 4).
 *
 * L1 is written one way: somebody points at something that already exists — a memory, a finished
 * task, a receipt — and proposes it as an organisation item. Nothing reaches L1 by extraction,
 * and nothing an agent proposes is read by anyone until a person approves it.
 *
 * - **Proposing.** `propose` appends a *held* item to the ledger (`org-knowledge.ts`): held lines
 *   are read by nobody (`dedupe` skips them), so the proposal is in the history and out of every
 *   turn. It names its source, carries at least one evidence reference, and has an owner.
 * - **The owner** is the member who drove the turn that proposed it; for a routine's run, the
 *   routine's creating principal (docs/22 §2). A turn with neither — nobody to stand behind it — is
 *   refused rather than given an owner nobody chose (`promotionOwner`). An Admin's promotion is
 *   owned by that Admin.
 * - **Deciding.** `decide` appends the decision as a line of its own, so the log stays the only
 *   truth (as team memory review does, INV-1581): approved is the item again, without the hold,
 *   with the approver as `verifiedBy` and the time as `verifiedAt`; rejected is the item again,
 *   still held, marked rejected — never live, and on record.
 * - **Review is always on.** There is no setting here and none anywhere else: this module takes no
 *   option, and every path into L1 goes through `propose`. L2 review stays the installation's
 *   option (team-memory-review.ts); L1's is not (docs/98 §5 rule 4).
 * - **What it widens.** `readersOf` says who reads an item once approved, for the review page:
 *   every member's agents for `org`, the box's agents for its members for `box:<id>`, and nobody
 *   for a box that no longer exists — which cannot be approved.
 */

import type { BoxEntry } from "../box/boxes.ts";
import { dedupe, dedupeKey, type MemoryRecord, validateRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";
import { evidenceKind, type MemoryScope } from "./memory-scope.ts";
import { type OrgKnowledge, type OrgKnowledgeItem, orgItemId, PersonalInstallationNeverWrites } from "./org-knowledge.ts";
import { type Receipt, receiptId } from "./receipts.ts";
import type { Task } from "./tasks.ts";

export const ORG_REVIEW_QUESTION = "waiting for a person to approve it into the organisation's knowledge (always reviewed)";
const ORG_REJECTED_QUESTION = "rejected in organisation knowledge review";

/** What a promotion points at: something that already exists. */
export type PromotionSource =
  | { kind: "memory"; record: MemoryRecord; holder: string }
  | { kind: "task"; task: Pick<Task, "id" | "title" | "status" | "deliverables"> }
  | { kind: "receipt"; receipt: Receipt };

export interface PromotionRequest {
  source: PromotionSource;
  /** The statement for the organisation; when absent, a memory's own text or a receipt's decision (a task needs one). */
  text?: string;
  scope: Extract<MemoryScope, "org" | `box:${string}`>;
  /** The principal accountable (`promotionOwner`, or the promoting Admin). */
  owner: string;
  /** The agent that proposed it, when an agent did; absent for an Admin's promotion. */
  via?: string;
  /** References beyond what the source already gives. */
  evidence?: readonly string[];
  /** The version of the organisation item this one would replace once approved (maintenance's supersession, INV-1732); the review page shows it. */
  supersedes?: string;
}

export type PromotionResult = { ok: true; item: OrgKnowledgeItem; version: string } | { ok: false; code: PromotionRefusal; why: string };

/** Why a promotion or a decision was refused, as a stable code a route maps to its words. */
export type PromotionRefusal = "no-owner" | "not-finished" | "no-evidence" | "invalid" | "duplicate" | "personal" | "not-pending" | "no-readers";

/**
 * Who owns an item an agent proposes (docs/98 §10 question 2): the member who drove the turn;
 * for a routine's run, the routine's creating principal; otherwise nobody, and the promotion is
 * refused. Routines do not record their creating principal yet, so today a routine's run passes
 * none and its promotions wait for a member or an Admin.
 */
export function promotionOwner(turn: { caller?: string; routineCreator?: string }): string | undefined {
  if (turn.caller !== undefined && turn.caller !== "") return turn.caller;
  if (turn.routineCreator !== undefined && turn.routineCreator !== "") return turn.routineCreator;
  return undefined;
}

/** The reference a source gives an item's `source` field: what was promoted. */
export function sourceRef(source: PromotionSource): string {
  if (source.kind === "memory") return `memory:${source.holder}/${versionOf(source.record)}`;
  if (source.kind === "task") return `task:${source.task.id}`;
  return `receipt:${receiptId(source.receipt)}`;
}

/** The evidence a source carries by itself: where a memory came from, a task and what it delivered, a receipt and what it cites. */
export function sourceEvidence(source: PromotionSource): string[] {
  const refs = source.kind === "memory"
    ? [...(source.record.from ?? []), ...(source.record.evidence ?? [])]
    : source.kind === "task"
      ? [`task:${source.task.id}`, ...(source.task.deliverables ?? []).map(file => `deliverable:${source.task.id}/${file.id}`)]
      : [`receipt:${receiptId(source.receipt)}`, ...(source.receipt.evidence ?? [])];
  return refs.filter(ref => evidenceKind(ref) !== undefined);
}

export interface PendingPromotion {
  version: string;
  item: OrgKnowledgeItem;
}

/** Proposals with no decision recorded after them, oldest first. */
export function pendingPromotions(lines: readonly OrgKnowledgeItem[]): PendingPromotion[] {
  const decided = new Set(lines.filter(line => line.review !== undefined).map(line => line.review!.of));
  return lines
    .filter(line => line.held?.question === ORG_REVIEW_QUESTION && line.review === undefined)
    .map(item => ({ version: versionOf(item), item }))
    .filter(pending => !decided.has(pending.version));
}

/** Who reads an item of `scope` once it is approved: every member, a box's members, or nobody. */
export type Readers = { kind: "org" } | { kind: "box"; boxId: string; boxName: string; members: BoxEntry["members"] } | { kind: "nobody" };

export function readersOf(scope: string | undefined, boxById: (id: string) => Pick<BoxEntry, "id" | "name" | "members"> | undefined): Readers {
  if (scope === "org") return { kind: "org" };
  if (typeof scope !== "string" || !scope.startsWith("box:")) return { kind: "nobody" };
  const box = boxById(scope.slice("box:".length));
  return box === undefined ? { kind: "nobody" } : { kind: "box", boxId: box.id, boxName: box.name, members: box.members };
}

type Ledger = Pick<OrgKnowledge, "append" | "lines">;

function attempt(write: () => OrgKnowledgeItem): PromotionResult {
  try {
    const item = write();
    return { ok: true, item, version: versionOf(item) };
  } catch (error) {
    if (error instanceof PersonalInstallationNeverWrites) return { ok: false, code: "personal", why: error.message };
    return { ok: false, code: "invalid", why: error instanceof Error ? error.message : String(error) };
  }
}

/** Proposes `request` as an organisation item: held, owned, with evidence. Never live until `decide` approves it. */
export function propose(ledger: Ledger, request: PromotionRequest, now: Date = new Date()): PromotionResult {
  const { source } = request;
  if (request.owner === "") return { ok: false, code: "no-owner", why: "An organisation item needs a person accountable for it." };
  if (source.kind === "task" && source.task.status !== "done") return { ok: false, code: "not-finished", why: `${source.task.id} is ${source.task.status}; only a finished task's outcome is promoted.` };
  const text = (request.text ?? (source.kind === "memory" ? source.record.text : source.kind === "receipt" ? source.receipt.decision : "")).trim();
  const invalid = validateRecord(text);
  if (invalid !== undefined) return { ok: false, code: "invalid", why: text === "" ? "Say in one sentence what the organisation should know from it." : invalid.reason };
  const evidence = [...new Set([...sourceEvidence(source), ...(request.evidence ?? [])])];
  const bad = evidence.find(ref => evidenceKind(ref) === undefined);
  if (bad !== undefined) return { ok: false, code: "invalid", why: `\`${bad}\` is not an evidence reference: task:, deliverable:, receipt:, routine:, inv:, commit:, doc:, or <conversation>@<time>.` };
  if (evidence.length === 0) return { ok: false, code: "no-evidence", why: "Say what it rests on: at least one evidence reference (task:t12, inv:INV-1581, commit:<sha>, doc:docs/98, <conversation>@<time>)." };
  const key = dedupeKey(text);
  const same = (item: OrgKnowledgeItem) => dedupeKey(item.text) === key && item.scope === request.scope;
  const waiting = pendingPromotions(ledger.lines()).find(pending => same(pending.item));
  if (waiting !== undefined) return { ok: false, code: "duplicate", why: `That is already waiting for review (${orgItemId(waiting.item)}).` };
  const known = (dedupe(ledger.lines()) as OrgKnowledgeItem[]).find(same);
  if (known !== undefined) return { ok: false, code: "duplicate", why: `The organisation already knows that (${orgItemId(known)}).` };
  return attempt(() => ledger.append({
    at: now.toISOString(),
    kind: "fact",
    text,
    scope: request.scope,
    surface: "recall",
    owner: request.owner,
    evidence,
    source: `promoted from ${sourceRef(source)}`,
    ...(request.via !== undefined ? { via: request.via } : {}),
    ...(request.supersedes !== undefined ? { supersedes: request.supersedes } : {}),
    held: { question: ORG_REVIEW_QUESTION, confidence: 1 },
  }));
}

/**
 * Records a person's decision on a waiting proposal. Approved: the item again, live, with `by` as
 * `verifiedBy`; `pinned` puts it in every turn's "how we work". Rejected: the item again, still
 * held, marked rejected. A proposal whose box no longer exists is readable by nobody and cannot be approved.
 */
export function decide(
  ledger: Ledger,
  version: string,
  decision: "approved" | "rejected",
  by: string,
  boxById: (id: string) => Pick<BoxEntry, "id" | "name" | "members"> | undefined,
  options: { pinned?: boolean; now?: Date } = {}
): PromotionResult {
  const pending = pendingPromotions(ledger.lines()).find(item => item.version === version);
  if (pending === undefined) return { ok: false, code: "not-pending", why: "That proposal is not waiting for review: it was decided already, or never proposed." };
  if (decision === "approved" && readersOf(pending.item.scope, boxById).kind === "nobody") return { ok: false, code: "no-readers", why: "The box it was proposed for no longer exists, so nobody could read it. Reject it, or promote it again for a box that exists." };
  const { held: _held, ...rest } = pending.item;
  const at = (options.now ?? new Date()).toISOString();
  const review = { of: version, decision, by };
  return attempt(() => ledger.append(decision === "approved"
    ? { ...rest, at, review, verifiedBy: by, verifiedAt: at, ...(options.pinned === true ? { pinned: true } : {}) }
    : { ...rest, at, review, held: { question: ORG_REJECTED_QUESTION, confidence: 1 } }));
}
