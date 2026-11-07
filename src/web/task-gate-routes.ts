/**
 * The gate's verdicts on one task's steps (INV-1672): `GET /api/tasks/gate?task=t12`.
 *
 * The chat marks each tool step with the gate's verdict (INV-1664); the task card only linked to
 * the conversation, so "how many of this task's steps asked you, and why was one refused" took
 * reading the whole thread. This answers it for the task card from the same two sources the chat
 * uses — the assignee's transcript of the task's conversation, mapped by `toDisplayEntries`, and
 * `PolicyGate.verdicts` joined by tool_use id — so a step carries the mark here that it carries
 * there, and a step the gate never checked carries none.
 *
 * Which steps are the task's: those of every turn in its conversation that ran while the task was
 * `doing` there — `doing` in a conversation is how the gate itself finds a turn's task
 * (`currentTaskOf`). A turn counts whole, so the turn that took the task and the steps after the
 * agent moved it to review in that same turn are the task's; a step outside any turn (an entry
 * written before turns were recorded) is placed by its own time.
 */

import type { ServerResponse } from "node:http";
import type { GateVerdict, GateVerdictKind } from "../host/gate-verdict.ts";
import type { Task, TaskStore } from "../host/tasks.ts";
import { type RosterEntry, toDisplayEntries } from "./transcript.ts";
import { apiError } from "./api-error.ts";

export const TASK_GATE_ROUTE = "GET /api/tasks/gate";

/** How many steps the list carries, newest kept; the counts cover every step. */
export const TASK_GATE_STEPS = 200;

export interface TaskGateStep {
  name: string;
  /** The argument that identifies the call, as the chat shows it, cut to a line. */
  detail: string;
  at?: string;
  /** Absent when the gate did not check this step. */
  gate?: GateVerdict;
}

export interface TaskGate {
  counts: Record<GateVerdictKind, number>;
  /** Steps the gate did not check, or checked longer ago than the verdicts it keeps. */
  unchecked: number;
  /** In order, oldest first: the newest `TASK_GATE_STEPS` of them. */
  steps: TaskGateStep[];
  /** How many older steps the list left out. */
  earlier: number;
}

/** When the task was `doing`, from its history: open spans run to now. */
export function doingSpans(task: Pick<Task, "status" | "createdAt" | "history">): { from: string; to?: string }[] {
  const spans: { from: string; to?: string }[] = [];
  let open: string | undefined;
  for (const change of task.history) {
    if (change.status === undefined) continue;
    if (change.status === "doing" && open === undefined) open = change.at;
    else if (change.status !== "doing" && open !== undefined) { spans.push({ from: open, to: change.at }); open = undefined; }
  }
  if (open !== undefined) spans.push({ from: open });
  // The history is bounded: a task still doing whose move to doing was cut off ran from its start.
  if (spans.length === 0 && task.status === "doing") spans.push({ from: task.createdAt });
  return spans;
}

/** The task's steps and the gate's verdict on each, from its conversation's transcript. */
export function taskGateOf(
  task: Pick<Task, "status" | "createdAt" | "history">,
  entries: readonly unknown[],
  roster: readonly RosterEntry[],
  verdictOf: (callId: string) => GateVerdict | undefined
): TaskGate {
  const spans = doingSpans(task);
  const overlaps = (from: string, to: string) => spans.some(span => to >= span.from && (span.to === undefined || from <= span.to));
  // Each turn's first and last moment, so a turn is the task's when any of it ran while the task was doing.
  const turns = new Map<string, { from: string; to: string }>();
  for (const raw of entries) {
    const entry = (raw ?? {}) as { at?: unknown; turnId?: unknown };
    if (typeof entry.turnId !== "string" || typeof entry.at !== "string") continue;
    const seen = turns.get(entry.turnId);
    if (seen === undefined) turns.set(entry.turnId, { from: entry.at, to: entry.at });
    else { if (entry.at < seen.from) seen.from = entry.at; if (entry.at > seen.to) seen.to = entry.at; }
  }
  const steps: TaskGateStep[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = (entries[index] ?? {}) as { kind?: unknown; at?: unknown; turnId?: unknown };
    if (entry.kind !== "blocks") continue;
    const at = typeof entry.at === "string" ? entry.at : undefined;
    const turn = typeof entry.turnId === "string" ? turns.get(entry.turnId) : undefined;
    if (turn !== undefined ? !overlaps(turn.from, turn.to) : at === undefined || !overlaps(at, at)) continue;
    // The call and the results that answer it, mapped exactly as the chat maps them.
    const next = entries[index + 1] as { kind?: unknown } | undefined;
    const pair = next?.kind === "results" ? [entry, next] : [entry];
    for (const shown of toDisplayEntries(pair, roster, verdictOf)) {
      if (shown.kind !== "tools") continue;
      for (const tool of shown.tools) {
        steps.push({ name: tool.name, detail: tool.detail.split("\n")[0]!.slice(0, 160), ...(at !== undefined ? { at } : {}), ...(tool.gate !== undefined ? { gate: tool.gate } : {}) });
      }
    }
  }
  const counts: Record<GateVerdictKind, number> = { allowed: 0, asked: 0, waiting: 0, refused: 0 };
  for (const step of steps) if (step.gate !== undefined) counts[step.gate.verdict]++;
  const earlier = Math.max(0, steps.length - TASK_GATE_STEPS);
  return { counts, unchecked: steps.filter(step => step.gate === undefined).length, steps: steps.slice(earlier), earlier };
}

/** Handles the route and answers true; false for any other route. */
export function taskGateRoute(
  route: string,
  url: URL,
  res: ServerResponse,
  deps: {
    tasks: TaskStore | undefined;
    mayReadTask: (task: Task) => boolean;
    readTranscript: (agentId: string, conversation?: string) => unknown[];
    roster: () => RosterEntry[];
    verdictOf: (callId: string) => GateVerdict | undefined;
    send: (res: ServerResponse, status: number, body: unknown) => void;
  }
): boolean {
  if (route !== TASK_GATE_ROUTE) return false;
  const task = deps.tasks?.get(url.searchParams.get("task") ?? "");
  // Unknown and unreadable answer alike, so the route does not say which tasks exist.
  if (task === undefined || !deps.mayReadTask(task)) {
    deps.send(res, 404, apiError("task-none"));
    return true;
  }
  // Nobody assigned: no agent ran a turn on it, so there are no steps to show.
  const entries = task.assigneeId ? deps.readTranscript(task.assigneeId, task.conversation) : [];
  deps.send(res, 200, taskGateOf(task, entries, deps.roster(), deps.verdictOf));
  return true;
}
