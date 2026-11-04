/**
 * Parsed transcripts, kept while an agent is active (INV-1564).
 *
 * A turn read the agent's whole transcript about five times — before the prompt, to build the
 * parts, for the context turn, for the reply, after the prompt — and every read was a readFileSync,
 * a split and a JSON.parse per line. With a 30 MB record that is ~150 MB of garbage per woken turn,
 * and woken turns overlap: the load bench (scripts/load-bench.ts) measured 640 full reads, 9.77 GB
 * parsed and a 1.4 GB heap in 320 s, against 70 MB with empty records. A transcript only grows
 * between reads, so the parse is kept and only what was appended is read.
 *
 * - **Hit:** same file (inode), size and mtime → the kept entries.
 * - **Appended:** same file, larger, and the bytes just before the old end are the ones kept → only
 *   the new bytes are parsed. A file rewritten in place fails that check and is read whole.
 * - **Anything else:** read whole.
 *
 * Entries are frozen, deeply: they are shared by every reader, so a caller that changed one would
 * change every later read. It throws instead. Bounded: least recently used first past
 * `maxBytes` of file, and an entry idle for `idleMs` is let go, so a peak does not stay resident.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

interface Kept {
  ino: number;
  size: number;
  mtimeMs: number;
  /** The last bytes before `size`, to tell an append from a rewrite. */
  edge: Buffer;
  entries: unknown[];
  usedAt: number;
}

const EDGE = 64;

export interface TranscriptCacheOptions {
  maxBytes?: number;
  idleMs?: number;
  now?: () => number;
}

export class TranscriptCache {
  private readonly kept = new Map<string, Kept>();
  /** Full parses and appended parses, for the load bench and the tests. */
  readonly counts = { full: 0, appended: 0, hits: 0 };
  private readonly maxBytes: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: TranscriptCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.idleMs = options.idleMs ?? 10 * 60_000; // longer than an agent waits on a job: a woken agent re-parsed its whole record (INV-1566)
    this.now = options.now ?? Date.now;
  }

  /** The transcript at `path`, parsed; a fresh array each call (the entries in it are shared and frozen). */
  read(path: string): unknown[] {
    this.letGo();
    if (!existsSync(path)) {
      this.kept.delete(path);
      return [];
    }
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      const before = this.kept.get(path);
      if (before !== undefined && before.ino === stat.ino) {
        if (before.size === stat.size && before.mtimeMs === stat.mtimeMs) {
          before.usedAt = this.now();
          this.counts.hits++;
          return before.entries.slice();
        }
        if (stat.size > before.size && sameEdge(fd, before)) {
          const added = readRange(fd, before.size, stat.size);
          // Only whole lines: a write caught mid-line is left for the next read.
          const end = added.lastIndexOf(0x0a) + 1;
          if (end > 0) {
            for (const entry of parseLines(added.subarray(0, end))) before.entries.push(entry);
            before.size += end;
            before.edge = readRange(fd, Math.max(0, before.size - EDGE), before.size);
            before.mtimeMs = end === added.length ? stat.mtimeMs : -1;
          }
          before.usedAt = this.now();
          this.counts.appended++;
          // What follows the last newline is returned, as the uncached read did, but not kept.
          return end === added.length ? before.entries.slice() : [...before.entries, ...parseLines(added.subarray(end))];
        }
      }
      const whole = readRange(fd, 0, stat.size);
      const end = whole.lastIndexOf(0x0a) + 1;
      const entries = parseLines(whole);
      // A last line without its newline is parsed but not kept as settled: the next read re-reads from scratch.
      // The edge is copied: a subarray would keep the whole file's buffer alive for as long as the entry is kept.
      this.kept.set(path, { ino: stat.ino, size: end, mtimeMs: end === whole.length ? stat.mtimeMs : -1, edge: Buffer.from(whole.subarray(Math.max(0, end - EDGE), end)), entries: end === whole.length ? entries : parseLines(whole.subarray(0, end)), usedAt: this.now() });
      this.counts.full++;
      this.trim();
      return entries.slice();
    } finally {
      closeSync(fd);
    }
  }

  /** Forgets one file, for a writer that rewrote it. */
  forget(path: string): void {
    this.kept.delete(path);
  }

  private letGo(): void {
    const now = this.now();
    for (const [path, kept] of this.kept) if (now - kept.usedAt > this.idleMs) this.kept.delete(path);
  }

  private trim(): void {
    let total = [...this.kept.values()].reduce((sum, kept) => sum + kept.size, 0);
    for (const [path, kept] of [...this.kept].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (total <= this.maxBytes) break;
      this.kept.delete(path);
      total -= kept.size;
    }
  }
}

function sameEdge(fd: number, kept: Kept): boolean {
  if (kept.edge.length === 0) return kept.size === 0;
  return readRange(fd, kept.size - kept.edge.length, kept.size).equals(kept.edge);
}

function readRange(fd: number, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, to - from));
  let read = 0;
  while (read < buffer.length) {
    const bytes = readSync(fd, buffer, read, buffer.length - read, from + read);
    if (bytes === 0) break;
    read += bytes;
  }
  return buffer.subarray(0, read);
}

/**
 * One entry per line, decoded line by line from the bytes: the whole file never becomes one string,
 * nor an array of every line (INV-1566: five agents parsing 30 MB at once held both at the peak). A
 * newline byte never occurs inside a UTF-8 sequence, so this splits exactly where `split("\n")` does.
 */
function parseLines(bytes: Buffer): unknown[] {
  const entries: unknown[] = [];
  for (let start = 0; start < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.toString("utf8", start, end);
    start = end + 1;
    if (line.trim() === "") continue;
    try {
      entries.push(deepFreeze(JSON.parse(line)));
    } catch {
      // A torn or foreign line is skipped, as the uncached read always did.
    }
  }
  return entries;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
