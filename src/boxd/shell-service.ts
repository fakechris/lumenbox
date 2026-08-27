/**
 * Shell execution inside the box.
 *
 * This deliberately runs the command through a shell: it is the agent's bash tool,
 * and pipes, redirection, and globbing are the point. The security boundary is the
 * container, not argument quoting — which is why the daemon requires a token and
 * why the box should never be given credentials you would not hand to the model.
 */

import { envNumber } from "../config.ts";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DURABLE_RESULT_CHARS, type ExecRequest, type ExecResult } from "../protocol/index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The longest any one command may run.
 *
 * There is a ceiling because an exec holds an HTTP request and a turn open for its whole duration,
 * so an unbounded one is a wedged turn nobody can see into. Ten minutes is not the limit of what
 * the box can do — a longer job is started detached and polled — it is the limit of what can
 * usefully be done while something waits for the answer.
 *
 * The effective value comes back on the result. It used to be clamped silently, so a caller asking
 * for an hour was killed at ten minutes with nothing saying why, and would reasonably conclude the
 * command itself had failed.
 */
export const MAX_TIMEOUT_MS = 600_000;
/** Per-stream cap. Tool results this large are already useless to the model. */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Where output too large for a tool result is kept, and the words that announce it.
 *
 * The marker is a contract between two sides that never call each other: the daemon
 * writes it into the truncation notice, and the host recognises it when trimming that
 * notice down for the transcript — because a pointer that survives one truncation and
 * not the next points at nothing. Grep for the marker to find both halves.
 */
/**
 * The spool's fixed home.
 *
 * It used to honour `BOXD_SPOOL_DIR`, and that made the backup exclusion a lie: the host
 * excludes the literal `./.spool` from a volume archive, so pointing the daemon at
 * `/home/box/work/full-output` put every command's untruncated output back into every
 * upgrade backup. Two ways to fix it — teach the host the box's environment, or stop the
 * box having one — and this is the cheaper and the sounder, because the exclusion cannot
 * drift from a constant it shares.
 *
 * The tests that need a different directory pass one to `BoundedOutput` directly, which
 * is where the parameter always was.
 */
export const SPOOL_DIR = "/home/box/work/.spool";
export const SPILL_MARKER = "full output kept:";

/**
 * Output past this goes to a file, whether or not the daemon itself drops any.
 *
 * Three thresholds for three different jobs, and this one was measured against the wrong
 * one. The 2 MiB cap above protects the daemon's memory and is where bytes are *lost*.
 * The host shows the model up to 20,000 characters. And the host's *transcript* keeps
 * `DURABLE_RESULT_CHARS` — two thousand. This threshold was set below the display cap, so
 * a result between 2 KB and 16 KB was shown to the model in full, stored as a 2 KB head,
 * and given no pointer: the tail was durably gone and nothing said so. The adversarial
 * review of docs/15 found it with a command producing 2,500 characters.
 *
 * So it is now pinned to the *durable* limit, which is the only one where bytes stop
 * being recoverable. Spilling starts earlier and more often than before — that is the
 * point, and the cost is small files in a directory that is reaped and is no longer
 * copied into backups.
 */
export const SPILL_AT_BYTES = envNumber("BOXD_SPILL_AT_BYTES", DURABLE_RESULT_CHARS);

/**
 * Collects a stream up to the cap and counts the rest.
 *
 * The cap used to be applied at the end, over everything the process had written: every chunk was
 * retained and then concatenated and truncated. So the advertised 2 MiB limit bounded the *result*
 * and not the memory — `yes`, a runaway logger or a verbose build could take the container's whole
 * allowance and kill the daemon before it had anything to return, which reads as the box crashing
 * rather than as a command producing too much output.
 *
 * The head is kept, which is what the cap always did. Whether the *tail* would be more useful for a
 * failing build is a real question and a separate one; this only stops the daemon dying.
 */
export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private dropped = 0;
  /** Everything the command wrote, including what neither the cap nor the host will show. */
  private seen = 0;
  /** Where everything went, once there was more of it than fits in a tool result. */
  private spoolPath: string | undefined;
  private spool: number | undefined;

  /**
   * @param spoolDir where to keep the full output when it outgrows the cap. Absent
   * means no spilling, which is what every existing caller and test gets.
   * @param spoolName the file's name, unique per stream per command.
   */
  constructor(
    private readonly spoolDir?: string,
    private readonly spoolName?: string
  ) {}

  /**
   * Opens the spool on first overflow and back-fills what was already kept.
   *
   * Lazily, because the overwhelming majority of commands produce a line or two and
   * should not pay for a file descriptor, and eagerly-from-the-start would put every
   * `ls` on disk. The back-fill is what makes the file the *whole* output rather than
   * only the part that did not fit.
   */
  private openSpool(): void {
    if (this.spool !== undefined || this.spoolDir === undefined || this.spoolName === undefined) {
      return;
    }
    try {
      mkdirSync(this.spoolDir, { recursive: true });
      const path = join(this.spoolDir, this.spoolName);
      this.spool = openSync(path, "w");
      this.spoolPath = path;
      for (const chunk of this.chunks) writeSync(this.spool, chunk);
    } catch {
      // No spool is the old behaviour, not a failed command: the truncation notice
      // then simply has no path to offer.
      this.spool = undefined;
      this.spoolPath = undefined;
    }
  }

  push(chunk: Buffer): void {
    this.seen += chunk.length;
    // Large but not yet lossy: the file starts here, because the host will trim this
    // result long before the daemon drops any of it.
    if (this.seen > SPILL_AT_BYTES) this.openSpool();
    if (this.spool !== undefined) {
      try {
        writeSync(this.spool, chunk);
      } catch {
        // A spool that stops accepting writes stops being complete; the notice still
        // points at what did land, which beats pointing at nothing.
      }
    }

    const room = MAX_OUTPUT_BYTES - this.kept;
    if (room <= 0) {
      this.dropped += chunk.length;
      return;
    }
    const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(take);
    this.kept += take.length;
    this.dropped += chunk.length - take.length;
  }

  /** Closes the spool. Safe to call when there never was one. */
  close(): void {
    if (this.spool === undefined) return;
    try {
      closeSync(this.spool);
    } catch {
      // Nothing useful to do; the bytes that were flushed are still there.
    }
    this.spool = undefined;
  }

  /** Bytes actually held. The claim the cap makes, and the one worth asserting on. */
  retained(): number {
    return this.kept;
  }

  /** Bytes seen and thrown away. */
  discarded(): number {
    return this.dropped;
  }

  toString(label: string): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    // The pointer rides whenever a file exists, not only when the daemon dropped
    // something — because the trimming that loses most output happens upstream, and a
    // result that arrives whole here can still reach the model in pieces. It goes
    // last, which is where the host's own middle-truncation keeps it.
    const where =
      this.spoolPath === undefined
        ? ""
        : `\n\n[${SPILL_MARKER} ${this.spoolPath} — all ${this.seen} bytes of ${label}]`;
    if (this.dropped === 0) return `${text}${where}`;
    return `${text}\n\n[${label} truncated: ${this.dropped} more bytes]${where}`;
  }
}

/**
 * Deletes spool files older than a day, once, at startup.
 *
 * Kept because they are evidence for the turn that made them and dead weight after
 * it: a box that ran a hundred verbose builds should not carry every one of them
 * forever. A day is well past the life of any transcript entry that still points here.
 */
export function reapSpool(dir: string = SPOOL_DIR, olderThanMs = 24 * 3_600_000): number {
  let removed = 0;
  try {
    const cutoff = Date.now() - olderThanMs;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // Raced with something else, or not ours to delete. Skip it.
      }
    }
  } catch {
    // No spool directory yet, which is the ordinary state of a fresh box.
  }
  return removed;
}

/** Session keys name files, so keep them to characters that cannot escape a path. */
function sessionKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return safe.length > 0 ? safe.slice(0, 64) : undefined;
}

/**
 * Wraps a command so shell state survives to the next call in the same session.
 *
 * A fresh shell per call looks fine until the model runs `cd build`, then `make`,
 * and the second command silently executes somewhere else — the same trap that
 * catches `export`, `source venv/bin/activate`, and `nvm use`. The model has no
 * way to see this happen; it just gets wrong results.
 *
 * Rather than hold a long-lived interactive bash and parse sentinels out of its
 * output — which brings its own hangs and partial-read problems — each call
 * restores the previous working directory and exported environment, runs, and
 * saves them again. An EXIT trap does the saving so state persists even if the
 * command calls `exit`. This covers cwd and exported variables, which is nearly
 * all of the value; shell functions and aliases do not carry over.
 */
/**
 * The daemon's own credential, kept out of the agent's reach.
 *
 * BOXD_TOKEN is what authorises a box request, and it was in the environment every shell
 * command inherited — so an agent could read it and drive the daemon directly, including
 * another agent's desktop. Removing it closes the easy path. It is not airtight: the
 * daemon's own /proc entry still carries it and the agents run as the same user, so this
 * is one lock on a door that is not the boundary. The boundary is the container.
 */
export function withoutBoxToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of SCRUBBED_ENV) delete copy[name];
  return copy;
}

/**
 * Credentials no agent shell has a reason to see.
 *
 * The model API keys matter once the orchestrator runs inside the box: they would
 * otherwise be in the environment of every command an agent runs. Named explicitly
 * rather than matched by pattern, so a token the user deliberately put in the box for
 * the agent to use — a GitHub token, say — still reaches it.
 */
/**
 * How far behind the interactive path the agent's own work runs.
 *
 * 19, because it was measured rather than guessed. Twelve cores, the agent saturating all
 * of them, screenshot latency:
 *
 *   idle                185ms
 *   loaded, no nice     489ms
 *   loaded, nice 10     327ms
 *   loaded, nice 19     189ms
 *
 * The desktop is only busy in bursts, and nice does nothing on an idle box — Linux hands
 * spare time to whoever wants it — so the agent loses almost nothing for the desktop
 * feeling untouched. box-chrome puts itself back at 0: a browser the user is watching is
 * part of the interactive path even though an agent started it.
 */
export const AGENT_NICE = envNumber("BOXD_AGENT_NICE", 19);

export const SCRUBBED_ENV = [
  "BOXD_TOKEN",
  "ANTHROPIC_API_KEY",
  "MINIMAX_CODE_CN_API_KEY",
  "AGENTBOX_API_KEY",
  "AGENTBOX_TOKEN",
];

function wrapForSession(command: string, key: string, explicitCwd?: string): string {
  const cwdFile = `/tmp/boxd-session-${key}.cwd`;
  const envFile = `/tmp/boxd-session-${key}.env`;

  return [
    `__bs_save() { pwd > '${cwdFile}' 2>/dev/null; export -p > '${envFile}' 2>/dev/null; }`,
    `trap __bs_save EXIT`,
    // Restore the environment before the directory, so a saved PWD cannot fight
    // the cd below.
    `[ -f '${envFile}' ] && . '${envFile}' 2>/dev/null`,
    // An explicit cwd on the request wins over the remembered one.
    explicitCwd
      ? `cd ${shellQuote(explicitCwd)} 2>/dev/null`
      : `__bs_dir=$(cat '${cwdFile}' 2>/dev/null); [ -n "$__bs_dir" ] && [ -d "$__bs_dir" ] && cd "$__bs_dir"`,
    command,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runShell(request: ExecRequest): Promise<ExecResult> {
  const command = request.command?.trim();
  if (!command) {
    return Promise.reject(new Error("command must be a non-empty string"));
  }

  const timeoutMs = Math.min(
    request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const key = sessionKey(request.session);
  const script = key ? wrapForSession(command, key, request.cwd) : command;

  return new Promise<ExecResult>(resolve => {
    // Run behind the interactive path. One box shares its CPU between two workloads with
    // very different needs: the desktop, whose latency the user feels directly as
    // "computer use is slow", and whatever the agent is running, which is throughput work.
    // Measured on twelve cores with the agent saturating them: a screenshot went from
    // 185ms to 489ms. A nice value costs the agent nothing while the box is idle and hands
    // the desktop the CPU when it is not.
    //
    // Inherited by everything the command starts, which is the point — the expensive thing
    // is usually a build, not the shell. Not a guarantee: the agent has sudo and could
    // renice itself back. It is the same accident-prevention line as the desktop tokens.
    const child = spawn("nice", ["-n", String(AGENT_NICE), "/bin/bash", "-lc", script], {
      // With a session the script does its own cd; without one, honour the request.
      cwd: key ? undefined : (request.cwd ?? process.env.HOME ?? "/home/box"),
      env: {
        ...withoutBoxToken(process.env),
        // A GUI launched from the shell must land on the agent's own desktop, not
        // on whichever one the daemon happens to default to.
        ...(request.display ? { DISPLAY: `:${request.display}` } : {}),
        ...request.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // New process group, so a timeout kills the whole tree rather than
      // leaving orphaned children holding the display or a port.
      detached: true,
    });

    // One spool pair per command, named by time and a short random suffix so two
    // concurrent commands cannot collide.
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const stdout = new BoundedOutput(SPOOL_DIR, `${runId}.out.log`);
    const stderr = new BoundedOutput(SPOOL_DIR, `${runId}.err.log`);
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr.on("data", chunk => stderr.push(chunk as Buffer));

    // How long to wait, after killing, for the pipes to close on their own.
    //
    // Because `close` fires when every inherited stdout/stderr descriptor is closed, not when the
    // command exits — and a descendant can leave the process group (`setsid`, a daemon that
    // double-forks) and keep those descriptors open. The group kill does not reach it, so the
    // request stayed pending long past its own ceiling: measured in a real container, a `setsid sh
    // -c "sleep 30"` held /exec open for the full thirty seconds after the kill at 1.5s.
    //
    // Reaping an escapee properly needs a PID namespace or a cgroup, neither of which is available
    // here without more privilege than this container should have. What is in our control is not
    // waiting for it.
    const DRAIN_GRACE_MS = 2_000;
    let escaped = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      setTimeout(() => {
        if (settled) return;
        // Something outlived the kill and is still holding the pipes. Let go of our end and answer
        // now: a caller waiting forever learns nothing, and the timeout it asked for was a promise.
        escaped = true;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(124);
      }, DRAIN_GRACE_MS).unref?.();
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closed before the strings are built, so the notice describes a complete file.
      stdout.close();
      stderr.close();
      resolve({
        stdout: stdout.toString("stdout"),
        stderr:
          stderr.toString("stderr") +
          (escaped
            ? `\n[the command was killed, but something it started left the process group and is ` +
              `still running — its output is not captured here and it was not stopped]`
            : ""),
        exit_code: exitCode,
        timed_out: timedOut,
        timeout_ms: timeoutMs,
      });
    };

    child.on("error", error => {
      stderr.push(Buffer.from(`failed to spawn: ${error.message}`));
      finish(127);
    });

    // `close` rather than `exit`, so both stdio streams are fully drained.
    child.on("close", code => finish(code ?? (timedOut ? 124 : 1)));
  });
}
