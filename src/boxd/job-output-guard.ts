/**
 * How much a job may write, and how full the workspace may get (INV-1573).
 *
 * The log ceiling (INV-1558) bounds what is kept of a job's output, not what the job emits: a
 * runaway loop printing for hours was truncated on disk and kept running, burning CPU and IO.
 * And free space on the work volume was only reported by box-doctor, after the fact — a full disk
 * breaks every agent and the desktop at once. Two checks:
 *
 * - **Emitted output** (BOXD_JOB_OUTPUT_MAX_MB, default 1024; 0 = off), checked every
 *   `checkEvery` bytes of a job's output: past it the job's tree is stopped and its log says why.
 * - **Disk waterline**: when free space where the jobs live falls below max(512 MiB, 5% of the
 *   volume), new jobs are refused, and a job that is writing is stopped, both with the reason.
 *   "Writing" is measured, not guessed: a disk fills through files, not through a job's output,
 *   so every few seconds each job's tree is asked how much it has written (wchar, which counts
 *   files, pipes and tmpfs alike), and the ones that wrote since the last look are the writers.
 */

import { readFileSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { treeOf, type ProcessRow } from "./process-tree.ts";

export interface OutputLimits {
  /** Bytes one job may emit; 0 for no limit. */
  outputBytes: number;
  /** The waterline's floor and share: the larger of the two is the least free space kept. */
  floorBytes: number;
  floorRatio: number;
  /** How often, in emitted bytes, a writing job is checked. */
  checkEvery: number;
}

export function outputLimitsFrom(env: Record<string, string | undefined>): OutputLimits {
  const raw = env.BOXD_JOB_OUTPUT_MAX_MB;
  const mb = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 1024;
  return { outputBytes: mb * 1024 * 1024, floorBytes: 512 * 1024 * 1024, floorRatio: 0.05, checkEvery: 256 * 1024 };
}

export interface DiskSpace {
  free: number;
  total: number;
}

/** Free and total bytes of the volume holding `path` (or its parent, before it exists); undefined when unknown. */
export function diskSpace(path: string): DiskSpace | undefined {
  for (const at of [path, dirname(path)]) {
    try {
      const stat = statfsSync(at);
      return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
    } catch {
      // Not there yet; try where it would be made.
    }
  }
  return undefined;
}

const mb = (bytes: number) => { const value = bytes / 1024 / 1024; return `${value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} MB`; };

/** Bytes a process has written through write calls (files, pipes, tmpfs alike), from /proc; 0 when gone. */
export function writtenBytes(pid: number, proc = "/proc"): number {
  try {
    const match = /^wchar:\s+(\d+)/m.exec(readFileSync(`${proc}/${pid}/io`, "utf8"));
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

/** What a job's live tree has written so far: the job's own process and everything under it. */
export function treeWritten(root: number, table: readonly ProcessRow[], written: (pid: number) => number = writtenBytes): number {
  return [root, ...treeOf(root, table).pids].reduce((sum, pid) => sum + written(pid), 0);
}

/** Why the workspace is too full to write to, or undefined while it has room. */
export function diskRefusal(space: DiskSpace | undefined, limits: OutputLimits): string | undefined {
  if (space === undefined) return undefined;
  const floor = Math.max(limits.floorBytes, Math.floor(space.total * limits.floorRatio));
  if (space.free >= floor) return undefined;
  return `the box's work volume has ${mb(space.free)} free, below the ${mb(floor)} kept free for everything in the box. ` +
    "Remove what you no longer need (old outputs, caches, downloads) before starting more work.";
}

/** Why a job that has emitted `emitted` bytes must stop, or undefined while it may go on. */
export function outputRefusal(emitted: number, limits: OutputLimits): string | undefined {
  if (limits.outputBytes === 0 || emitted <= limits.outputBytes) return undefined;
  return `this job wrote ${mb(emitted)} of output, past the ${mb(limits.outputBytes)} one job may write in this box. ` +
    "Write less: send bulk output to a file you need, or narrow what the command prints.";
}

/** The line a job stopped by one of these checks ends its log with. */
export function stopNote(reason: string): string {
  return `\n[boxd] stopped: ${reason}\n`;
}
