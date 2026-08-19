/**
 * Shell execution inside the box.
 *
 * This deliberately runs the command through a shell: it is the agent's bash tool,
 * and pipes, redirection, and globbing are the point. The security boundary is the
 * container, not argument quoting — which is why the daemon requires a token and
 * why the box should never be given credentials you would not hand to the model.
 */

import { spawn } from "node:child_process";
import type { ExecRequest, ExecResult } from "../protocol/index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Per-stream cap. Tool results this large are already useless to the model. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function clampOutput(chunks: Buffer[], label: string): string {
  const joined = Buffer.concat(chunks);
  if (joined.length <= MAX_OUTPUT_BYTES) return joined.toString("utf8");
  const head = joined.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  const dropped = joined.length - MAX_OUTPUT_BYTES;
  return `${head}\n\n[${label} truncated: ${dropped} more bytes]`;
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
    const child = spawn("/bin/bash", ["-lc", script], {
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

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr.on("data", chunk => stderr.push(chunk as Buffer));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: clampOutput(stdout, "stdout"),
        stderr: clampOutput(stderr, "stderr"),
        exit_code: exitCode,
        timed_out: timedOut,
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
