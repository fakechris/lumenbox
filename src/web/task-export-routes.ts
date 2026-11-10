import { apiError } from "./api-error.ts";
/** Native, human downloads only. Neither a client path nor a tool can address this cache. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { digestOf } from "../host/task-deliverables.ts";
import { ExecutionReset, type ExecutionAccess } from "./task-execution.ts";
import { executionFilters } from "./task-execution-routes.ts";
import type { TaskExports } from "./task-export.ts";
export async function taskExportRoute(route: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: {
  exports: TaskExports; access: () => ExecutionAccess; send: (res: ServerResponse, status: number, body: unknown) => void;
}): Promise<boolean> {
  const create = route === "POST /api/tasks/export";
  if (!create && route !== "GET /api/tasks/export/file") return false;
  const controller = new AbortController(), close = () => controller.abort();
  res.once("close", close);
  try {
    const taskId = url.searchParams.get("task") ?? "";
    if (!deps.access().task(taskId)) throw new ExecutionReset("unavailable");
    if (create) {
      const result = await deps.exports.create(taskId, deps.access, executionFilters(url), controller.signal);
      if (!controller.signal.aborted) { res.setHeader("cache-control", "no-store"); deps.send(res, 200, result); }
    } else {
      const name = url.searchParams.get("file") ?? "";
      const bytes = deps.exports.download(taskId, url.searchParams.get("id") ?? "", name, deps.access);
      res.writeHead(200, { "content-type": name.endsWith(".md") ? "text/markdown; charset=utf-8" : name.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
        "content-length": bytes.length, "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "x-content-sha256": digestOf(bytes), "cache-control": "no-store" });
      res.end(bytes);
    }
  } catch (error) {
    if (controller.signal.aborted) return true;
    if (!(error instanceof ExecutionReset)) throw error;
    deps.send(res, create ? 409 : 404, apiError("task-export-unavailable"));
  } finally { res.off("close", close); }
  return true;
}
