import { apiError } from "./api-error.ts";
/** The web and channels use the same explicit domain command as the model tool. */
import type { Task, TaskStore } from "../host/tasks.ts";
import { isDeliveryAction } from "../host/task-delivery.ts";

export async function taskDeliveryRoute(route: string, deps: { board?: TaskStore; refused: () => boolean; readJson: () => Promise<Record<string, unknown>>; mayRead: (task: Task) => boolean; by: string; view: (task: Task) => unknown }) {
  if (route !== "POST /api/tasks/delivery") return undefined;
  if (deps.refused()) return { status: 0, body: {} };
  if (!deps.board) return { status: 503, body: apiError("task-board-missing") };
  const input = await deps.readJson();
  if (!isDeliveryAction(input.action)) return { status: 400, body: apiError("task-delivery-action") };
  if (input.expectedVersion !== undefined && typeof input.expectedVersion !== "string" || input.generation !== undefined && !Number.isInteger(input.generation) || input.epoch !== undefined && !Number.isInteger(input.epoch)) return { status: 400, body: apiError("task-delivery-version") };
  const task = deps.board.get(String(input.id ?? ""));
  if (!task || !deps.mayRead(task)) return { status: 404, body: apiError("task-none") };
  const result = deps.board.deliveryCommand(task.id, input.action, deps.by, {
    ...(typeof input.note === "string" ? { note: input.note } : {}),
    ...(Array.isArray(input.evidence) ? { evidence: input.evidence.filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof input.expectedVersion === "string" ? { expectedVersion: input.expectedVersion } : {}),
    ...(typeof input.generation === "number" ? { generation: input.generation } : {}),
    ...(typeof input.epoch === "number" ? { epoch: input.epoch } : {}),
  })!;
  return { status: result.outcome === "refused" ? 409 : 200, body: { outcome: result.outcome, task: deps.view(result.task), ...(result.coerced ? apiError("task-delivery-refused", { reason: result.coerced }) : {}) } };
}
