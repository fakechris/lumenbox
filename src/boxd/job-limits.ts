/**
 * What one agent's background work may take of the box (INV-1557).
 *
 * The box has one memory ceiling and one CPU ceiling for everything in it. On 2026-11-04 one agent
 * held 40 jobs at once and a single scan reached 1.8 GB; the box sat at its 4 GiB limit and the
 * kernel's OOM killer chose victims across agents, another agent's supervised work among them. The
 * outer ceiling only decides who dies. These are the inner ones:
 *
 * - **How many jobs an agent runs at once** (BOXD_JOBS_PER_AGENT, default 4; 0 = no limit). Past it a
 *   new job is refused with the reason, and a command that outlives its foreground window is stopped
 *   rather than adopted. Only `agent:` actors are counted: housekeeping is the host's own.
 * - **How much memory one job's processes hold** (BOXD_JOB_MEMORY_MB, default 1024; 0 = off). Checked
 *   by measuring, every few seconds, the resident memory of the job's whole process tree; a tree past
 *   it is killed and its log says why. Not a kernel limit: the container's cgroup tree is read-only
 *   without privilege this box should not have, and an address-space or data rlimit cannot be set low
 *   enough to matter — the Bun-built engines reserve 4 GB of writable space just to start.
 */

import { readFileSync } from "node:fs";
import { treeOf, type ProcessRow } from "./process-tree.ts";

export class JobLimitError extends Error {
  override readonly name = "JobLimitError";
}

export interface JobLimits {
  /** Running jobs one agent may hold; 0 for no limit. */
  perAgent: number;
  /** Resident bytes one job's process tree may hold; 0 for no limit. */
  memoryBytes: number;
}

export function jobLimitsFrom(env: Record<string, string | undefined>): JobLimits {
  const number = (raw: string | undefined, fallback: number) => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);
  return { perAgent: number(env.BOXD_JOBS_PER_AGENT, 4), memoryBytes: number(env.BOXD_JOB_MEMORY_MB, 1024) * 1024 * 1024 };
}

/** Why `actor` may not start another job while `running` are its own, or undefined when it may. */
export function capRefusal(actor: string | undefined, running: readonly { job_id: string; command: string }[], limits: JobLimits): string | undefined {
  if (actor === undefined || !actor.startsWith("agent:") || limits.perAgent === 0 || running.length < limits.perAgent) return undefined;
  const list = running.map(job => `${job.job_id} (${job.command.replace(/\s+/g, " ").slice(0, 60)})`).join("; ");
  return `You already have ${running.length} background jobs running, the most one agent may run at once in this box: ${list}. ` +
    "Wait for one to end (Jobs → wait) or stop one you no longer need (Jobs → kill), then start this again.";
}

/** A process's resident memory in bytes, from /proc; 0 when it is gone. */
export function residentBytes(pid: number, proc = "/proc"): number {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`${proc}/${pid}/status`, "utf8"));
    return match === null ? 0 : Number(match[1]) * 1024;
  } catch {
    return 0;
  }
}

/** What a job's whole tree holds: the job's own process and everything under it. */
export function treeResident(root: number, table: readonly ProcessRow[], resident: (pid: number) => number = residentBytes): number {
  return [root, ...treeOf(root, table).pids].reduce((sum, pid) => sum + resident(pid), 0);
}

/** The note a job killed for its memory ends its log with. */
export function memoryNote(held: number, limits: JobLimits): string {
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  return `\n[boxd] stopped: this job's processes held ${mb(held)}, past the ${mb(limits.memoryBytes)} one job may hold in this box. ` +
    "Work on less at once: stream instead of loading whole files, narrow the search, or split the job.\n";
}
