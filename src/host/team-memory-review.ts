/**
 * Team memory a person approves first (INV-1581): an option, off by default.
 *
 * The team tier is read by every agent on every turn, including the ones running a schedule
 * unattended, so one wrong or stale "fact" an agent shares is believed by all of them. With the
 * option on, an agent's write to the team tier is kept *held* — the shape the write-time judge
 * already uses (INV-1333), which no recall, prompt or dedupe ever shows as live — until an admin
 * decides. A decision is a record too, so the log stays the only truth:
 * - approved: the same memory again, without the hold, carrying who approved it — live for all;
 * - rejected: the same memory again, still held, marked rejected — never live, and decided.
 * Pending is a team-review hold with no decision after it. The writer is told its write is
 * waiting; other agents see nothing until approval. An agent's own tier is never reviewed.
 *
 * Team memory is the box's: an agent cannot mark a write for every box (INV-1727, docs/98 §9 row 4
 * retired `audience: "everyone"`, and with it INV-1722's always-held path for such writes).
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { loadConfig } from "../config.ts";
import { dedupeKey, type MemoryRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";

export const TEAM_REVIEW_QUESTION = "waiting for a person to approve it for the whole team (team memory review)";
const REJECTED_QUESTION = "rejected in team memory review";

/** Whether team-tier writes wait for approval: the installation's setting, off unless set. */
export function teamReviewOn(): boolean {
  return loadConfig().teamMemoryReview === true;
}

/** What goes into the team tier: as given, or held for review when the option is on. */
export function forTeamTier(records: readonly MemoryRecord[], on: boolean = teamReviewOn()): MemoryRecord[] {
  return on ? records.map(record => ({ ...record, held: { question: TEAM_REVIEW_QUESTION, confidence: 1 } })) : [...records];
}

export interface PendingReview {
  writer: string;
  version: string;
  record: MemoryRecord;
}

/** Team-review holds with no decision recorded after them, oldest first. */
export function pendingReviews(shared: readonly MemoryRecord[]): PendingReview[] {
  const decided = new Set(shared.filter(record => record.review !== undefined).map(record => `${record.via ?? ""} ${record.review!.of}`));
  return shared
    .filter(record => record.held?.question === TEAM_REVIEW_QUESTION && record.review === undefined)
    .map(record => ({ writer: record.via ?? "", version: versionOf(record), record }))
    .filter(pending => !decided.has(`${pending.writer} ${pending.version}`));
}

/** The writer's own writes still waiting, by dedupe key — for telling it, and for not holding the same thing twice. */
export function pendingOf(shared: readonly MemoryRecord[], writer: string): PendingReview[] {
  return pendingReviews(shared).filter(pending => pending.writer === writer);
}

export type ReviewResult = { ok: true; record: MemoryRecord } | { ok: false; why: string };

/** Records the decision on a pending write, in the writer's own shard. */
export function decideReview(
  registry: Pick<AgentRegistry, "readSharedMemory" | "appendSharedMemory">,
  writer: string,
  version: string,
  decision: "approved" | "rejected",
  by: string,
  now: () => Date = () => new Date()
): ReviewResult {
  const pending = pendingReviews(registry.readSharedMemory()).find(item => item.writer === writer && item.version === version);
  if (pending === undefined) return { ok: false, why: "That write is not waiting for review: it was decided already, or never held." };
  const { held: _held, via: _via, box: _box, ...rest } = pending.record;
  const review = { of: version, decision, by };
  const record: MemoryRecord = decision === "approved"
    ? { ...rest, at: now().toISOString(), review }
    : { ...rest, at: now().toISOString(), review, held: { question: REJECTED_QUESTION, confidence: 1 } };
  registry.appendSharedMemory(writer, [record]);
  return { ok: true, record };
}

/** Whether the writer already has this text waiting, so a second write says so instead of queueing it twice. */
export function alreadyPending(shared: readonly MemoryRecord[], writer: string, text: string): boolean {
  const key = dedupeKey(text);
  return pendingOf(shared, writer).some(pending => dedupeKey(pending.record.text) === key);
}

/** For the writer's Recall: what it shared that is still waiting, so it knows rather than writes it again. */
export function pendingNotice(shared: readonly MemoryRecord[], writer: string): string {
  const mine = pendingOf(shared, writer);
  return mine.length === 0 ? "" : `\n\nWaiting for a person's approval before the team has them (yours, not yet anyone's memory):\n\n${mine.map(p => `- (${p.record.at.slice(0, 10)}) ${p.record.text}`).join("\n")}`;
}
