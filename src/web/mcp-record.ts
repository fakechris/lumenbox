/**
 * A task as the record has it, for a caller that reads facts rather than prose (INV-1506, docs/90 §3.1).
 *
 * `task_status` answered in a paragraph, so a supervisor outside judged progress by parsing our
 * wording — believing the report again, one step removed. This is the same task as data: the
 * contract's outcome, the stage table's row, the mandate as it stands, the last moves, and for
 * a goal the gate's own numbers. Nothing here is a judgement the record does not already hold;
 * no memory, no conversation text, and of files only what was delivered: names and digests, not bytes.
 */

import type { ForkChild } from "../host/fork-events.ts";
import type { Pursuit } from "../host/goal-mode.ts";
import { currentFlag, type TaskFlag } from "../host/task-flag.ts";
import type { StageWorld } from "../host/task-stage.ts";
import { taskStage } from "../host/task-stage.ts";
import type { Task } from "../host/tasks.ts";
import { outcomeOf, type TaskOutcome } from "./mcp-contract.ts";

/** How many moves a record carries; the board keeps more, the text shows them all. */
export const RECORD_HISTORY = 10;
/** How many experiments of a goal's ledger a record carries, newest last. */
export const RECORD_EXPERIMENTS = 5;

export interface PursuitRecord {
  status: Pursuit["status"];
  pausedReason?: Pursuit["pausedReason"];
  objective: string;
  checklist: { id: string; text: string; verdict?: string }[];
  spent: { continuations: number; activeMs: number; cost: number; rejections: number };
  limits: Pursuit["limits"];
  experiments: { n: number; kind: string; hypothesis: string; outcome: string; at: string }[];
  lastVerdict?: { at: string; passed: boolean; nextAction?: string };
}

export interface TaskRecord {
  id: string;
  title: string;
  status: Task["status"];
  outcome: TaskOutcome;
  /** The stage table's row (task-stage.ts); absent when the caller had no world to read it against. */
  stage?: string;
  assignee?: string;
  requester: string;
  mandate?: { by: string; strength: string; state: "valid" | "stale" | "withdrawn"; staleReasons?: string[] };
  createdAt: string;
  updatedAt: string;
  history: { at: string; by: string; status?: string; note?: string }[];
  pursuit?: PursuitRecord;
  /** A supervisor's flag while it holds (INV-1509). */
  flag?: TaskFlag;
  /** What the task handed over (INV-1663), oldest first: fetch_deliverable reads one (INV-1668). */
  deliverables?: { id: string; name: string; size: number; sha256: string; note: string; at: string }[];
  /** The forks of its turns (INV-1667): each child, how it stands, and its chain of events. */
  forks?: ForkRecord[];
}

export interface ForkRecord {
  child: string;
  brief: string;
  status: ForkChild["status"];
  reason?: string;
  lastAt: string;
  steps: ForkChild["steps"];
}

export function forkRecord(fork: ForkChild): ForkRecord {
  return { child: fork.child, brief: fork.brief, status: fork.status, ...(fork.reason !== undefined ? { reason: fork.reason } : {}), lastAt: fork.lastAt, steps: fork.steps.map(step => ({ ...step })) };
}

export function pursuitRecord(pursuit: Pursuit): PursuitRecord {
  return {
    status: pursuit.status,
    ...(pursuit.pausedReason !== undefined ? { pausedReason: pursuit.pausedReason } : {}),
    objective: pursuit.objective,
    checklist: pursuit.checklist.map(item => ({ id: item.id, text: item.text, ...(item.verdict !== undefined ? { verdict: item.verdict } : {}) })),
    spent: { continuations: pursuit.spent.continuations, activeMs: pursuit.spent.activeMs, cost: Math.round(pursuit.spent.cost), rejections: pursuit.spent.rejections },
    limits: pursuit.limits,
    experiments: (pursuit.experiments ?? []).slice(-RECORD_EXPERIMENTS).map(entry => ({ n: entry.n, kind: entry.kind, hypothesis: entry.hypothesis, outcome: entry.outcome, at: entry.at })),
    ...(pursuit.lastVerdict !== undefined
      ? { lastVerdict: { at: pursuit.lastVerdict.at, passed: pursuit.lastVerdict.passed, ...(pursuit.lastVerdict.nextAction !== undefined ? { nextAction: pursuit.lastVerdict.nextAction } : {}) } }
      : {}),
  };
}

/** The mandate as it stands now, read from what the board stored; reading never revalidates (that writes). */
function mandateRecord(task: Task): TaskRecord["mandate"] {
  const mandate = task.mandate;
  if (mandate === undefined) return undefined;
  const state = mandate.withdrawn !== undefined ? "withdrawn" : mandate.stale !== undefined ? "stale" : "valid";
  return { by: mandate.by, strength: mandate.strength, state, ...(state === "stale" ? { staleReasons: [...mandate.stale!.reasons] } : {}) };
}

export function taskRecord(task: Task, deps: { nameOf: (id: string) => string; stageWorld?: (task: Task) => StageWorld; forksOf?: (taskId: string) => readonly ForkChild[] }): TaskRecord {
  const ended = task.status === "done" || task.status === "dropped";
  const stage = deps.stageWorld !== undefined ? taskStage(task, deps.stageWorld(task)) : ended ? "ended" : undefined;
  const mandate = mandateRecord(task);
  const pursuit = task.pursuit;
  const forks = deps.forksOf?.(task.id) ?? [];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    outcome: outcomeOf(task),
    ...(stage !== undefined ? { stage } : {}),
    ...(task.assigneeId !== undefined ? { assignee: deps.nameOf(task.assigneeId) } : {}),
    requester: task.requester,
    ...(mandate !== undefined ? { mandate } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    history: task.history.slice(-RECORD_HISTORY).map(change => ({
      at: change.at,
      by: deps.nameOf(change.by),
      ...(change.status !== undefined ? { status: change.status } : {}),
      ...(change.note !== undefined ? { note: change.note } : {}),
    })),
    ...(pursuit !== undefined ? { pursuit: pursuitRecord(pursuit) } : {}),
    ...(currentFlag(task) !== undefined ? { flag: currentFlag(task)! } : {}),
    ...((task.deliverables ?? []).length > 0 ? { deliverables: task.deliverables!.map(item => ({ id: item.id, name: item.name, size: item.size, sha256: item.sha256, note: item.note, at: item.at })) } : {}),
    ...(forks.length > 0 ? { forks: forks.map(forkRecord) } : {}),
  };
}
