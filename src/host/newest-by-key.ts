/**
 * The newest timestamp per key in an append-only JSON-lines log, read once and then only as it grows
 * (INV-2082).
 *
 * The People list says when each person was last active, from `messages.jsonl` and the usage log —
 * neither ever compacted. Re-reading and parsing both whole on every request blocked the server for as
 * long as the logs had grown, and the Team pane asks every 15 seconds (every 3 while a code is shown).
 *
 * So each log has a cursor: where the last complete line ended, the file's identity (device and inode),
 * and its first bytes. A request reads only what was appended since. A file that is gone, replaced (a new
 * inode: an atomic rewrite), shorter than the cursor, or whose first bytes changed (rewritten in place) is
 * read again from the start. A trailing line still being written is read but not passed: it is read again,
 * whole, next time — harmless, because "newest" is a maximum and counting a line twice cannot change one.
 */
import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";

const HEAD = 256;

interface Cursor { dev: number; ino: number; offset: number; head: Buffer; newest: Map<string, string> }

const cursors = new Map<string, Cursor>();

function bytes(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, "r"), chunk = Buffer.alloc(length);
  try {
    let read = 0;
    while (read < length) {
      const got = readSync(fd, chunk, read, length - read, from + read);
      if (got === 0) break;
      read += got;
    }
    return chunk.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function fold(newest: Map<string, string>, text: string, key: string, at: string): void {
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as Record<string, unknown>;
      const id = line[key], when = line[at];
      if (typeof id !== "string" || typeof when !== "string") continue;
      if ((newest.get(id) ?? "") < when) newest.set(id, when);
    } catch { /* a torn line says nothing about anyone */ }
  }
}

/** For each `key` value in the log at `path`, the greatest `at` value: the newest, for ISO timestamps. Read-only to the caller. */
export function newestByKey(path: string, key: string, at: string): ReadonlyMap<string, string> {
  const id = `${path}\0${key}\0${at}`;
  let stat: Stats;
  try { stat = statSync(path); } catch { cursors.delete(id); return new Map(); }
  let cursor = cursors.get(id);
  const replaced = cursor !== undefined && (cursor.dev !== stat.dev || cursor.ino !== stat.ino || stat.size < cursor.offset || !bytes(path, 0, cursor.head.length).equals(cursor.head));
  if (cursor === undefined || replaced) {
    cursor = { dev: stat.dev, ino: stat.ino, offset: 0, head: Buffer.alloc(0), newest: new Map() };
    cursors.set(id, cursor);
  }
  if (stat.size > cursor.offset) {
    const chunk = bytes(path, cursor.offset, stat.size - cursor.offset);
    fold(cursor.newest, chunk.toString("utf8"), key, at);
    // Only past the last newline: a newline byte never sits inside a multi-byte character, so no character is split.
    cursor.offset += chunk.lastIndexOf(0x0a) + 1;
    if (cursor.head.length < HEAD) cursor.head = bytes(path, 0, Math.min(HEAD, cursor.offset));
  }
  return cursor.newest;
}
