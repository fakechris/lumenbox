/**
 * The commands a turn let go of (INV-1461): a foreground command that outlived its window
 * became a job, and somebody has to notice when it ends and tell the agent.
 *
 * The turn that started it has moved on — that is the point; the person's next message must
 * not wait behind a build. So this watches the job from outside any turn: a long wait on the
 * box per job, and when it ends, one host message into the agent's conversation on the
 * background lane, which the bus runs after anything a person has queued. A job that runs
 * past the cap is killed and the agent is told that too; one left running on purpose with
 * `background: true` is watched only when the agent asked for an `on_end`.
 *
 * Not every end is worth a turn (INV-1613). Each job carries an `on_end`: the default for a
 * command that outlived its window wakes the agent only on failure, and the rest go on the
 * record the next turn opens with. Ends that do wake are held for a short window and merged,
 * so ten jobs finishing together open one turn, not ten.
 *
 * In memory only. A host restart forgets the watch; the job itself is on the box's own list,
 * and the agent can still ask after it with `Jobs`.
 */

import { type JobEnd, type OnEnd, wakesFor } from "./job-end.ts";

export const JOB_WATCH_CAP_MS = 30 * 60_000;
/** How long one wait on the box lasts before it is asked again. */
const POLL_MS = 60_000;
/** How long an end that wakes is held so others finishing close behind join the same turn. */
export const MERGE_WINDOW_MS = 20_000;
/** Recorded ends kept per conversation; older ones fall off, the log file still has them. */
const RECORD_CAP = 40;

export interface WatchedJob {
  agentId: string;
  conversation: string;
  /** The box's generation when the watch began (INV-1476): a wake for an earlier one is dropped. */
  generation?: number;
  jobId: string;
  command: string;
  startedAt: number;
  /** What the end is worth (INV-1613); absent means wake_on_failure. */
  onEnd?: OnEnd;
  /** For wake_on_failure: output text that also wakes. */
  wakeWhen?: string;
  /** False for a job the agent chose to run in the background: its length is its own business, so the cap does not kill it. */
  capped?: boolean;
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
  /** Every end, woken for or not (INV-1741): the exception list counts a failed one and resolves on a success. */
  ended?: (job: WatchedJob, end: JobEnd) => void;
  now?: () => number;
  capMs?: number;
  pollMs?: number;
  mergeMs?: number;
}

/** An end the agent was not woken for, kept for its next turn. */
export interface RecordedEnd {
  jobId: string;
  command: string;
  exit_code?: number;
  interrupted?: boolean;
  killed?: boolean;
  log_path: string;
  at: number;
}

type Ended = { exit_code?: number; interrupted?: boolean; log_path: string; tail: string };

/** The message the agent gets when a job it let go of ends. */
export function jobEndedNote(job: WatchedJob, ended: Ended, killed: boolean): string {
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

/** Several ends that woke within one window, as one message. */
export function mergedEndsNote(notes: readonly string[]): string {
  if (notes.length === 1) return notes[0]!;
  return `[${notes.length} commands you started earlier ended within a few seconds of each other; all of them follow.]\n\n` + notes.join("\n\n---\n\n");
}

export class JobWatch {
  private readonly open = new Map<string, WatchedJob>();
  private readonly recorded = new Map<string, RecordedEnd[]>();
  private readonly held = new Map<string, { notes: string[]; timer: ReturnType<typeof setTimeout> }>();

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

  /** The ends this conversation was not woken for, oldest first; taking them clears them. */
  takeRecorded(agentId: string, conversation: string): RecordedEnd[] {
    const key = `${agentId}/${conversation}`;
    const ends = this.recorded.get(key) ?? [];
    this.recorded.delete(key);
    return ends;
  }

  /** The box was reconnected since the watch began: the job's end belongs to an incarnation that is gone, and the agent is not woken for it. */
  private staleNow(job: WatchedJob): boolean {
    if (job.generation === undefined || this.deps.generation === undefined || this.deps.generation(job.agentId) === job.generation) return false;
    this.deps.log(`stale-generation: job watch ${job.jobId} began at box generation ${job.generation}, now ${this.deps.generation(job.agentId)}; the wake is dropped`);
    return true;
  }

  /** The end is judged under the job's policy: a wake joins the held window, anything else goes on the record. */
  private async settle(job: WatchedJob, ended: Ended, killed: boolean): Promise<void> {
    const policy = job.onEnd ?? "wake_on_failure";
    const end: JobEnd = { exit_code: ended.exit_code, interrupted: ended.interrupted, killed, tail: ended.tail };
    const how = killed ? "killed at the cap" : ended.interrupted === true ? "interrupted" : `exit ${ended.exit_code}`;
    try { this.deps.ended?.(job, end); } catch (error) { this.deps.log(`job watch ${job.jobId}: could not note the end (${error instanceof Error ? error.message : String(error)})`); }
    if (!wakesFor(policy, job.wakeWhen, end)) {
      const key = `${job.agentId}/${job.conversation}`;
      const list = this.recorded.get(key) ?? [];
      list.push({ jobId: job.jobId, command: job.command, exit_code: ended.exit_code, interrupted: ended.interrupted, killed, log_path: ended.log_path, at: (this.deps.now ?? Date.now)() });
      this.recorded.set(key, list.slice(-RECORD_CAP));
      this.deps.log(`job watch ${job.jobId}: ended (${how}); recorded for ${job.agentId}'s next turn (on_end ${policy})`);
      return;
    }
    this.deps.log(`job watch ${job.jobId}: ended (${how}); waking ${job.agentId}`);
    await this.hold(job, jobEndedNote(job, ended, killed));
  }

  /** The first wake in a window starts the timer; the rest join it; one message goes when it fires. */
  private hold(job: WatchedJob, note: string): Promise<void> {
    const key = `${job.agentId}/${job.conversation}`;
    const window = this.deps.mergeMs ?? MERGE_WINDOW_MS;
    const already = this.held.get(key);
    if (already !== undefined) { already.notes.push(note); return Promise.resolve(); }
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        const batch = this.held.get(key);
        this.held.delete(key);
        if (batch === undefined) { resolve(); return; }
        void this.deps.wake(job.agentId, job.conversation, mergedEndsNote(batch.notes))
          .catch(error => this.deps.log(`job watch wake for ${job.agentId}: ${error instanceof Error ? error.message : String(error)}`))
          .finally(resolve);
      }, window);
      timer.unref?.();
      this.held.set(key, { notes: [note], timer });
    });
  }

  private async follow(job: WatchedJob): Promise<void> {
    const cap = this.deps.capMs ?? JOB_WATCH_CAP_MS;
    const now = this.deps.now ?? Date.now;
    for (;;) {
      const box = this.deps.box();
      if (box === undefined) { this.deps.log(`job watch ${job.jobId}: no box; the agent can ask Jobs about it`); return; }
      const elapsed = now() - job.startedAt;
      if (job.capped !== false && elapsed >= cap) {
        await box.killJob(job.jobId).catch(() => undefined);
        const ended = await box.waitForJob({ job_id: job.jobId, timeout_ms: 3_000 }).catch(() => undefined);
        this.deps.log(`job watch ${job.jobId}: killed at the ${Math.round(cap / 60_000)}-minute cap`);
        if (this.staleNow(job)) return;
        await this.settle(job, ended ?? { log_path: "(unknown)", tail: "" }, true);
        return;
      }
      const waited = await box.waitForJob({ job_id: job.jobId, timeout_ms: job.capped === false ? (this.deps.pollMs ?? POLL_MS) : Math.min(this.deps.pollMs ?? POLL_MS, cap - elapsed) });
      if (waited.running) continue;
      if (this.staleNow(job)) return;
      await this.settle(job, waited, false);
      return;
    }
  }
}
