/**
 * The shell on the person's own machine, inside the operating system's "no" (INV-1700).
 *
 * A Docker box is a wall: its whole filesystem is the agent's, and nothing the agent runs can
 * reach the machine it is on. The native-environment box (INV-438, `agentbox host up`) has no
 * wall — boxd runs as the person, and before this a `bash` call could write anywhere the person
 * can, while only the file routes checked the granted directories (headless.ts). So every
 * process this daemon starts for an agent on a headless box — a foreground command, a background
 * job, a delegated engine — is started under the same OS sandbox `RunOnHost` uses
 * (src/host/host-sandbox.ts; one concept, one home):
 *
 *   - **writes** only under the repositories granted rw, the work directory and the temp
 *     directories; a repository granted ro is read-only even when it sits under a rw one, and
 *     the credential and hook places are never writable;
 *   - **reads** of the credential places (`~/.ssh`, `~/.aws`, `~/.agentbox*`…) refused, because an
 *     agent living here is not asked before each command the way `RunOnHost` is;
 *   - **network** only to the box's egress proxy when a relay is configured, and none otherwise.
 *
 * The tools and engines an agent runs keep state under `$HOME` (`~/.npm`, `~/.cache`, `~/.claude`,
 * `~/.codex`), which the rules above refuse. Opening the home would hand the box the person's own
 * engine logins, so instead each agent gets a state directory of its own under the work directory
 * (`<work>/.state/<agent>`, INV-1710), and every confined start points the XDG directories, npm's
 * cache and the engines' homes there (`stateEnvironment`; the layout is `STATE_VARIABLES` in
 * src/host/box-paths.ts, where the host derives a delegated engine's files from it, INV-1712). The person's own engine homes are
 * hidden like the credentials. Per agent is for order, not secrecy: agents on one box are one user.
 *
 * Fail closed: where the sandbox cannot be applied, nothing runs, and the refusal says why. A bare
 * fall-back would be exactly the hole this closes. Every confined start and every refusal is a line
 * in the daemon's log, with who asked, which is the audit the box keeps of itself.
 */

import { mkdirSync, realpathSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { HostSandbox, sandboxViolations, type WrappedCommand } from "../host/host-sandbox.ts";
import { mirrorOnUnixSocket } from "../host/host-egress.ts";
import { STATE_VARIABLES, stateName } from "../host/box-paths.ts";
import type { Roots } from "./headless.ts";

/** Refused before anything ran: the box answers 403, the host reads it as refused. */
export class ConfinementRefused extends Error {}

/** The writable temp directory every shell script assumes, beside the user's own `$TMPDIR`. */
const SYSTEM_TMP = "/tmp";

/** The environment that puts an agent's tool and engine state in `dir`; each subdirectory exists after this. */
export function stateEnvironment(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [variable, sub] of Object.entries(STATE_VARIABLES)) {
    env[variable] = join(dir, sub);
    // Codex refuses a CODEX_HOME that does not exist, so every one is made, not only the parent.
    mkdirSync(env[variable]!, { recursive: true, mode: 0o700 });
  }
  return env;
}

export interface ConfineContext {
  /** The directory the command starts in; starting there makes nothing writable. */
  cwd?: string;
  /** Who asked (`agent:<id>`), for the log line. */
  actor?: string;
  /** What is being started, for the log line: `exec`, `job`, `acp`. */
  what: string;
}

export interface Confine {
  /** The command to spawn instead. Throws `ConfinementRefused` when the sandbox is unavailable. */
  /**
   * The command to spawn instead, and `env` to set last, over the request's own: the agent's state
   * directory (`stateEnvironment`). Throws `ConfinementRefused` when the sandbox is unavailable.
   */
  wrap(command: string, args: readonly string[], context: ConfineContext): { command: string; args: string[]; wrapped: WrappedCommand; env: Record<string, string> };
  /** The block to append to a failed command's stderr when the sandbox may be why; logged as a refusal. */
  violations(wrapped: WrappedCommand, result: { exit_code: number; stderr: string }, context: ConfineContext): string | undefined;
  /** Mirror the egress proxy's port where a Linux namespace can reach it (host-egress.ts). */
  bridge(port: number): void;
  /** The rules in words, for the start-up line. */
  describe(): string;
}

export interface ConfinementOptions {
  /** A headless box is confined; a container is not (its wall is Docker). */
  headless: boolean;
  /** The granted directories, read on every call so a change is seen. */
  roots: () => Roots;
  /** Where the box's own work lives (`AGENTBOX_WORK_DIR`); always writable, and the agents' state directories are under it. */
  workDir?: string;
  /** The box's egress proxy port, once up; the only network a confined command reaches. */
  egressPort: () => number | undefined;
  log: (line: string) => void;
  /** Replaced in tests: platform, home, probe. */
  sandbox?: HostSandbox;
  /** The shared temp directory (`/tmp`); replaced in tests so "outside" can be somewhere real. */
  systemTmp?: string;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The confinement for this daemon, or undefined where the box itself is the wall. */
export function confinementFor(options: ConfinementOptions): Confine | undefined {
  if (!options.headless) return undefined;
  const sandbox = options.sandbox ?? new HostSandbox();
  const systemTmp = real(options.systemTmp ?? SYSTEM_TMP);
  let mirror: Server | undefined;
  const rules = () => {
    const repositories = options.roots().list();
    const writable = repositories.filter(entry => entry.mode === "rw").map(entry => entry.path);
    const home = options.workDir !== undefined && options.workDir !== "" ? options.workDir : writable[0];
    const port = options.egressPort();
    return {
      // With no work directory and no rw repository, the temp directory is the only writable place.
      cwd: home ?? systemTmp,
      allowWrite: [...writable, systemTmp],
      readOnly: repositories.filter(entry => entry.mode === "ro").map(entry => entry.path),
      loopbackPorts: port === undefined ? [] : [port],
      hideCredentials: true,
    };
  };
  const who = (context: ConfineContext) => `${context.what} [${context.actor ?? "unlabelled"}]`;
  // Under the work directory, which is writable; with none, under the temp directory, which is too.
  const stateRoot = () => join(options.workDir !== undefined && options.workDir !== "" ? options.workDir : systemTmp, ".state");
  const widen = (context?: ConfineContext) =>
    `Tools and engines keep their state in ${context === undefined ? join(stateRoot(), "<agent>") : join(stateRoot(), stateName(context.actor))} ($${Object.keys(STATE_VARIABLES).join(", $")}), not in the person's home, whose engine logins this box never sees. ` +
    "The person widens the rules by granting a directory rw in the box's bundle (agentbox host up --repo)";
  return {
    wrap(command, args, context) {
      const reason = sandbox.unavailableReason();
      if (reason !== undefined) {
        options.log(`confinement: refused ${who(context)}: the OS sandbox is unavailable (${reason})`);
        throw new ConfinementRefused(
          `Not run: this box is the person's own machine, and commands here run only inside the OS sandbox, which is unavailable (${reason}). ` +
            "Nothing was started. The person can fix the sandbox on this machine; there is no way to run bare."
        );
      }
      const wrapped = sandbox.wrap(command, args, { ...rules(), ...(context.cwd !== undefined ? { runIn: context.cwd } : {}) });
      const env = stateEnvironment(join(stateRoot(), stateName(context.actor)));
      options.log(`confinement: ${who(context)} under ${wrapped.mechanism}`);
      return { command: wrapped.command, args: wrapped.args, wrapped, env };
    },
    violations(wrapped, result, context) {
      const block = sandboxViolations(wrapped, { code: result.exit_code, stderr: result.stderr }, widen(context));
      if (block !== undefined) options.log(`confinement: refused by the sandbox, ${who(context)} (exit ${result.exit_code}): ${result.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`);
      return block;
    },
    bridge(port) {
      if (sandbox.mechanism !== "bwrap" || mirror !== undefined) return;
      mirror = mirrorOnUnixSocket(port);
    },
    describe() {
      const reason = sandbox.unavailableReason();
      if (reason !== undefined) return `every command is refused: the OS sandbox is unavailable (${reason})`;
      return `commands run under ${sandbox.mechanism}: ${sandbox.wrap("/bin/true", [], rules()).rules.join("; ")}; ${widen()}`;
    },
  };
}
