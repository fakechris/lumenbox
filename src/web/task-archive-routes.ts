/**
 * Archiving ended internal records from the page (INV-1824): how many there are, taking them off
 * the board, and bringing this month's back. Counting is anybody's who may open the system view;
 * moving records is an admin's.
 */
import { archivable, archiveEnded, restoreArchived } from "../host/task-archive.ts";
import type { Task, TaskStore } from "../host/tasks.ts";
import { basename } from "node:path";
import { apiError } from "./api-error.ts";

export async function taskArchiveRoute(
  route: string,
  deps: { tasks: TaskStore | undefined; audience: (task: Task) => string; readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/tasks/archive" && route !== "POST /api/tasks/archive") return undefined;
  if (deps.tasks === undefined) return { status: 404, body: apiError("task-none") };
  const view = () => {
    const { take, live } = archivable(deps.tasks!.list(), deps.audience);
    return { ended: take.length, live };
  };
  if (route === "GET /api/tasks/archive") return { status: 200, body: view() };
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const body = await deps.readJson();
  if (body.action !== "archive" && body.action !== "restore") return { status: 400, body: apiError("task-archive-action") };
  const done = body.action === "archive" ? archiveEnded(deps.tasks, deps.audience) : restoreArchived(deps.tasks);
  // The file by its name: where the installation keeps its data is not the page's to know.
  return { status: 200, body: { ...done, ...(done.file !== undefined ? { file: basename(done.file) } : {}), ...view() } };
}
