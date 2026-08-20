/**
 * Filesystem operations inside the box.
 *
 * Paths are not confined to a root: the agent has a shell in this container
 * anyway, so a path jail here would be theatre. The container is the boundary.
 */

import {
  readdir,
  lstat,
  mkdir,
  readFile as fsReadFile,
  realpath,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type {
  DirEntry,
  ListDirRequest,
  ListDirResult,
  ReadFileRequest,
  ReadFileResult,
  WriteFileRequest,
  WriteFileResult,
  DownloadFileRequest,
  DownloadFileResult,
  UploadFileRequest,
  UploadFileResult,
} from "../protocol/index.ts";

/** Files above this are refused rather than silently truncated to nothing useful. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Lines returned when no explicit range is asked for. */
const DEFAULT_LINE_LIMIT = 2000;

/**
 * The only directory a download may come from.
 *
 * Unlike the other endpoints here, `download` exists to serve **a person through the web UI**, not
 * the agent that owns this box. So it is confined, and confined here rather than only in the caller:
 * the endpoint's whole purpose is handing over work products, and an unconfined one is an arbitrary
 * read of the container — including the orchestrator's own token file.
 *
 * `/home/box/work` is also the directory that survives a rebuild, so "downloadable" and "durable"
 * are the same set, which is one fewer thing to explain.
 */
const DOWNLOAD_ROOT = process.env.AGENTBOX_WORK_DIR ?? "/home/box/work";

/**
 * Files above this are refused for download rather than served.
 *
 * Lower than the read limit because the body is base64 in JSON — the protocol here is JSON
 * everywhere and the type is the contract — so the wire cost is a third again. Ten megabytes covers
 * reports, spreadsheets, logs and screenshots, which is what this is for. Something larger is a
 * dataset, and the honest answer for a dataset is to archive it and say so rather than to stream it
 * through an API that was not built for it.
 */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Media types worth naming, so a browser renders rather than downloads what it can show. */
const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

function requirePath(path: string | undefined, field = "path"): string {
  if (!path || typeof path !== "string" || path.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return resolve(path);
}

/**
 * Resolves a path and refuses anything outside the download root.
 *
 * `realpath` rather than `resolve`, because a symlink inside the root pointing out of it is the
 * obvious way past a prefix check — and an agent can create one with a single command.
 */
async function requireDownloadable(path: string | undefined): Promise<string> {
  const requested = requirePath(path);
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    // Report the requested path, not the resolved one: a "no such file" naming a path the caller
    // never typed is a confusing answer to a typo.
    throw new Error(`${requested} does not exist`);
  }
  const root = await realpath(DOWNLOAD_ROOT).catch(() => DOWNLOAD_ROOT);
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new Error(
      `${requested} is outside ${DOWNLOAD_ROOT}. Only files under that directory can be handed ` +
        `over, because it is the one a person is allowed to browse and the one that survives a rebuild.`
    );
  }
  return real;
}

export async function downloadFile(request: DownloadFileRequest): Promise<DownloadFileResult> {
  const path = await requireDownloadable(request.path);
  const info = await stat(path);
  if (info.isDirectory()) throw new Error(`${path} is a directory`);
  if (info.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `${path} is ${info.size} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte limit for handing a file ` +
        `over. Archive it or split it, and say which part is which.`
    );
  }
  const bytes = await fsReadFile(path);
  return {
    path,
    size: info.size,
    media_type: MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    base64: bytes.toString("base64"),
  };
}

/**
 * Puts a file into the work directory, verbatim.
 *
 * The other half of handing work over: a person gives the agent a document to work on. Confined the
 * same way as download, and for the same reason — this one is reachable by anyone with a UI token,
 * and an unconfined write is worse than an unconfined read.
 *
 * `realpath` on the *parent*, not the file, since the file is usually about to be created.
 */
export async function uploadFile(request: UploadFileRequest): Promise<UploadFileResult> {
  const requested = requirePath(request.path);
  const parent = dirname(requested);
  const root = await realpath(DOWNLOAD_ROOT).catch(() => DOWNLOAD_ROOT);
  const realParent = await realpath(parent).catch(() => {
    throw new Error(`${parent} does not exist`);
  });
  if (realParent !== root && !realParent.startsWith(`${root}/`)) {
    throw new Error(`${requested} is outside ${DOWNLOAD_ROOT}; only that tree accepts uploads`);
  }
  const bytes = Buffer.from(request.base64, "base64");
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${bytes.length} bytes is over the ${MAX_DOWNLOAD_BYTES}-byte upload limit`);
  }
  await fsWriteFile(requested, bytes);
  return { path: requested, size: bytes.length };
}

export async function readFile(
  request: ReadFileRequest
): Promise<ReadFileResult> {
  const path = requirePath(request.path);

  const info = await stat(path);
  if (info.isDirectory()) {
    throw new Error(`${path} is a directory; use fs/list`);
  }
  if (info.size > MAX_READ_BYTES) {
    throw new Error(
      `${path} is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read limit. ` +
        "Use exec with sed/head/awk to pull out the part you need."
    );
  }

  const raw = await fsReadFile(path, "utf8");
  const lines = raw.split("\n");
  const totalLines = lines.length;

  const start = Math.max(1, request.start_line ?? 1);
  const end = Math.min(
    totalLines,
    request.end_line ?? start + DEFAULT_LINE_LIMIT - 1
  );

  const selected = lines.slice(start - 1, end);
  return {
    path,
    content: selected.join("\n"),
    total_lines: totalLines,
    truncated: start > 1 || end < totalLines,
  };
}

export async function writeFile(
  request: WriteFileRequest
): Promise<WriteFileResult> {
  const path = requirePath(request.path);
  if (typeof request.content !== "string") {
    throw new Error("content must be a string");
  }

  if (request.mkdirp !== false) {
    await mkdir(dirname(path), { recursive: true });
  }
  await fsWriteFile(path, request.content, "utf8");

  return { path, bytes_written: Buffer.byteLength(request.content) };
}

export async function listDir(request: ListDirRequest): Promise<ListDirResult> {
  const path = requirePath(request.path);
  const names = await readdir(path);

  const entries: DirEntry[] = [];
  for (const name of names) {
    try {
      const info = await lstat(resolve(path, name));
      entries.push({
        name,
        type: info.isDirectory()
          ? "directory"
          : info.isSymbolicLink()
            ? "symlink"
            : info.isFile()
              ? "file"
              : "other",
        size: info.size,
        modified: info.mtime.toISOString(),
      });
    } catch {
      // A entry that vanished between readdir and lstat is not worth failing over.
    }
  }

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (b.type === "directory" && a.type !== "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return { path, entries };
}
