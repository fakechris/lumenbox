/** Explicit delivery intentions. Rejections are receipts, never implicit review submissions. */
import type { Task, TaskStore, TaskChange } from "./tasks.ts";
import { evidenceDigest } from "./review-dispatch.ts";

export const DELIVERY_ACTIONS = ["submit", "request_check", "accept", "handoff"] as const;
export type DeliveryAction = typeof DELIVERY_ACTIONS[number];
export interface DeliveryRecord { action: DeliveryAction; version: string; by: string; at: string; submitted?: boolean; checkRequested?: boolean }
export interface DeliveryOptions { note?: string; evidence?: string[]; checked?: string[]; expectedVersion?: string; generation?: number; epoch?: number }
export interface DeliveryResult { task: Task; outcome: "applied" | "unchanged" | "refused"; coerced?: string }
export function isDeliveryAction(value: unknown): value is DeliveryAction { return DELIVERY_ACTIONS.includes(value as DeliveryAction); }

export function deliverTask(board: TaskStore, id: string, action: DeliveryAction, by: string, options: DeliveryOptions = {}, run?: string, now = new Date()): DeliveryResult | undefined {
  const task = board.get(id);
  if (!task) return undefined;
  const refused = (reason: string): DeliveryResult => { board.refuseDelivery(task, by, reason, now); return { task, outcome: "refused", coerced: reason }; };
  if (!isDeliveryAction(action)) return refused("Unknown delivery action; use submit, request_check, accept or handoff.");
  const root = task.workRoot?.state;
  if (root?.status === "cancelled") return refused("This work was cancelled; a late delivery cannot restart it.");
  if (root?.unresolved) return refused("Historical execution is unverified; establish the work's provenance before submitting a result.");
  if (options.generation !== undefined && root?.generation !== options.generation || options.epoch !== undefined && root?.epoch !== options.epoch) return refused("The work version changed; read the current task before delivering.");
  if (options.expectedVersion !== undefined && options.expectedVersion !== evidenceDigest(task)) return refused("The evidence changed; read the current task before delivering.");
  if (action !== "accept" && !board.mayDeliver(task, by, action)) return refused("Only this task's requester, assignee or reviewer may submit or request a check.");
  if (task.status === "dropped" || task.status === "done" && action !== "accept") return refused("This task has ended; delivery does not reopen it.");
  if (action === "request_check" && task.status !== "review") return refused("Submit the result first, then request a check of that result.");
  const evidence = options.evidence?.map(line => line.trim().slice(0, 300)).filter(Boolean).slice(0, 6);
  const version = evidenceDigest(evidence?.length ? { ...task, history: [...task.history, { at: now.toISOString(), by, evidence }] } : task);
  if (action === "request_check" && version !== evidenceDigest(task)) return refused("New evidence must be submitted before requesting its check.");
  if (action === "accept" && !board.mayDeliver(task, by, action)) return refused("Only the authorized requester or reviewer may accept this result.");
  const previous = task.delivery?.version === version ? task.delivery : undefined;
  const submitted = previous?.submitted ?? previous?.action === "submit";
  const checkRequested = previous?.checkRequested ?? previous?.action === "request_check";
  if (action === "request_check" && previous?.action === "handoff" && !submitted) return refused("This execution handed back incomplete work; submit a result before requesting a check.");
  if (action === "submit" && submitted || action === "request_check" && checkRequested) return task.status === "review" ? { task, outcome: "unchanged" } : refused("This evidence was already submitted. Update the evidence before submitting again.");
  if (previous?.action === action && (action === "accept" && task.status === "done" || action === "handoff" && task.status === "review" && options.note === task.history.at(-1)?.note)) return { task, outcome: "unchanged" };
  const delivery: DeliveryRecord = { action, version, by, at: now.toISOString(), ...(submitted || action === "submit" ? { submitted: true } : {}), ...(checkRequested || action === "request_check" ? { checkRequested: true } : {}) };
  const updated = board.update(id, { status: action === "accept" ? "done" : "review", ...options, ...(evidence ? { evidence } : {}), delivery }, by, run, now);
  if (!updated) return undefined;
  return { ...updated, outcome: updated.coerced ? "refused" : "applied" };
}

export function requestsResultCheck(change: TaskChange | undefined): boolean {
  return change?.delivery?.action === "submit" || change?.delivery?.action === "request_check";
}
