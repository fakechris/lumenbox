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

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";

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

/**
 * A ledger's own account of what it is, declared where it is written.
 *
 * Eight files here compact, and until 2026-09 none of them said which of four things it
 * was, so `compact()` was written by copying whichever neighbour was open. Two of them
 * described themselves in prose as records of what happened and were compacted as queues:
 * `ingress.jsonl`, every arrival from outside and its fate, kept only what was still
 * undecided; `turns.jsonl`, the life of every turn, emptied itself whenever nothing was
 * outstanding. Both losses were silent and both were total. INV-613 opened a ninth ledger
 * rather than trust either of them, which is the clearest statement of the problem.
 *
 * So the kind is declared, the guard makes declaring it compulsory, and `record` binds
 * `compact()` to archive rather than drop.
 */
export type LedgerKind =
  /** What happened. Compaction may move lines to an archive; it may never lose one. */
  | "record"
  /** What is outstanding. A settled line has done its job and is meant to go. */
  | "queue"
  /** What is true now. The file is a map, and an older line for the same key is noise. */
  | "state"
  /** A window on a stream. Old lines fall off the back on purpose, and nobody is owed them. */
  | "feed";

/** `ingress.jsonl` archives to `ingress.2026-09.jsonl`, beside it. */
export function archivePathFor(path: string, now: Date): string {
  const month = now.toISOString().slice(0, 7);
  return path.replace(/(\.jsonl)$/, "") + `.${month}.jsonl`;
}

/**
 * Moves settled lines out of a record's live file instead of dropping them.
 *
 * Append-only and never compacted itself — an archive that compacts is a record that
 * forgets twice. One file per month, so the live file stays small without any single
 * archive growing without bound, and so a retention policy has something to act on.
 *
 * Returns the archive written to, or undefined when there was nothing to move.
 */
export function archiveSettled(path: string, lines: readonly string[], now = new Date()): string | undefined {
  const body = lines.filter(line => line.trim() !== "");
  if (body.length === 0) return undefined;
  const archive = archivePathFor(path, now);
  for (const line of body) appendLine(archive, line);
  return archive;
}

/** Every archive beside a ledger, oldest month first. */
export function archivePaths(path: string): string[] {
  const at = path.lastIndexOf("/");
  const dir = at === -1 ? "." : path.slice(0, at);
  const base = (at === -1 ? path : path.slice(at + 1)).replace(/\.jsonl$/, "");
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}\\.jsonl$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(name => pattern.test(name))
    .sort()
    .map(name => (at === -1 ? name : `${dir}/${name}`));
}

/**
 * Every archived line for a ledger, oldest first.
 *
 * Read on demand rather than kept in memory: the archives exist for the questions that
 * are asked rarely and matter when they are — "was this message already answered", "what
 * did that turn cost" — and paying for them on every ordinary read would have been a good
 * reason to delete them again.
 */
export function archivedLines(path: string): string[] {
  const out: string[] = [];
  for (const archive of archivePaths(path)) {
    let text: string;
    try {
      text = readFileSync(archive, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) if (line.trim() !== "") out.push(line);
  }
  return out;
}
