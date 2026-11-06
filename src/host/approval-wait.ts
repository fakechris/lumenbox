/**
 * Which pending approvals still hold a turn, and which are only history (INV-1622).
 *
 * A pending approval used to block the whole agent: no goal, no supervision, no context
 * switch while one was open anywhere. On 2026-11-05 that was a command Vic asked about the
 * day before, in a conversation whose turn had long ended. The only approval that can confuse
 * a context switch is one a turn in *this* conversation is still parked on — the person's later
 * yes or no would land in a conversation that moved. So that is the only one that blocks.
 *
 * The rest expire: when no open turn waits on them any more (the turn was handed back, failed,
 * or was given up on), or after a day. An expired approval is refused on the record, as
 * `approval-expired`, so a late click on its card cannot run it.
 */

import type { InterruptedTurn, OpenStep } from "./resume.ts";
import type { PendingApproval } from "./policy.ts";

/** How long a pending approval may wait for a person before it expires. */
export const APPROVAL_MAX_AGE_MS = 24 * 60 * 60_000;

/** The ledgers' reads this module needs: the turns still open (forks included), and the steps each is parked on. */
export interface OpenTurns {
  turns: { interrupted(options?: { includeForks?: boolean }): readonly InterruptedTurn[] };
  steps: { stepsOf(turnId: string): { open: readonly OpenStep[] } };
}

/** Both ledgers, or nothing when either is not kept (a test, a host without a record). */
export function openTurnsOf(turns: OpenTurns["turns"] | undefined | null, steps: OpenTurns["steps"] | undefined | null): OpenTurns | undefined {
  return turns && steps ? { turns, steps } : undefined;
}

const MAIN = "main";

/** The open turns in one conversation, with the approval ids they wait on. */
function waitsIn(turns: OpenTurns, agentId: string, conversation: string): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns.turns.interrupted({ includeForks: true })) {
    if (turn.agentId !== agentId || (turn.conversation ?? MAIN) !== conversation) continue;
    for (const step of turns.steps.stepsOf(turn.id).open) if (step.approvalId !== undefined) ids.add(step.approvalId);
  }
  return ids;
}

/** The pending approvals a turn in this conversation is parked on — the only ones a context switch must respect. */
export function approvalsHolding(turns: OpenTurns | undefined, agentId: string, conversation: string, pending: readonly PendingApproval[]): PendingApproval[] {
  if (turns === undefined) return [];
  const held = waitsIn(turns, agentId, conversation);
  return pending.filter(approval => approval.agentId === agentId && held.has(approval.id));
}

/** One line a person can act on: which approval, how old, what it asked. */
export function describeHolding(approval: PendingApproval, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(approval.requestedAt)) / 60_000));
  const age = minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  return `审批 ${approval.id.slice(0, 8)} 仍在等人（${age} 前：${approval.description.replace(/\s+/g, " ").slice(0, 80)}）— 在"需要你"里批准或拒绝`;
}

export interface Expired {
  id: string;
  agentName: string;
  reason: string;
}

/**
 * The pending approvals nobody is waiting for any more, or that waited too long. The caller
 * refuses each on the record; this only decides.
 */
export function staleApprovals(turns: OpenTurns | undefined, pending: readonly PendingApproval[], now: number, maxAgeMs = APPROVAL_MAX_AGE_MS): Expired[] {
  const waitedOn = new Set<string>();
  if (turns !== undefined) {
    for (const turn of turns.turns.interrupted({ includeForks: true })) for (const step of turns.steps.stepsOf(turn.id).open) if (step.approvalId !== undefined) waitedOn.add(step.approvalId);
  }
  const stale: Expired[] = [];
  for (const approval of pending) {
    const age = now - Date.parse(approval.requestedAt);
    if (age > maxAgeMs) stale.push({ id: approval.id, agentName: approval.agentName, reason: `waited ${Math.round(age / 3_600_000)} hours for an answer; the limit is ${Math.round(maxAgeMs / 3_600_000)}` });
    else if (turns !== undefined && !waitedOn.has(approval.id) && !(approval.harnessResumes === true)) stale.push({ id: approval.id, agentName: approval.agentName, reason: "the turn that asked has ended; nothing waits on this answer" });
  }
  return stale;
}
