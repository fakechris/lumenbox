/**
 * The words a shell result becomes in a tool result: which timeout killed it and whether it was
 * the one asked for, the exit code, and the two streams within a cap. A command that outlived
 * its foreground window (INV-1461) says so first: it is still running, as a job, and the agent
 * will hear when it ends.
 */

import type { JobStartedResult } from "../protocol/index.ts";
import type { OnEnd } from "./job-end.ts";

/** Keeps both ends of a long text, the middle noted as omitted — the same cut the tool results use. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - max} characters omitted] ...\n\n${text.slice(text.length - half)}`;
}

export function stillRunningNote(job: JobStartedResult, foregroundMs: number, onEnd: OnEnd = "wake_on_failure", waitOnly = false): string {
  // What its end will do is said here, where the agent decides whether to wait (INV-1613).
  const ending = waitOnly
    ? `This command only waits, so its end will not wake you and is not worth a turn: when you need to wait for something, use Jobs wait (until a line, or with a timeout) — it costs nothing while it waits — instead of a sleep.`
    : onEnd === "wake"
      ? `You will get a message in this conversation when it ends, so do not wait for it or poll it: go on with what you can, or end your turn.`
      : onEnd === "record"
        ? `Its end will not wake you; your next turn opens with a note that it ended. If you need its result before going on, Jobs wait for it now.`
        : `You will be woken only if it fails (a non-zero exit, or output matching wake_when). If you need its result to go on, Jobs wait for it now — it costs nothing while it waits — or pass on_end: "wake" next time; otherwise go on with what you can, or end your turn.`;
  return (
    `[still running after ${Math.round(foregroundMs / 1000)}s — continuing as ${job.job_id} (pid ${job.pid}); ` +
    `its output from here goes to ${job.log_path}. ${ending} Jobs can read, wait for or stop it.]`
  );
}

/** Formats an exec result the way a person reading a terminal would want it. */
export function formatExec(
  result: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    timeout_ms?: number;
    still_running?: JobStartedResult;
  },
  requestedTimeoutMs?: number,
  foregroundMs?: number,
  ending?: { onEnd: OnEnd; waitOnly: boolean }
): string {
  const parts: string[] = [];
  if (result.still_running !== undefined) parts.push(stillRunningNote(result.still_running, foregroundMs ?? 0, ending?.onEnd, ending?.waitOnly));
  if (result.timed_out) {
    const applied = result.timeout_ms;
    // Which timeout killed it, and whether it was the one asked for. A command killed at ten
    // minutes after a request for an hour looks like a crash unless the cap is named.
    const capped =
      applied !== undefined && requestedTimeoutMs !== undefined && requestedTimeoutMs > applied
        ? ` — the box caps a single command at ${applied}ms, so the ${requestedTimeoutMs}ms you ` +
          `asked for was not applied. For longer work, start it detached and poll it.`
        : applied !== undefined
          ? ` after ${applied}ms`
          : "";
    parts.push(`[command timed out and was killed${capped}]`);
  }
  if (result.still_running === undefined) parts.push(`exit code: ${result.exit_code}`);
  // Caps chosen so one `npm install` or one `cat` of a log cannot eat the context.
  if (result.stdout.trim()) parts.push(`stdout:\n${truncate(result.stdout, 20_000)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${truncate(result.stderr, 10_000)}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}
