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
 *   - **Under the OS sandbox (INV-1344).** Writes only under that root, the temp directory
 *     and what the operator listed; network only through the egress relay; `~/.ssh` and its
 *     kin never writable. `hostExec.sandbox: "off"` is the operator's written opt-out; where
 *     the sandbox cannot be applied the command is refused with the reason, never run bare.
 *
 * An approved command still runs with the orchestrator's own privileges where the sandbox
 * allows — reading the disk, driving the desktop. The sandbox is the accident boundary the
 * approval cannot be: a person reads `npm test`, not what every script under it writes.
 *
 * The generality is deliberate: this one tool is how `pi`, `claude`, `codex`, a shell
 * script, `osascript`, or `arduino-cli` all become reachable, without a line of code
 * per integration. The agent runs `pi "refactor the repo"` the way it runs `ls`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { callEnvironment } from "../egress/call.ts";
import type { HostEgress } from "./host-egress.ts";
import { type HostSandbox, type SandboxMechanism, sandboxViolations } from "./host-sandbox.ts";

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
  /** The OS sandbox around each command. "on" unless the operator wrote "off". */
  sandbox: "on" | "off";
  /** Directories writable besides `cwd` and the temp directory. */
  allowWrite: string[];
}

export interface HostRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when the timeout, not the command, ended it. */
  timedOut: boolean;
  /** How much output was dropped for the cap, if any. */
  truncatedBytes: number;
  /** How the command was confined, when it was, and the violations block when the sandbox may have stopped it. */
  sandbox?: { mechanism: SandboxMechanism; note?: string };
}

/** What a host process needs besides its command: the sandbox, and the egress proxy its connections go through. */
export interface HostProcessDeps {
  sandbox?: HostSandbox;
  /** Resolved once the proxy listens; undefined when no relay is configured, and then there is no network. */
  egress?: Promise<HostEgress | undefined>;
}

export function hostRunnerConfig(raw: {
  enabled?: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandbox?: "on" | "off";
  allowWrite?: string[];
}): HostRunnerConfig {
  return {
    enabled: raw.enabled === true,
    ...(typeof raw.cwd === "string" && raw.cwd.trim() !== "" ? { cwd: raw.cwd.trim() } : {}),
    // Floored at 1s and capped at 30 minutes: a host command may be a long build, but a
    // number outside these is a mistake, not an intention.
    timeoutMs: Math.min(Math.max(Number(raw.timeoutMs) || 300_000, 1_000), 1_800_000),
    maxOutputBytes: Math.min(Math.max(Number(raw.maxOutputBytes) || 200_000, 1_000), 5_000_000),
    sandbox: raw.sandbox === "off" ? "off" : "on",
    allowWrite: (raw.allowWrite ?? []).filter(path => typeof path === "string" && path.trim() !== "").map(path => path.trim()),
  };
}

export class HostRunner {
  constructor(
    private readonly config: HostRunnerConfig,
    private readonly deps: HostProcessDeps = {}
  ) {}

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
    if (this.config.sandbox === "on") {
      if (this.deps.sandbox === undefined) return "Host execution is sandboxed by default and no sandbox was wired in; an operator sets hostExec.sandbox to \"off\" to run host commands bare.";
      const reason = this.deps.sandbox.unavailableReason();
      if (reason !== undefined) return `Host commands run under the OS sandbox, which is unavailable here: ${reason}. An operator may set hostExec.sandbox to "off" in writing.`;
    }
    return undefined;
  }

  /**
   * Runs one command through the shell, on the host, under the configured root.
   *
   * `secretEnv` is merged over the process environment for this one command only —
   * this is how a vaulted credential reaches a `git push` without ever being written
   * anywhere. It lives in the child's environment for the life of the command and
   * nowhere else; nothing is persisted, and it never enters the box.
   *
   * `call` is the INV-784 token for the tool call this is: the egress proxy credential, so
   * the relay's record names the call and its refusals come back on the result (INV-1345).
   */
  async run(command: string, secretEnv: Record<string, string> = {}, call?: string): Promise<HostRunResult> {
    const reason = this.unavailableReason();
    if (reason !== undefined) throw new Error(reason);
    const cwd = this.config.cwd!;

    const egress = this.config.sandbox === "on" ? await this.deps.egress : undefined;
    const release = call !== undefined && egress !== undefined ? egress.calls.begin(call) : () => {};
    const egressEnv = egress === undefined ? {} : call !== undefined ? callEnvironment(call, egress.port) : proxyEnvironment(egress.port);
    // Through the login shell so an agent's `pi`/`claude`/`osascript` resolves the
    // same way it does in the person's own terminal — PATH, aliases, rc files. The
    // command is a single argument to the shell, never interpolated into a string,
    // which is why this uses execFile and not exec.
    const wrapped =
      this.config.sandbox === "on"
        ? this.deps.sandbox!.wrap("/bin/sh", ["-lc", command], { cwd, allowWrite: this.config.allowWrite, loopbackPorts: egress === undefined ? [] : [egress.port] })
        : undefined;
    const env = { ...process.env, ...egressEnv, ...(wrapped?.env ?? {}), ...secretEnv };

    return new Promise(resolve => {
      const child = execFile(
        wrapped?.command ?? "/bin/sh",
        wrapped?.args ?? ["-lc", command],
        {
          cwd,
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxOutputBytes + 1_000_000,
          killSignal: "SIGKILL",
          env,
        },
        (error, stdout, stderr) => {
          release();
          const cap = (text: string): [string, number] => {
            if (text.length <= this.config.maxOutputBytes) return [text, 0];
            return [text.slice(0, this.config.maxOutputBytes), text.length - this.config.maxOutputBytes];
          };
          const [outText, outDropped] = cap(String(stdout));
          const [errText, errDropped] = cap(String(stderr));
          const timedOut =
            error !== null && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const result: HostRunResult = {
            stdout: outText,
            stderr: errText,
            code: child.exitCode,
            timedOut,
            truncatedBytes: outDropped + errDropped,
          };
          if (wrapped !== undefined) {
            const note = sandboxViolations(wrapped, { code: child.exitCode, stderr: String(stderr) });
            result.sandbox = { mechanism: wrapped.mechanism, ...(note !== undefined ? { note } : {}) };
          }
          resolve(result);
        }
      );
    });
  }
}

/** The proxy variables without a call credential: a connection the relay records as unattributed. */
export function proxyEnvironment(port: number): Record<string, string> {
  const proxy = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };
}
