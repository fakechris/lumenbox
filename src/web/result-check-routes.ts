import { apiError } from "./api-error.ts";
import { evidenceDigest } from "../host/review-dispatch.ts";
import { checkGoal, type ResultChecks } from "../host/result-check-policy.ts";
import type { TaskStore } from "../host/tasks.ts";

export async function resultCheckRoute(route: string, url: URL, deps: { checks: ResultChecks; tasks?: TaskStore; refused: (write: boolean) => boolean; mayRead: (task: NonNullable<ReturnType<TaskStore["get"]>>) => boolean; readJson: () => Promise<Record<string, unknown>>; by: string }) {
  if (route !== "GET /api/tasks/checks" && route !== "POST /api/tasks/checks") return undefined;
  if (deps.refused(route.startsWith("POST"))) return { status: 0, body: {} };
  const body = route.startsWith("POST") ? await deps.readJson() : {};
  const task = deps.tasks?.get(String(body.id ?? url.searchParams.get("id") ?? ""));
  if (!task || !deps.mayRead(task)) return { status: 404, body: apiError("task-check-unknown") };
  if (route.startsWith("GET")) return { status: 200, body: { goalVersion: checkGoal(task), evidenceVersion: evidenceDigest(task), check: deps.checks.snapshot(task) } };
  if (body.expectedGoal !== checkGoal(task) || body.expectedEvidence !== evidenceDigest(task)) return { status: 409, body: apiError("task-check-stale") };
  try {
    if (body.action === "stop") deps.checks.stop(task, String(body.planId ?? ""), "Stopped by the operator; previous cost reservations remain consumed.");
    else if (body.action === "grant") deps.checks.grant(task, body.policy, deps.by);
    else return { status: 400, body: apiError("task-check-action") };
    return { status: 200, body: { goalVersion: checkGoal(task), evidenceVersion: evidenceDigest(task), check: deps.checks.snapshot(task) } };
  } catch (error) { return { status: 409, body: apiError("task-check-refused", { reason: error instanceof Error ? error.message : "unavailable" }) }; }
}
