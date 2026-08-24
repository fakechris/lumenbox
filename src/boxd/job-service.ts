/**
 * Background jobs: the work that outlives a tool call.
 *
 * `/exec` holds an HTTP request and a turn open for as long as the command runs, which
 * is why it has a ceiling — ten minutes is the limit of what can usefully be done while
 * something waits for the answer. Plenty of real work is not like that: a build, a test
 * suite, a dev server that never exits at all, a delegated coding engine chewing through
 * a repository. Those need starting, then asking about.
 *
 * So a job is: start it, get an id, and its output goes to a **file** rather than into a
 * tool result. That file is the second thing this buys. A tool result is truncated to
 * keep a model's context usable, and until now the bytes past the cut simply did not
 * exist anywhere — the truncation notice pointed at nothing. A job's log is complete on
 * disk, and the notice can name a path and a line count that the ordinary file tools
 * then read. Truncation stops being loss.
 *
 * Waiting is explicit and bounded, and can end three ways: the job exited, the text the
 * caller was watching for appeared, or the time ran out. The middle one exists because a
 * server that has printed "listening on 3000" is ready long before it is finished, and
 * waiting for exit would wait forever.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobStartedResult, JobStatus, JobWaitRequest, JobWaitResult } from "../protocol/index.ts";

/** Where logs live: inside the work directory, so the file tools and backups can see them. */
export const JOBS_DIR = process.env.BOXD_JOBS_DIR ?? "/home/box/work/.jobs";

/** How much of a log a wait returns inline. The rest is a file read away. */
const TAIL_BYTES = 8_000;

interface Job {
  status: JobStatus;
  pid: number;
  /** Resolved when the process exits; how a wait attaches without polling the OS. */
  finished: Promise<void>;
}

export class JobService {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly dir: string = JOBS_DIR) {}

  /**
   * Starts a command detached and answers immediately.
   *
   * The shell is the same one `/exec` uses — same nice value, same new process group,
   * same scrubbed environment — because a job is an exec that nobody is waiting on,
   * not a different kind of execution with different rules.
   */
  start(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    display?: number;
    nice: number;
    scrubbedEnv: NodeJS.ProcessEnv;
  }): JobStartedResult {
    mkdirSync(this.dir, { recursive: true });
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    const logPath = join(this.dir, `${jobId}.log`);
    const log = createWriteStream(logPath, { flags: "a" });

    const child = spawn(
      "nice",
      ["-n", String(input.nice), "/bin/bash", "-lc", input.command],
      {
        cwd: input.cwd ?? process.env.HOME ?? "/home/box",
        env: {
          ...input.scrubbedEnv,
          ...(input.display !== undefined ? { DISPLAY: `:${input.display}` } : {}),
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      }
    );

    // Both streams into one file, interleaved as they arrive: a build's errors belong
    // beside the step that produced them, and two files would lose that ordering.
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    const status: JobStatus = {
      job_id: jobId,
      command: input.command,
      running: true,
      started_at: new Date().toISOString(),
      log_path: logPath,
      log_bytes: 0,
    };

    const finished = new Promise<void>(resolve => {
      child.on("close", code => {
        status.running = false;
        status.exit_code = code ?? 1;
        status.ended_at = new Date().toISOString();
        log.end();
        resolve();
      });
      child.on("error", error => {
        status.running = false;
        status.exit_code = 127;
        status.ended_at = new Date().toISOString();
        log.write(`failed to start: ${error.message}\n`);
        log.end();
        resolve();
      });
    });

    this.jobs.set(jobId, { status, pid: child.pid ?? -1, finished });
    return { job_id: jobId, pid: child.pid ?? -1, log_path: logPath };
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map(job => this.withSize(job.status));
  }

  get(jobId: string): JobStatus | undefined {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : this.withSize(job.status);
  }

  /** Stops a job and everything it started. Idempotent: a second kill is not an error. */
  kill(jobId: string): JobStatus | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    if (job.status.running) {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        try {
          process.kill(job.pid, "SIGKILL");
        } catch {
          // Already gone. The close handler has, or will, record the ending.
        }
      }
    }
    return this.withSize(job.status);
  }

  async wait(request: JobWaitRequest): Promise<JobWaitResult | undefined> {
    const job = this.jobs.get(request.job_id);
    if (job === undefined) return undefined;
    const timeoutMs = Math.min(request.timeout_ms ?? 60_000, 600_000);

    const deadline = new Promise<"timeout">(resolve => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    const exited = job.finished.then(() => "exited" as const);

    let reason: JobWaitResult["reason"];
    if (request.until !== undefined && request.until !== "") {
      // Polled rather than watched: the log is being written by a pipe we do not own,
      // and a 250ms poll on a file we already stat for its size costs nothing next to
      // the process it is watching.
      const matched = this.pollFor(job.status.log_path, request.until, timeoutMs);
      reason = await Promise.race([exited, matched, deadline]);
    } else {
      reason = await Promise.race([exited, deadline]);
    }

    return {
      ...this.withSize(job.status),
      reason,
      tail: String(this.tail(job.status.log_path)),
    };
  }

  private pollFor(path: string, needle: string, timeoutMs: number): Promise<"matched"> {
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        if (Date.now() - started > timeoutMs) return;
        // Only the tail is searched, which is where a "ready" line just appeared. A
        // needle that scrolled past long ago is history, not news.
        if (this.tail(path, needle)) return resolve("matched");
        const timer = setTimeout(tick, 250);
        timer.unref?.();
      };
      tick();
    });
  }

  private withSize(status: JobStatus): JobStatus {
    try {
      return { ...status, log_bytes: statSync(status.log_path).size };
    } catch {
      return { ...status };
    }
  }

  /** The last of a log, read straight from disk so a restart does not lose it. */
  private tail(path: string, needle?: string): string | boolean {
    try {
      if (!existsSync(path)) return needle === undefined ? "" : false;
      const size = statSync(path).size;
      const from = Math.max(0, size - TAIL_BYTES);
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        readSync(fd, buffer, 0, buffer.length, from);
        const text = buffer.toString("utf8");
        return needle === undefined ? text : text.includes(needle);
      } finally {
        closeSync(fd);
      }
    } catch {
      return needle === undefined ? "" : false;
    }
  }
}
