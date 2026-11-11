/**
 * Who checks a claim, and what their checking leaves behind (INV-1614).
 *
 * On 2026-11-03/04 five agents each re-audited the same ninety-odd cards, because nothing in
 * the product said whose job a card was or kept what the last reviewer found. "Check it
 * yourself, do not trust the account" is right for one reviewer and ruinous for five: the
 * protocol was correct and the dispatch was absent.
 *
 * So a claim in review is dispatched to K reviewers (default 2) and to nobody else; each
 * verdict is a record keyed by the claim and a digest of its evidence; K agreeing records
 * settle the claim and anyone else asked about it is shown the record to cite, not a reason
 * to recompute. New evidence changes the digest, which is what makes the old records stale
 * and sends the claim round again — a dissent stops the check rather than buying another reviewer.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { settleAudit } from "./audit.ts";
import { appendLine } from "./jsonl.ts";
import type { Task } from "./tasks.ts";

export const DEFAULT_REVIEWERS_PER_CLAIM = 2;
/** The actor name on board moves this machinery makes. */
export const REVIEW_ACTOR = "review-guard";

export type Verdict = "pass" | "fail" | "none";

export interface VerificationRecord {
  taskId: string;
  /** The claim as it stood: digest of the evidence, the acceptance and the description. */
  digest: string;
  reviewerId: string;
  verdict: Verdict;
  /** What the verdict rested on, in the reviewer's words; bounded. */
  basis: string;
  at: string;
}

/** The digest of what a reviewer is judging; evidence that changes changes it, which retires every record under the old one. */
export function evidenceDigest(task: Pick<Task, "id" | "title" | "description" | "contract" | "history">): string {
  const evidence = [...task.history].reverse().find(change => change.evidence !== undefined && change.evidence.length > 0)?.evidence ?? [];
  const body = JSON.stringify([task.id, task.title, task.description ?? "", task.contract?.acceptance ?? "", evidence]);
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * The K reviewers for a claim, the same K each time it is asked: the named reviewer first,
 * then the rest of the team ordered by a hash of task and agent, never the assignee or the
 * requester. Stable so that two questions about one claim land on one set of people.
 */
export function pickReviewers(task: Pick<Task, "id" | "assigneeId" | "requester" | "reviewerId">, candidates: readonly string[], k: number): string[] {
  const eligible = candidates.filter(id => id !== task.assigneeId && id !== task.requester);
  const named = task.reviewerId !== undefined && eligible.includes(task.reviewerId) ? [task.reviewerId] : [];
  const rest = eligible
    .filter(id => !named.includes(id))
    .sort((a, b) => createHash("sha256").update(`${task.id}:${a}`).digest("hex").localeCompare(createHash("sha256").update(`${task.id}:${b}`).digest("hex")));
  return [...named, ...rest].slice(0, Math.max(0, k));
}

/** A reviewer's reply as a record's verdict: the audit parser decides, and no verdict is "none", never a pass. */
export function verdictOf(task: Pick<Task, "contract">, reply: string): { verdict: Verdict; basis: string } {
  const settled = settleAudit(task, reply);
  const verdict: Verdict = settled.verdict === undefined ? "none" : settled.verdict.passed ? "pass" : "fail";
  return { verdict, basis: settled.note.slice(0, 300) };
}

export interface Settled {
  verdict: "pass" | "fail";
  by: string[];
  digest: string;
}

/** The records, on disk as JSONL when a path is given, in memory otherwise (tests). */
export class VerificationLedger {
  private readonly records: VerificationRecord[] = [];

  constructor(private readonly path?: string) {
    if (path !== undefined && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try { this.put(JSON.parse(line) as VerificationRecord); } catch { /* a torn last line is the only expected shape */ }
      }
    }
  }

  /** One record per reviewer per claim-and-digest: a reviewer who answers twice has one answer, the last. */
  add(record: Omit<VerificationRecord, "at"> & { at?: string }): VerificationRecord {
    const full: VerificationRecord = { ...record, basis: record.basis.slice(0, 300), at: record.at ?? new Date().toISOString() };
    this.put(full);
    if (this.path !== undefined) appendLine(this.path, JSON.stringify(full));
    return full;
  }

  private put(full: VerificationRecord): void {
    const index = this.records.findIndex(r => r.taskId === full.taskId && r.digest === full.digest && r.reviewerId === full.reviewerId);
    if (index >= 0) this.records[index] = full; else this.records.push(full);
  }

  /** The records under this claim and digest, oldest first. */
  recordsFor(taskId: string, digest: string): VerificationRecord[] {
    return this.records.filter(r => r.taskId === taskId && r.digest === digest);
  }

  /** Every record for the task, any digest, oldest first — what History shows. */
  historyFor(taskId: string): VerificationRecord[] {
    return this.records.filter(r => r.taskId === taskId);
  }

  /** Settled when K independent records agree; a "none" never counts toward either side. */
  settled(taskId: string, digest: string, k: number): Settled | undefined {
    const records = this.recordsFor(taskId, digest);
    for (const verdict of ["pass", "fail"] as const) {
      const by = records.filter(r => r.verdict === verdict).map(r => r.reviewerId);
      if (by.length >= Math.max(1, k)) return { verdict, by, digest };
    }
    return undefined;
  }
}

/**
 * What to do with a claim in review: nothing but a citation when it is settled under the
 * evidence as it stands; otherwise the reviewers still owed a verdict, up to K. Reviewers who
 * split (one pass, one fail) are not a settlement; a person decides.
 */
export function planRound(
  task: Pick<Task, "id" | "title" | "description" | "contract" | "history" | "assigneeId" | "requester" | "reviewerId">,
  ledger: VerificationLedger,
  candidates: readonly string[],
  k: number
): { digest: string; settled?: Settled; reviewers: string[] } {
  const digest = evidenceDigest(task);
  const settled = ledger.settled(task.id, digest, k);
  if (settled !== undefined) return { digest, settled, reviewers: [] };
  const answered = ledger.recordsFor(task.id, digest).map(r => r.reviewerId);
  const chosen = pickReviewers(task, candidates, k).filter(id => !answered.includes(id));
  return { digest, reviewers: chosen };
}

/** The line an agent reads instead of recomputing, or undefined when nothing is settled. */
export function citationFor(task: Pick<Task, "id" | "title" | "description" | "contract" | "history">, ledger: VerificationLedger, k: number, nameOf: (id: string) => string): string | undefined {
  const digest = evidenceDigest(task);
  const settled = ledger.settled(task.id, digest, k);
  if (settled === undefined) return undefined;
  return `verified ${settled.verdict === "pass" ? "complete" : "not complete"} by ${settled.by.map(nameOf).join(", ")} on evidence ${digest} — cite this record rather than re-checking; new evidence (not a repeated opinion) is what reopens it`;
}

/** The record as the History shows it, one line each. */
export function recordLines(records: readonly VerificationRecord[], nameOf: (id: string) => string): string[] {
  return records.map(r => `${r.at} ${nameOf(r.reviewerId)} · ${r.verdict} on ${r.digest}: ${r.basis}`);
}

export interface RoundDeps {
  ledger: VerificationLedger;
  k: number;
  /** The team: who may be a reviewer. */
  candidates: () => string[];
  nameOf: (id: string) => string;
  /** Sends one reviewer the audit prompt and returns what it said. */
  ask: (reviewerId: string, task: Task) => Promise<{ reply: string; voided?: string }>;
  /** The board, as it stands when the round ends. */
  current: (taskId: string) => Task | undefined;
  move: (taskId: string, change: { status?: "review" | "doing" | "done"; note: string }) => void;
  /** Whether an id is one of the agents (INV-1647): an agent's own ask is done when the record passes; a person's waits for their word. */
  isAgent?: (id: string) => boolean;
  log: (line: string) => void;
}

/**
 * One review round for a claim: the K owed reviewers are asked at once, each verdict goes on
 * the record, and the record — not any one reply — moves the task. Settled pass is done when
 * the requester is an agent (INV-1647) and stays in review for a person's word otherwise, the
 * citation on it either way; settled fail goes back to doing with the findings; a split is said
 * and stops at the configured reviewer count.
 */
export async function reviewRound(deps: RoundDeps, task: Task): Promise<{ asked: string[]; settled?: Settled }> {
  const plan = planRound(task, deps.ledger, deps.candidates(), deps.k);
  if (plan.settled !== undefined) {
    deps.log(`${task.id}: settled ${plan.settled.verdict} under ${plan.digest} by ${plan.settled.by.length}; nobody is asked again`);
    return { asked: [], settled: plan.settled };
  }
  if (plan.reviewers.length === 0) {
    deps.log(`${task.id}: no reviewer left to ask under ${plan.digest}; a person decides`);
    return { asked: [] };
  }
  await Promise.all(plan.reviewers.map(async reviewerId => {
    try {
      const answer = await deps.ask(reviewerId, task);
      if (answer.voided !== undefined) {
        deps.ledger.add({ taskId: task.id, digest: plan.digest, reviewerId, verdict: "none", basis: `void: ${answer.voided}` });
        return;
      }
      const { verdict, basis } = verdictOf(task, answer.reply);
      deps.ledger.add({ taskId: task.id, digest: plan.digest, reviewerId, verdict, basis });
    } catch (error) {
      deps.ledger.add({ taskId: task.id, digest: plan.digest, reviewerId, verdict: "none", basis: "The check failed before producing a verdict; no automatic retry." });
      deps.log(`${task.id}: ${deps.nameOf(reviewerId)}'s review failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  const now = deps.current(task.id);
  // A reviewer who moved the task itself has said what it found; only one left in review is settled by the record.
  if (now === undefined || now.status !== "review" || evidenceDigest(now) !== plan.digest) return { asked: plan.reviewers };
  const settled = deps.ledger.settled(task.id, plan.digest, deps.k);
  const records = deps.ledger.recordsFor(task.id, plan.digest);
  if (settled === undefined) {
    const said = records.filter(r => r.verdict !== "none");
    deps.move(task.id, { status: "review", note: said.length >= deps.k ? `reviewers disagree (${said.map(r => `${deps.nameOf(r.reviewerId)}: ${r.verdict}`).join(", ")}); no additional reviewers; a person decides` : `audit gave ${records.length - said.length} void or no-verdict repl${records.length - said.length === 1 ? "y" : "ies"}; not accepted — a person decides` });
    return { asked: plan.reviewers };
  }
  const names = settled.by.map(deps.nameOf).join(", ");
  if (settled.verdict === "pass") {
    const agentsOwn = deps.isAgent?.(now.requester) === true;
    deps.move(task.id, { status: agentsOwn ? "done" : "review", note: `verified complete by ${names} on evidence ${plan.digest}; ${agentsOwn ? "the requester is an agent, so the record closes it" : "awaiting the requester's acceptance"} — others cite this record rather than re-checking` });
  } else {
    const findings = records.filter(r => r.verdict === "fail").map(r => r.basis).join(" | ");
    deps.move(task.id, { status: "doing", note: `verified not complete by ${names} on evidence ${plan.digest}: ${findings}`.slice(0, 480) });
  }
  return { asked: plan.reviewers, settled };
}
