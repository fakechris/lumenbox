/**
 * Pausing and resuming an agent (INV-1554): what a person does when "Stop" is not enough.
 *
 * Pause writes the record (src/agents/pause.ts) the bus checks before every turn, ends the turn in
 * flight, stops the agent's running background jobs, and keeps a receipt. Resume removes the record
 * and wakes the agent with a host note saying how long it was paused and by whom; the messages that
 * queued meanwhile are read in that turn.
 *
 * Explicit box job ownership authorizes cleanup. Historical text is only a diagnostic hint:
 * a quoted peer message cannot authorize stopping that peer's process or an unowned process.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { clearPause, readPause, writePause, type Pause } from "../agents/pause.ts";

export interface AgentPauseDeps {
  dirFor: (agentId: string) => string;
  /** Ends its turns in flight; returns whose it ended. */
  interrupt: (agentIds: string[], reason: string) => string[];
  box: (agentId: string) => { jobs(): Promise<{ jobs: { job_id: string; running: boolean; owner?: string }[] }>; killJob(jobId: string): Promise<unknown>; waitForJob?(request:{job_id:string;timeout_ms:number}):Promise<{running:boolean}> } | undefined;
  /** Gives the agent a host message in the lane drained first, so it arrives with what people sent meanwhile. */
  tell: (agentId: string, text: string) => Promise<void>;
  /** Wakes every conversation with a queue: a chat thread's messages wait as long as the main one's. */
  wake: (agentId: string) => void;
  receipt: (subject: string, decision: string, because: string) => void;
  log: (line: string) => void;
  now?: () => Date;
}

const JOB_STARTED = /(?:Started as|continuing as) (job-[0-9a-f]{8}(?:[0-9a-f]{8})?)\b/g;
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

export interface PauseResult { jobsStopped: string[]; turnStopped: boolean; jobsUnconfirmed?: string[]; errors?: string[] }

export class AgentPauses {
  constructor(private readonly deps: AgentPauseDeps) {}

  pauseOf(agentId: string): Pause | undefined {
    return readPause(this.deps.dirFor(agentId));
  }

  barrier(ids: string[], by: string, reason: string): void { for (const id of ids) if (!this.pauseOf(id)) writePause(this.deps.dirFor(id), { by, reason, at: (this.deps.now?.() ?? new Date()).toISOString() }); }

  async pause(agentId: string, by: string, reason: string): Promise<PauseResult> {
    writePause(this.deps.dirFor(agentId), { by, at: (this.deps.now?.() ?? new Date()).toISOString(), reason });
    return this.stopPaused(agentId, by, reason);
  }

  async pauseMany(agentIds: string[], by: string, reason: string, afterBarrier?: (ids:string[])=>void): Promise<{ paused: string[]; failures: {agentId:string;error:string}[]; results: {agentId:string;result:PauseResult}[] }> {
    const paused: string[] = [], failures: {agentId:string;error:string}[] = [];
    // All selected agents are durably barred before the first asynchronous cleanup begins.
    for (const id of new Set(agentIds)) {
      try { if (!this.pauseOf(id)) writePause(this.deps.dirFor(id), {by,at:(this.deps.now?.() ?? new Date()).toISOString(),reason}); paused.push(id); }
      catch (error) { failures.push({agentId:id,error:error instanceof Error ? error.message : String(error)}); }
    }
    afterBarrier?.(paused);
    const results = await Promise.all(paused.map(async agentId => { try { return {agentId,result:await this.stopPaused(agentId,by,reason)}; } catch(error) { return {agentId,result:{jobsStopped:[],turnStopped:false,errors:[error instanceof Error?error.message:String(error)]}}; } }));
    return {paused,failures,results};
  }

  private async stopPaused(agentId: string, by: string, reason: string): Promise<PauseResult> {
    const turnStopped = this.deps.interrupt([agentId], "paused").length > 0;
    const jobsStopped: string[] = [], jobsUnconfirmed: string[] = [], errors: string[] = [];
    const box = this.deps.box(agentId);
    if (box !== undefined) {
      const named = new Set(recordsIn(this.deps.dirFor(agentId)).flatMap(path => jobsNamedIn(path)));
      const jobs = (await box.jobs().catch((error: unknown) => { errors.push(`Could not list background jobs: ${error instanceof Error ? error.message : String(error)}`); this.deps.log(errors.at(-1)!); return { jobs: [] }; })).jobs;
      const running=jobs.filter(job=>job.running && job.owner===`agent:${agentId}`);
      for(const job of jobs.filter(job=>job.running && !job.owner && named.has(job.job_id))){jobsUnconfirmed.push(job.job_id);errors.push(`Ownership of ${job.job_id} is unknown; a quoted history entry cannot authorize stopping it`);}
      for (const job of running) {
        try {
          await box.killJob(job.job_id);
          const status=await box.waitForJob?.({job_id:job.job_id,timeout_ms:100});
          if(status && !status.running)jobsStopped.push(job.job_id);
          else {jobsUnconfirmed.push(job.job_id);errors.push(`Stop requested for ${job.job_id}; process exit is unconfirmed`);}
        } catch(error) {jobsUnconfirmed.push(job.job_id);errors.push(`Could not confirm stopping ${job.job_id}: ${error instanceof Error?error.message:String(error)}`);this.deps.log(errors.at(-1)!);}
      }
    } else errors.push("Computer unavailable; background jobs could not be checked");
    this.deps.receipt(`agent:${agentId}`, "paused", `${by}${reason ? `: ${reason}` : ""}; ${turnStopped ? "turn stopped" : "no turn in flight"}; ${jobsStopped.length} background job exit(s) confirmed; ${jobsUnconfirmed.length} unconfirmed${errors.length ? `; unconfirmed: ${errors.join("; ")}` : ""}`);
    this.deps.log(`${by} paused ${agentId}${reason ? ` (${reason})` : ""}; stopped ${jobsStopped.length} job(s)`);
    return { jobsStopped, turnStopped, ...(jobsUnconfirmed.length?{jobsUnconfirmed}:{}), ...(errors.length ? {errors} : {}) };
  }

  async resume(agentId: string, by: string): Promise<boolean> {
    const pause = this.pauseOf(agentId);
    if (pause === undefined) return false;
    clearPause(this.deps.dirFor(agentId));
    this.deps.receipt(`agent:${agentId}`, "resumed", `${by}; paused since ${pause.at} by ${pause.by}`);
    const since = pause.at ? Math.max(1, Math.round(((this.deps.now?.() ?? new Date()).getTime() - Date.parse(pause.at)) / 60_000)) : undefined;
    await this.deps.tell(agentId, `<host_notification source="pause">${by} resumed you${since !== undefined ? ` after about ${since} minute${since === 1 ? "" : "s"}` : ""}; ${pause.by} had paused you${pause.reason ? ` (${pause.reason})` : ""}. Stop requests were sent for known background jobs; verify any unconfirmed jobs before continuing. Messages people sent you meanwhile come with this note; teammates' follow after. Read them before picking anything else back up.</host_notification>`);
    this.deps.wake(agentId);
    return true;
  }
}
