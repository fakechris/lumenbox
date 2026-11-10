/** Paged board projection. Snapshots retain ids, never task bodies or authorization. */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Task } from "../host/tasks.ts";
import { boardOrder } from "./board-order.ts";
import { apiError } from "./api-error.ts";

export class TaskListPages {
  private readonly pages = new Map<string, { ids: string[]; query: string; at: number }>();
  read(rows: readonly Task[], query: string, cursor: string | null, limit: number) {
    const now = Date.now();
    for (const [id, page] of this.pages) if (now - page.at > 600_000) this.pages.delete(id);
    let id: string, offset = 0;
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { snapshot: string; after: string };
      id = decoded.snapshot;
      const snapshot = this.pages.get(id);
      if (!snapshot || snapshot.query !== query) throw new Error("expired task list");
      snapshot.at = now;
      const visible = new Set(rows.map(task => task.id));
      const ids = snapshot.ids.filter(id => visible.has(id));
      const index = ids.indexOf(decoded.after);
      if (index < 0) throw new Error("task list anchor unavailable");
      offset = index + 1;
    } else {
      id = randomUUID(); this.pages.set(id, { ids: rows.map(task => task.id), query, at: now });
      while (this.pages.size > 16) this.pages.delete(this.pages.keys().next().value!);
    }
    const allowed = new Map(rows.map(task => [task.id, task]));
    const ids = this.pages.get(id)!.ids.filter(id => allowed.has(id));
    const selected = ids.slice(offset, offset + limit);
    return { tasks: selected.map(id => allowed.get(id)!), total: ids.length,
      nextCursor: offset + selected.length < ids.length ? Buffer.from(JSON.stringify({ snapshot: id, after: selected.at(-1)! })).toString("base64url") : null };
  }
}

export function taskListRoute(route: string, url: URL, res: ServerResponse, deps: {
  pages: TaskListPages; tasks: () => readonly Task[]; allowed: (task: Task) => boolean; detail: (task: Task) => unknown; summary?: (task: Task) => unknown;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}): boolean {
  if (route !== "GET /api/tasks/list" && route !== "GET /api/tasks/item") return false;
  const other = url.searchParams.get("other") === "1";
  const available = deps.tasks().filter(deps.allowed).filter(task => !url.searchParams.has("agent") || task.assigneeId === url.searchParams.get("agent")).filter(task => !url.searchParams.has("conversation") || (task.conversation === url.searchParams.get("conversation")) !== other);
  if (route.endsWith("/item")) {
    const task = available.find(task => task.id === url.searchParams.get("task"));
    deps.send(res, task ? 200 : 404, task ? { task: deps.detail(task) } : apiError("task-none")); return true;
  }
  const inbox = url.searchParams.get("inbox") === "1";
  const priority = (url.searchParams.get("priority") ?? "").split(",").filter(Boolean).slice(0, 100);
  const tasks = available.filter(task => !inbox || (task.proposedBy !== undefined && task.status !== "dropped"));
  const rows = boardOrder(tasks, [], []).map(row => row.task).sort((a, b) => {
    const left = priority.indexOf(a.id), right = priority.indexOf(b.id);
    return left >= 0 && right >= 0 ? left - right : left >= 0 ? -1 : right >= 0 ? 1 : 0;
  });
  const project = deps.summary ?? deps.detail;
  const ids = url.searchParams.get("ids");
  if (ids !== null) {
    const requested = ids.split(",").slice(0, 100), byId = new Map(rows.map(task => [task.id, task]));
    deps.send(res, 200, { tasks: requested.flatMap(id => byId.has(id) ? [project(byId.get(id)!)] : []),
      head: rows.slice(0, 50).map(task => task.id), total: rows.length }); return true;
  }
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit") ?? 50))));
  try {
    if (!Number.isFinite(limit)) throw new Error("invalid limit");
    const page = deps.pages.read(rows, JSON.stringify([inbox, priority, other, url.searchParams.get("agent"), url.searchParams.get("conversation")]), url.searchParams.get("cursor"), limit);
    deps.send(res, 200, { ...page, tasks: page.tasks.map(project) });
  } catch {
    deps.send(res, 409, { reset: true, ...apiError("task-execution-reset") });
  }
  return true;
}
