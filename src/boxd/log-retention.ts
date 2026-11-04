/**
 * How much of its own output the box keeps (INV-1558).
 *
 * Every job's output went whole into `.jobs/<id>.log` and every long exec into `.spool/`, and
 * nothing was ever removed: on 2026-11-04 the two held 5 GB (one log 685 MB), and agents auditing
 * their own history scanned them again and again — each scan's output another log for the next
 * scan to read. Two limits now:
 *
 * - **One log's size** (BOXD_JOB_LOG_MAX_MB, default 64): past it the head stays on disk, only the
 *   last 2 MB are kept in memory, and when the job ends they are written after a line saying how
 *   much was cut — the same head-and-tail cut the tool results use. A marker says so the moment
 *   the cap is reached, so a reader of a running job's log is not left guessing.
 * - **What is kept of ended jobs** (BOXD_LOG_KEEP_DAYS, default 7; BOXD_LOG_KEEP_MB, default 1024):
 *   an ended job's files go when older than that, or oldest first while the total is over. A
 *   running job's files are never touched, nor anything whose name is not one this daemon writes
 *   (an agent's own `.jobs/sources.json` stays).
 *
 * The spool already had a home for its retention (shell-service `reapSpool`, a day, hourly); it
 * gains a size ceiling there (BOXD_SPOOL_KEEP_MB, default 512), not a second sweeper here.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { WriteStream } from "node:fs";

export interface LogLimits {
  capBytes: number;
  tailBytes: number;
  keepMs: number;
  keepBytes: number;
  spoolKeepBytes: number;
}

export function logLimitsFrom(env: Record<string, string | undefined>): LogLimits {
  const number = (raw: string | undefined, fallback: number) => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);
  const mb = 1024 * 1024;
  return { capBytes: number(env.BOXD_JOB_LOG_MAX_MB, 64) * mb, tailBytes: 2 * mb, keepMs: number(env.BOXD_LOG_KEEP_DAYS, 7) * 24 * 60 * 60_000, keepBytes: number(env.BOXD_LOG_KEEP_MB, 1024) * mb, spoolKeepBytes: number(env.BOXD_SPOOL_KEEP_MB, 512) * mb };
}

/** A job's log with a ceiling: the head on disk, the last `tailBytes` held until the job ends. */
export class CappedLog extends Writable {
  private written: number;
  private capped = false;
  private tail: Buffer[] = [];
  private tailLength = 0;
  private omitted = 0;

  constructor(private readonly out: WriteStream, private readonly limits: Pick<LogLimits, "capBytes" | "tailBytes">, alreadyWritten = 0) {
    super();
    this.written = alreadyWritten;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    const headRoom = this.limits.capBytes - this.limits.tailBytes - this.written;
    if (!this.capped && chunk.length <= headRoom) {
      this.written += chunk.length;
      this.out.write(chunk);
      done();
      return;
    }
    if (!this.capped) {
      const head = chunk.subarray(0, Math.max(0, headRoom));
      this.out.write(head);
      this.written += head.length;
      this.out.write(`\n[boxd] this log reached ${Math.round(this.limits.capBytes / 1024 / 1024)} MB: from here only the last ${Math.round(this.limits.tailBytes / 1024 / 1024)} MB are kept, written when the job ends\n`);
      this.capped = true;
      chunk = chunk.subarray(head.length);
    }
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    while (this.tailLength > this.limits.tailBytes && this.tail.length > 0) {
      const excess = this.tailLength - this.limits.tailBytes;
      const first = this.tail[0]!;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLength -= first.length;
        this.omitted += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailLength -= excess;
        this.omitted += excess;
      }
    }
    done();
  }

  /** Writes what was kept of the end and how much was cut; call once, before the log is closed. */
  flushTail(): void {
    if (!this.capped) return;
    this.out.write(`\n... [${this.omitted} bytes omitted] ...\n`);
    this.out.write(Buffer.concat(this.tail));
    this.tail = [];
    this.tailLength = 0;
  }
}

const JOB_FILE = /^(job-[0-9a-f]{8,32})\.(log|exit|rc)(\.tmp)?$/;

export interface PruneResult {
  at: string;
  removedFiles: number;
  removedJobs: string[];
  freedBytes: number;
  keptBytes: number;
}

/**
 * Removes what the limits no longer keep. `running` are job ids whose files stay whatever their
 * age. Writes the result beside the jobs (`.retention.json`) for box-doctor, and returns it.
 */
export function pruneLogs(input: { jobsDir: string; running: ReadonlySet<string>; limits: Pick<LogLimits, "keepMs" | "keepBytes">; now?: number }): PruneResult {
  const now = input.now ?? Date.now();
  type Unit = { files: { path: string; bytes: number }[]; newest: number; bytes: number; jobId?: string };
  const units = new Map<string, Unit>();
  let pinnedBytes = 0;
  const add = (key: string, path: string, jobId?: string) => {
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(path); } catch { return; }
    const unit = units.get(key) ?? { files: [], newest: 0, bytes: 0, ...(jobId !== undefined ? { jobId } : {}) };
    unit.files.push({ path, bytes: stat.size });
    unit.bytes += stat.size;
    unit.newest = Math.max(unit.newest, stat.mtimeMs);
    units.set(key, unit);
  };
  for (const name of safeList(input.jobsDir)) {
    const match = JOB_FILE.exec(name);
    if (match === null) continue;
    const path = join(input.jobsDir, name);
    if (input.running.has(match[1]!)) { pinnedBytes += sizeOf(path); continue; }
    add(`job:${match[1]}`, path, match[1]);
  }
  const oldestFirst = [...units.values()].sort((a, b) => a.newest - b.newest);
  let total = pinnedBytes + oldestFirst.reduce((sum, unit) => sum + unit.bytes, 0);
  const result: PruneResult = { at: new Date(now).toISOString(), removedFiles: 0, removedJobs: [], freedBytes: 0, keptBytes: 0 };
  for (const unit of oldestFirst) {
    if (now - unit.newest <= input.limits.keepMs && total <= input.limits.keepBytes) break;
    for (const file of unit.files) {
      try { unlinkSync(file.path); result.removedFiles++; result.freedBytes += file.bytes; total -= file.bytes; } catch { /* gone already */ }
    }
    if (unit.jobId !== undefined) result.removedJobs.push(unit.jobId);
  }
  result.keptBytes = total;
  // A fresh box has no jobs directory until its first job; the record is still the doctor's evidence that pruning runs.
  try { mkdirSync(input.jobsDir, { recursive: true }); writeFileSync(join(input.jobsDir, ".retention.json"), JSON.stringify(result)); } catch { /* the doctor will say there is no record */ }
  return result;
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
