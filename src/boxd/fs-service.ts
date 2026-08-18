/**
 * Filesystem operations inside the box.
 *
 * Paths are not confined to a root: the agent has a shell in this container
 * anyway, so a path jail here would be theatre. The container is the boundary.
 */

import { readdir, lstat, mkdir, readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  DirEntry,
  ListDirRequest,
  ListDirResult,
  ReadFileRequest,
  ReadFileResult,
  WriteFileRequest,
  WriteFileResult,
} from "../protocol/index.ts";

/** Files above this are refused rather than silently truncated to nothing useful. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Lines returned when no explicit range is asked for. */
const DEFAULT_LINE_LIMIT = 2000;

function requirePath(path: string | undefined, field = "path"): string {
  if (!path || typeof path !== "string" || path.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return resolve(path);
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
