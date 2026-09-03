/**
 * Appending one line to an append-only JSONL file, safely.
 *
 * Every durable log here tolerates a torn final line on *read* — a crash mid-append leaves a line
 * with no terminating newline, and every reader skips it. But the writers did not close that torn
 * line before adding the next record: `appendFileSync(path, record + "\n")` concatenates onto the
 * torn tail, so `{"seq":2,"event":"start` becomes `{"seq":2,"event":"start{"seq":3,...}` — one line
 * that neither parses. The torn record was going to be lost anyway; the *new* one is lost too, and
 * a record that should have been written silently is not.
 *
 * The fix is to make sure the file ends in a newline before appending. If the last byte is not one,
 * the file's tail is torn, and a leading newline turns the concatenation into two separate lines:
 * the torn one (still skipped on read) and the new one (intact).
 */

import { appendFileSync, closeSync, fsyncSync, openSync, readSync, statSync, writeSync } from "node:fs";

/** Whether the file's last byte is a newline. A missing or empty file counts as "yes" — nothing to tear. */
function endsWithNewline(path: string): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return true; // absent: the append creates it cleanly
  }
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    readSync(fd, buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `record` as its own line, first closing a torn tail if there is one.
 *
 * `record` should not include the trailing newline; this adds it. A leading newline is added only
 * when the file's last line was left unterminated by a crash, so the common case writes exactly one
 * line and one syscall's worth of extra work (a one-byte read) guards the rare one.
 */
export function appendLine(path: string, record: string): void {
  const prefix = endsWithNewline(path) ? "" : "\n";
  appendFileSync(path, `${prefix}${record}\n`, "utf8");
}

/**
 * `appendLine`, then `fsync` before returning — for the one record whose whole point is to
 * exist before the effect it describes (docs/32 §1). Throws on any failure; the caller
 * decides whether the effect may proceed without it, and for the fork ledger it may not.
 */
export function appendLineDurably(path: string, record: string): void {
  const prefix = endsWithNewline(path) ? "" : "\n";
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${prefix}${record}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
