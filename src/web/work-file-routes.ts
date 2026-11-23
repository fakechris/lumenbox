import type { ServerResponse } from "node:http";
import { posix } from "node:path";
import type { BoxClient } from "../box/client.ts";
import { apiError } from "./api-error.ts";

export function withinWork(path: string, work: string): boolean {
  if (path.includes("\0")) return false;
  const normalized = posix.normalize(path);
  return normalized === work || normalized.startsWith(`${work}/`);
}

export async function workFileRoute(route: string, url: URL, res: ServerResponse, deps: {
  box: (id: string | null) => { work: string; client?: Pick<BoxClient, "listDir" | "downloadFile"> } | undefined;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}): Promise<boolean> {
  const listing = route === "GET /api/files";
  if (!listing && route !== "GET /api/file") return false;
  const boxId = url.searchParams.get("boxId"), box = deps.box(boxId);
  if (!box) {
    deps.send(res, 403, apiError("box-not-yours"));
    return true;
  }
  const { work, client } = box;
  const path = listing ? url.searchParams.get("dir") ?? work : url.searchParams.get("path") ?? "";
  const confined = listing ? "browse-outside-work" : "handover-outside-work";
  if (!withinWork(path, work)) {
    deps.send(res, 403, apiError(confined, { dir: work }));
    return true;
  }
  const root = listing ? { root: work } : {};
  if (!client) {
    deps.send(res, 503, { ...apiError("box-not-running"), ...root });
    return true;
  }
  try {
    if (listing) {
      const dir = await client.listDir(path, boxId !== null);
      if (boxId !== null && dir.work_only !== true && posix.normalize(path) !== work) {
        deps.send(res, 503, { ...apiError("work-browsing-needs-update"), ...root });
      } else {
        deps.send(res, 200, { path: dir.path, entries: dir.entries, ...root });
      }
    } else {
      const file = await client.downloadFile(path);
      const bytes = Buffer.from(file.base64, "base64");
      const filename = posix.basename(file.path) || "file";
      const fallback = filename.replace(/[^\x20-\x7E]|["\\]/g, "_");
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16));
      const attachment = boxId !== null || url.searchParams.get("download") === "1";
      res.writeHead(200, {
        "content-type": file.media_type,
        "content-length": bytes.length,
        "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        "cache-control": "no-store",
      });
      res.end(bytes);
    }
  } catch (error) {
    deps.send(res, 404, { error: error instanceof Error ? error.message : String(error), ...root });
  }
  return true;
}
