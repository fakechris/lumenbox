/**
 * Command execution helpers for the X11 tools.
 *
 * These run inside the box, so a hung xdotool would wedge the whole daemon;
 * every path is bounded by a timeout.
 */

import { execFile, spawn, type ExecFileOptions } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface ExecOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

function baseOptions(options: ExecOptions | undefined): ExecFileOptions {
  return {
    timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: MAX_BUFFER,
  };
}

export function exec(
  command: string,
  args: readonly (string | number)[],
  options?: ExecOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args.map(String),
      { ...baseOptions(options), encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

export function execBuffer(
  command: string,
  args: readonly (string | number)[],
  options?: ExecOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args.map(String),
      { ...baseOptions(options), encoding: "buffer" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as Buffer);
      }
    );
  });
}

/** Runs a command, writes `input` to its stdin, and resolves once it exits 0. */
export function execWithInput(
  command: string,
  args: readonly (string | number)[],
  options: ExecOptions & { input: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args.map(String), {
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const settle = (finish: () => void) => {
      clearTimeout(timer);
      finish();
    };

    child.on("error", error => settle(() => reject(error)));
    // `close` rather than `exit`, so stdio is drained and released before the
    // caller continues and nothing is left holding the event loop open.
    child.on("close", code =>
      settle(() => {
        if (code === 0) resolve();
        else {
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          reject(new Error(`${command} exited with code ${code}${detail}`));
        }
      })
    );

    child.stdin.on("error", error => {
      // A child that exits without draining stdin aborts our write; its exit
      // code and stderr are the useful diagnostic, not our EPIPE.
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        settle(() => reject(error));
      }
    });
    child.stdin.end(options.input);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
