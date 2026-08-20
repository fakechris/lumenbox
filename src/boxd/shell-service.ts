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
import type { ExecRequest, ExecResult } from "../protocol/index.ts";

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

  push(chunk: Buffer): void {
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
    if (this.dropped === 0) return text;
    return `${text}\n\n[${label} truncated: ${this.dropped} more bytes]`;
  }
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

    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
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
