/**
 * The commands a turn let go of (INV-1461): a foreground command that outlived its window
 * became a job, and somebody has to notice when it ends and tell the agent.
 *
 * The turn that started it has moved on — that is the point; the person's next message must
 * not wait behind a build. So this watches the job from outside any turn: a long wait on the
 * box per job, and when it ends, one host message into the agent's conversation on the
 * background lane, which the bus runs after anything a person has queued. A job that runs
 * past the cap is killed and the agent is told that too; one left running on purpose with
 * `background: true` is never watched here.
 *
 * In memory only. A host restart forgets the watch; the job itself is on the box's own list,
 * and the agent can still ask after it with `Jobs`.
 */

export const JOB_WATCH_CAP_MS = 30 * 60_000;
/** How long one wait on the box lasts before it is asked again. */
const POLL_MS = 60_000;

export interface WatchedJob {
  agentId: string;
  conversation: string;
  /** The box's generation when the watch began (INV-1476): a wake for an earlier one is dropped. */
  generation?: number;
  jobId: string;
  command: string;
  startedAt: number;
}

export interface JobWatchBox {
  waitForJob(request: { job_id: string; timeout_ms?: number }): Promise<{ running: boolean; exit_code?: number; interrupted?: boolean; log_path: string; tail: string; reason: string }>;
  killJob(jobId: string): Promise<unknown>;
}

export interface JobWatchDeps {
  /** The box the job runs on; undefined when none is connected, which ends the watch. */
  box: () => JobWatchBox | undefined;
  /** Tells the agent, in its conversation, as a host message. */
  wake: (agentId: string, conversation: string, text: string) => Promise<void>;
  /** The current generation of the agent's box (INV-1476); absent means generations are not tracked. */
  generation?: (agentId: string) => number;
  log: (line: string) => void;
  now?: () => number;
  capMs?: number;
  pollMs?: number;
}

/** The message the agent gets when a job it let go of ends. */
export function jobEndedNote(job: WatchedJob, ended: { exit_code?: number; interrupted?: boolean; log_path: string; tail: string }, killed: boolean): string {
  const how = killed
    ? `was stopped after ${Math.round(JOB_WATCH_CAP_MS / 60_000)} minutes, the limit for a command a turn left running`
    : ended.interrupted === true
      ? "ended with its exit unknown (the box daemon restarted under it)"
      : `finished with exit code ${ended.exit_code}`;
  const tail = ended.tail.trim() === "" ? "(no output at the end)" : ended.tail.trim().slice(-2_000);
  return (
    `[A command you started earlier ${how}: ${job.jobId}]\n` +
    `Command: ${job.command.slice(0, 200)}\n` +
    `Full log: ${ended.log_path}\n\n` +
    `Last output:\n${tail}\n\n` +
    `Pick the work up from here. If the person is waiting on this, tell them the result; if it changes nothing they need to hear, say nothing.`
  );
}

export class JobWatch {
  private readonly open = new Map<string, WatchedJob>();

  constructor(private readonly deps: JobWatchDeps) {}

  /** Starts watching; a job already watched is left alone. */
  watch(job: Omit<WatchedJob, "startedAt">): void {
    if (this.open.has(job.jobId)) return;
    const watched: WatchedJob = { ...job, startedAt: (this.deps.now ?? Date.now)(), ...(this.deps.generation !== undefined ? { generation: this.deps.generation(job.agentId) } : {}) };
    this.open.set(job.jobId, watched);
    void this.follow(watched).catch(error => this.deps.log(`job watch ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`)).finally(() => this.open.delete(job.jobId));
  }

  /** How many of this agent's jobs are being watched, across its conversations (INV-1559 diagnostics). */
  countFor(agentId: string): number {
    return [...this.open.values()].filter(job => job.agentId === agentId).length;
  }

  /** The jobs still running that this agent let go of in this conversation. */
  openJobs(agentId: string, conversation: string): WatchedJob[] {
    return [...this.open.values()].filter(job => job.agentId === agentId && job.conversation === conversation);
  }

  /** The box was reconnected since the watch began: the job's end belongs to an incarnation that is gone, and the agent is not woken for it. */
  private staleNow(job: WatchedJob): boolean {
    if (job.generation === undefined || this.deps.generation === undefined || this.deps.generation(job.agentId) === job.generation) return false;
    this.deps.log(`stale-generation: job watch ${job.jobId} began at box generation ${job.generation}, now ${this.deps.generation(job.agentId)}; the wake is dropped`);
    return true;
  }

  private async follow(job: WatchedJob): Promise<void> {
    const cap = this.deps.capMs ?? JOB_WATCH_CAP_MS;
    const now = this.deps.now ?? Date.now;
    for (;;) {
      const box = this.deps.box();
      if (box === undefined) { this.deps.log(`job watch ${job.jobId}: no box; the agent can ask Jobs about it`); return; }
      const elapsed = now() - job.startedAt;
      if (elapsed >= cap) {
        await box.killJob(job.jobId).catch(() => undefined);
        const ended = await box.waitForJob({ job_id: job.jobId, timeout_ms: 3_000 }).catch(() => undefined);
        this.deps.log(`job watch ${job.jobId}: killed at the ${Math.round(cap / 60_000)}-minute cap`);
        if (this.staleNow(job)) return;
        await this.deps.wake(job.agentId, job.conversation, jobEndedNote(job, ended ?? { log_path: "(unknown)", tail: "" }, true));
        return;
      }
      const waited = await box.waitForJob({ job_id: job.jobId, timeout_ms: Math.min(this.deps.pollMs ?? POLL_MS, cap - elapsed) });
      if (waited.running) continue;
      if (this.staleNow(job)) return;
      this.deps.log(`job watch ${job.jobId}: ended (${waited.interrupted === true ? "interrupted" : `exit ${waited.exit_code}`}); waking ${job.agentId}`);
      await this.deps.wake(job.agentId, job.conversation, jobEndedNote(job, waited, false));
      return;
    }
  }
}
