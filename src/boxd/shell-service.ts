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

export function runShell(request: ExecRequest): Promise<ExecResult> {
  const command = request.command?.trim();
  if (!command) {
    return Promise.reject(new Error("command must be a non-empty string"));
  }

  const timeoutMs = Math.min(
    request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  return new Promise<ExecResult>(resolve => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: request.cwd ?? process.env.HOME ?? "/home/box",
      env: { ...process.env, ...request.env },
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
