/**
 * Running a command on the machine the orchestrator is on, not inside the box.
 *
 * The box is a wall on purpose: an agent with a shell cannot touch the USB port the
 * Arduino is on, the AppleScript that drives the desktop apps, or a `pi`/`claude`/`codex`
 * CLI installed on the host. That wall is most of the safety story, so the door through
 * it is built to be the narrowest, loudest one possible:
 *
 *   - **Off by default.** No config, no tool. The tool is not offered — not offered and
 *     refused, *absent* — so an agent on a box with this disabled never learns it could
 *     have asked. This is what makes "escape the sandbox" an operator's decision, taken
 *     once, in writing, rather than an emergent capability.
 *   - **Every command asks.** Host execution is in the approval-required set by
 *     construction, so each command pauses for a person who reads the exact text before
 *     it runs. The three approval scopes apply — a repeated safe command can be granted
 *     for the session or always — but the default is once, and the person chooses.
 *   - **A working directory, not the whole disk.** Commands run under a configured root
 *     (the person's choice; there is no default, because inventing one is choosing what
 *     an agent may reach on someone's behalf).
 *
 * This is not a security boundary — a command a person approved runs with the
 * orchestrator's own privileges, which is the point of approving it. It is an
 * accident boundary and an audit trail, the same shape as everything else here.
 *
 * The generality is deliberate: this one tool is how `pi`, `claude`, `codex`, a shell
 * script, `osascript`, or `arduino-cli` all become reachable, without a line of code
 * per integration. The agent runs `pi "refactor the repo"` the way it runs `ls`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface HostRunnerConfig {
  /** Whether the host door exists at all. Default false. */
  enabled: boolean;
  /**
   * The directory host commands run under. No default: a default here would be this
   * code choosing what an agent may reach on the operator's machine.
   */
  cwd?: string;
  /** Ceiling on one command, floored and capped so neither a typo nor a hang runs away. */
  timeoutMs: number;
  /** Bytes of combined output kept; the rest is dropped with a note, like the box shell. */
  maxOutputBytes: number;
}

export interface HostRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when the timeout, not the command, ended it. */
  timedOut: boolean;
  /** How much output was dropped for the cap, if any. */
  truncatedBytes: number;
}

export function hostRunnerConfig(raw: {
  enabled?: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): HostRunnerConfig {
  return {
    enabled: raw.enabled === true,
    ...(typeof raw.cwd === "string" && raw.cwd.trim() !== "" ? { cwd: raw.cwd.trim() } : {}),
    // Floored at 1s and capped at 30 minutes: a host command may be a long build, but a
    // number outside these is a mistake, not an intention.
    timeoutMs: Math.min(Math.max(Number(raw.timeoutMs) || 300_000, 1_000), 1_800_000),
    maxOutputBytes: Math.min(Math.max(Number(raw.maxOutputBytes) || 200_000, 1_000), 5_000_000),
  };
}

export class HostRunner {
  constructor(private readonly config: HostRunnerConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Why a run cannot happen, if it cannot — so the tool can refuse with a reason a
   * person can act on rather than a bare failure.
   */
  unavailableReason(): string | undefined {
    if (!this.config.enabled) {
      return "Host execution is turned off. An operator enables it in Settings.";
    }
    if (this.config.cwd === undefined) {
      return "Host execution has no working directory set; an operator must choose one first.";
    }
    if (!existsSync(this.config.cwd)) {
      return `The host working directory ${this.config.cwd} does not exist.`;
    }
    return undefined;
  }

  /** Runs one command through the shell, on the host, under the configured root. */
  run(command: string): Promise<HostRunResult> {
    const reason = this.unavailableReason();
    if (reason !== undefined) return Promise.reject(new Error(reason));

    return new Promise(resolve => {
      // Through the login shell so an agent's `pi`/`claude`/`osascript` resolves the
      // same way it does in the person's own terminal — PATH, aliases, rc files. The
      // command is a single argument to the shell, never interpolated into a string,
      // which is why this uses execFile and not exec.
      const child = execFile(
        "/bin/sh",
        ["-lc", command],
        {
          cwd: this.config.cwd,
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxOutputBytes + 1_000_000,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          const cap = (text: string): [string, number] => {
            if (text.length <= this.config.maxOutputBytes) return [text, 0];
            return [text.slice(0, this.config.maxOutputBytes), text.length - this.config.maxOutputBytes];
          };
          const [outText, outDropped] = cap(String(stdout));
          const [errText, errDropped] = cap(String(stderr));
          const timedOut =
            error !== null && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          resolve({
            stdout: outText,
            stderr: errText,
            code: child.exitCode,
            timedOut,
            truncatedBytes: outDropped + errDropped,
          });
        }
      );
    });
  }
}
