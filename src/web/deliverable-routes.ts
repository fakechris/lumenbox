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
import { apiError } from "./api-error.ts";

export const DELIVERABLE_ROUTE = "GET /api/tasks/deliverable";

/**
 * What may be shown where the card stands instead of downloaded (`&inline=1`, INV-1923): pictures,
 * recordings and text, each under a type the browser will not run. Never HTML or SVG: a file an agent
 * wrote is not a page of ours. Anything else stays a download.
 */
const TEXT = "text/plain; charset=utf-8";
const INLINE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", md: TEXT, txt: TEXT, csv: TEXT, json: TEXT, log: TEXT };

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
    deps.send(res, 404, apiError("task-none"));
    return true;
  }
  const item = (task.deliverables ?? []).find(entry => entry.id === url.searchParams.get("id"));
  const bytes = item === undefined ? undefined : readSnapshot(deps.tasks.path, task.id, item);
  if (item === undefined || bytes === undefined) {
    deps.send(res, 404, { error: item === undefined ? "No such deliverable." : "The deliverable's copy is missing or does not match its digest." });
    return true;
  }
  const ascii = item.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const inline = url.searchParams.get("inline") === "1" ? INLINE[item.name.split(".").pop()?.toLowerCase() ?? ""] : undefined;
  res.writeHead(200, {
    "content-type": inline ?? "application/octet-stream",
    "content-length": bytes.length,
    "content-disposition": `${inline !== undefined ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "x-content-type-options": "nosniff",
    "x-content-sha256": item.sha256,
    "cache-control": "no-store",
  });
  res.end(bytes);
  return true;
}
