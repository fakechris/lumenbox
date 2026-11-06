/**
 * Downloading a task's deliverable (INV-1663): `GET /api/tasks/deliverable?task=t12&id=d2`.
 *
 * The bytes come from the snapshot the host took when the agent delivered the file, never from
 * the box: the box may have changed since, and what the task page offers is what was handed
 * over. Who may download is who may see the task on the board — the caller passes the same
 * predicate the board list uses, so the two cannot drift apart.
 */

import type { ServerResponse } from "node:http";
import { readSnapshot } from "../host/task-deliverables.ts";
import type { Task, TaskStore } from "../host/tasks.ts";

export const DELIVERABLE_ROUTE = "GET /api/tasks/deliverable";

/** Handles the route and answers true; false for any other route. */
export function deliverableRoute(
  route: string,
  url: URL,
  res: ServerResponse,
  deps: { tasks: TaskStore | undefined; mayReadTask: (task: Task) => boolean; send: (res: ServerResponse, status: number, body: unknown) => void }
): boolean {
  if (route !== DELIVERABLE_ROUTE) return false;
  const task = deps.tasks?.get(url.searchParams.get("task") ?? "");
  // Unknown and unreadable answer alike, so the route does not say which tasks exist.
  if (task === undefined || !deps.mayReadTask(task) || deps.tasks?.path == null) {
    deps.send(res, 404, { error: "No such task." });
    return true;
  }
  const item = (task.deliverables ?? []).find(entry => entry.id === url.searchParams.get("id"));
  const bytes = item === undefined ? undefined : readSnapshot(deps.tasks.path, task.id, item);
  if (item === undefined || bytes === undefined) {
    deps.send(res, 404, { error: item === undefined ? "No such deliverable." : "The deliverable's copy is missing or does not match its digest." });
    return true;
  }
  const ascii = item.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": bytes.length,
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "x-content-sha256": item.sha256,
    "cache-control": "no-store",
  });
  res.end(bytes);
  return true;
}
