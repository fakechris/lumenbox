import { apiError } from "./api-error.ts";
import type { ServerResponse } from "node:http";
import { TaskExecutions, ExecutionReset, type ExecutionAccess, type ExecutionFilters } from "./task-execution.ts";

/** The snapshot id and step id are lookup keys, never file paths or authorization. */
export function taskExecutionRoute(route: string, url: URL, res: ServerResponse, deps: {
  executions: TaskExecutions; access: ExecutionAccess;
  record?: (taskId: string) => unknown;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}): boolean {
  if (route !== "GET /api/tasks/execution" && route !== "GET /api/tasks/execution/step") return false;
  const taskId = url.searchParams.get("task") ?? "";
  if (!deps.access.task(taskId)) { deps.send(res, 404, apiError("task-none")); return true; }
  try {
    const snapshot = url.searchParams.get("snapshot");
    const role = url.searchParams.get("role"), outcome = url.searchParams.get("outcome");
    if (role && !["executor", "child", "verifier"].includes(role)) throw new ExecutionReset("invalid role");
    if (outcome && !["running", "succeeded", "failed", "unknown", "waiting", "refused"].includes(outcome)) throw new ExecutionReset("invalid outcome");
    const filters: ExecutionFilters = { ...(role ? { role: role as ExecutionFilters["role"] } : {}),
      ...(outcome ? { outcome } : {}), ...(url.searchParams.has("work") ? { workId: url.searchParams.get("work")! } : {}) };
    if (route.endsWith("/step")) {
      if (!snapshot) throw new ExecutionReset("snapshot required");
      deps.send(res, 200, deps.executions.detail(taskId, deps.access, { snapshot, step: url.searchParams.get("step") ?? "" }));
    } else if (snapshot) {
      deps.send(res, 200, deps.executions.page(taskId, deps.access, { snapshot,
        ...(url.searchParams.has("role") || url.searchParams.has("outcome") || url.searchParams.has("work") ? { filters } : {}),
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(url.searchParams.has("anchor") ? { anchor: url.searchParams.get("anchor")! } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) }));
    } else {
      if (url.searchParams.has("cursor")) throw new ExecutionReset("snapshot required");
      deps.send(res, 200, { ...deps.executions.open(taskId, deps.access, filters, url.searchParams.get("anchor") ?? undefined), ...(deps.record ? { task: deps.record(taskId) } : {}) });
    }
  } catch (error) {
    if (!(error instanceof ExecutionReset)) throw error;
    deps.send(res, 409, { reset: true, ...apiError("task-execution-reset") });
  }
  return true;
}
