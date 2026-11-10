/** Read-only use of the existing spend projection; bounded Task.history is never a cost join. */
import type { ServerResponse } from "node:http";
import type { UsageRecord } from "../host/usage.ts";
import { summariseSpend, type Rates } from "../host/spend.ts";
import { apiError } from "./api-error.ts";
import type { ExecutionAccess, TaskExecutions } from "./task-execution.ts";

export function taskCostRoute(route: string, url: URL, res: ServerResponse, deps: {
  refused: () => boolean; access: ExecutionAccess; executions: TaskExecutions;
  records: () => readonly UsageRecord[]; rates: () => Rates; compacted: () => boolean;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}): boolean {
  if (route !== "GET /api/tasks/execution/costs") return false;
  if (deps.refused()) return true;
  const taskId = url.searchParams.get("task") ?? "";
  if (!deps.access.task(taskId)) { deps.send(res, 404, apiError("task-none")); return true; }
  const scope = deps.executions.costScope(taskId, deps.access);
  const records = deps.records().filter(record => record.turnId !== undefined && scope.turns.get(record.turnId)?.has(record.agentId));
  deps.send(res, 200, { scope: scope.scope, coverage: scope.partial ? "partial" : "retained",
    report: summariseSpend(records, { turnIds: [...scope.turns.keys()], rates: deps.rates(), compacted: deps.compacted() }) });
  return true;
}
