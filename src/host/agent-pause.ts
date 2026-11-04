/**
 * Pausing and resuming an agent (INV-1554): what a person does when "Stop" is not enough.
 *
 * Pause writes the record (src/agents/pause.ts) the bus checks before every turn, ends the turn in
 * flight, stops the agent's running background jobs, and keeps a receipt. Resume removes the record
 * and wakes the agent with a host note saying how long it was paused and by whom; the messages that
 * queued meanwhile are read in that turn.
 *
 * Background jobs carry no owner the host can read back, but every one an agent starts answers
 * "Started as job-…" into its own record — so the tail of that record names them.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { clearPause, readPause, writePause, type Pause } from "../agents/pause.ts";

export interface AgentPauseDeps {
  dirFor: (agentId: string) => string;
  /** Ends its turns in flight; returns whose it ended. */
  interrupt: (agentIds: string[], reason: string) => string[];
  box: () => { jobs(): Promise<{ jobs: { job_id: string; running: boolean }[] }>; killJob(jobId: string): Promise<unknown> } | undefined;
  /** Gives the agent a host message in the lane drained first, so it arrives with what people sent meanwhile. */
  tell: (agentId: string, text: string) => Promise<void>;
  /** Wakes every conversation with a queue: a chat thread's messages wait as long as the main one's. */
  wake: (agentId: string) => void;
  receipt: (subject: string, decision: string, because: string) => void;
  log: (line: string) => void;
  now?: () => Date;
}

const JOB_STARTED = /Started as (job-[0-9a-f]{16})/g;
const TAIL_BYTES = 2_000_000;

/** The job ids an agent's record says it started, from the last few megabytes. */
export function jobsNamedIn(path: string, tailBytes = TAIL_BYTES): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return [...new Set([...buffer.toString("utf8").matchAll(JOB_STARTED)].map(match => match[1]!))];
  } finally {
    closeSync(fd);
  }
}

/** Every record in an agent's directory — each conversation, each context epoch — where a job it started is named. */
export function recordsIn(agentDir: string): string[] {
  if (!existsSync(agentDir)) return [];
  const found: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith(".jsonl")) found.push(path); } };
  walk(agentDir);
  return found;
}

export class AgentPauses {
  constructor(private readonly deps: AgentPauseDeps) {}

  pauseOf(agentId: string): Pause | undefined {
    return readPause(this.deps.dirFor(agentId));
  }

  async pause(agentId: string, by: string, reason: string): Promise<{ jobsStopped: string[]; turnStopped: boolean }> {
    writePause(this.deps.dirFor(agentId), { by, at: (this.deps.now?.() ?? new Date()).toISOString(), reason });
    const turnStopped = this.deps.interrupt([agentId], "paused").length > 0;
    const jobsStopped: string[] = [];
    const box = this.deps.box();
    if (box !== undefined) {
      const named = new Set(recordsIn(this.deps.dirFor(agentId)).flatMap(path => jobsNamedIn(path)));
      const running = (await box.jobs().catch((error: unknown) => { this.deps.log(`pause: could not list jobs: ${error instanceof Error ? error.message : String(error)}`); return { jobs: [] }; })).jobs.filter(job => job.running && named.has(job.job_id));
      for (const job of running) {
        await box.killJob(job.job_id).then(() => jobsStopped.push(job.job_id), error => this.deps.log(`pause: could not stop ${job.job_id}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    this.deps.receipt(`agent:${agentId}`, "paused", `${by}${reason ? `: ${reason}` : ""}; ${turnStopped ? "turn stopped" : "no turn in flight"}; ${jobsStopped.length} background job(s) stopped`);
    this.deps.log(`${by} paused ${agentId}${reason ? ` (${reason})` : ""}; stopped ${jobsStopped.length} job(s)`);
    return { jobsStopped, turnStopped };
  }

  async resume(agentId: string, by: string): Promise<boolean> {
    const pause = this.pauseOf(agentId);
    if (pause === undefined) return false;
    clearPause(this.deps.dirFor(agentId));
    this.deps.receipt(`agent:${agentId}`, "resumed", `${by}; paused since ${pause.at} by ${pause.by}`);
    const since = pause.at ? Math.max(1, Math.round(((this.deps.now?.() ?? new Date()).getTime() - Date.parse(pause.at)) / 60_000)) : undefined;
    await this.deps.tell(agentId, `<host_notification source="pause">${by} resumed you${since !== undefined ? ` after about ${since} minute${since === 1 ? "" : "s"}` : ""}; ${pause.by} had paused you${pause.reason ? ` (${pause.reason})` : ""}. Your background jobs from before were stopped. Messages people sent you meanwhile come with this note; teammates' follow after. Read them before picking anything else back up.</host_notification>`);
    this.deps.wake(agentId);
    return true;
  }
}
