/**
 * The operating system's own "no" around a process that runs on the host (INV-1344).
 *
 * The box is a wall; two things run outside it with the orchestrator's own privileges: a
 * `RunOnHost` command and a stdio MCP server. Both used to run bare — read `~/.ssh`, write
 * anywhere, connect anywhere. This puts each under the OS sandbox the test runner already
 * uses (scripts/test-sandbox.mjs, INV-1238), with rules instead of a blanket deny:
 *
 *   - **reads** are allowed, as they are for the orchestrator itself;
 *   - **writes** only inside the working directory, the temp directory, and what the operator
 *     listed in `allowWrite` — and never into the places a credential or a hook lives, even
 *     when they are under the working directory (`.git/hooks`, `.git/config`) or the operator
 *     listed a parent (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.agentbox*`, shell rc files);
 *   - **network** only to the loopback ports named — the host egress proxy, so a command's
 *     connections go through the relay and its allow list like a box's do.
 *
 * macOS is a Seatbelt profile handed to `sandbox-exec -p`; Linux is bubblewrap with the root
 * read-only, the writable paths bound back in, and a fresh network namespace in which the
 * loopback ports are bridged from Unix sockets by socat. Where neither mechanism works the
 * sandbox says so and the caller refuses to run: a silent fall-back to bare would be the one
 * thing worse than not having it. No TLS termination: the relay does not do it.
 *
 * Known gaps, stated: a hard link made outside the rules is not covered; on Linux the deny
 * list only covers paths that exist when the command starts; Seatbelt matches the real path,
 * so every path here is resolved first (a `/var/folders` rule silently misses `/private/var`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SandboxMechanism = "sandbox-exec" | "bwrap";

export interface SandboxRules {
  /** The directory the command runs under; writable. */
  cwd: string;
  /** Further writable directories the operator named. */
  allowWrite?: readonly string[];
  /** Loopback TCP ports the child may reach. Everything else on the network is refused. */
  loopbackPorts?: readonly number[];
}

export interface WrappedCommand {
  command: string;
  args: string[];
  /** Environment the wrapper needs on top of the caller's. */
  env: Record<string, string>;
  mechanism: SandboxMechanism;
  /** The rules in force, in words, for the violations block and the log. */
  rules: string[];
}

/** Under the home directory: where credentials and shell startup live. Never writable. */
export const DENY_WRITE_UNDER_HOME = [".ssh", ".gnupg", ".aws", ".config/gh", ".kube", ".docker/config.json", ".netrc", ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv", ".gitconfig"] as const;
/** Under the working directory: what turns a later command into this one's. Never writable. */
export const DENY_WRITE_UNDER_CWD = [".git/hooks", ".git/config"] as const;

export interface HostSandboxOptions {
  platform?: NodeJS.Platform;
  home?: string;
  tmp?: string;
  /** Whether a tool is runnable here; replaced in tests. */
  probe?: (command: string, args: string[]) => boolean;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sbplPath(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function defaultProbe(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export class HostSandbox {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly tmp: string;
  private readonly probe: (command: string, args: string[]) => boolean;
  private checked: string | undefined | null = null;

  constructor(options: HostSandboxOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = real(options.home ?? homedir());
    this.tmp = real(options.tmp ?? tmpdir());
    this.probe = options.probe ?? defaultProbe;
  }

  get mechanism(): SandboxMechanism | undefined {
    if (this.platform === "darwin") return "sandbox-exec";
    if (this.platform === "linux") return "bwrap";
    return undefined;
  }

  /** Why a process cannot be sandboxed here, or undefined when it can. Probed once. */
  unavailableReason(): string | undefined {
    if (this.checked !== null) return this.checked;
    this.checked = this.check();
    return this.checked;
  }

  private check(): string | undefined {
    switch (this.mechanism) {
      case "sandbox-exec":
        return this.probe("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]) ? undefined : "sandbox-exec is not usable on this Mac";
      case "bwrap":
        if (!this.probe("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "/bin/true"])) return "bubblewrap (bwrap) is not installed or cannot create namespaces here; install it, or on Ubuntu 24.04 allow unprivileged user namespaces";
        if (!this.probe("socat", ["-V"])) return "socat is not installed; the sandbox needs it to reach the egress proxy from inside the network namespace";
        return undefined;
      default:
        return `no OS sandbox for host processes on ${this.platform}`;
    }
  }

  /** The command, wrapped. Throws when the sandbox is unavailable: the caller must not run bare. */
  wrap(command: string, args: readonly string[], rules: SandboxRules): WrappedCommand {
    const reason = this.unavailableReason();
    if (reason !== undefined) throw new Error(`Not run: the host sandbox is unavailable (${reason}). Host processes do not run without it.`);
    const cwd = real(rules.cwd);
    const writable = [cwd, this.tmp, ...(rules.allowWrite ?? []).map(real)].filter((path, index, all) => all.indexOf(path) === index);
    const denied = this.deniedPaths(cwd);
    const ports = [...new Set(rules.loopbackPorts ?? [])];
    const words = [
      `writes only under ${writable.join(", ")}`,
      `never under ${denied.map(path => path.replace(this.home, "~")).join(", ")}`,
      ports.length > 0 ? `network only to loopback port${ports.length === 1 ? "" : "s"} ${ports.join(", ")} (the egress proxy, which applies the relay's allow list)` : "no network at all (no egress relay is configured for host processes)",
    ];
    return this.mechanism === "sandbox-exec"
      ? { command: "/usr/bin/sandbox-exec", args: ["-p", this.seatbelt(writable, denied, ports), command, ...args], env: {}, mechanism: "sandbox-exec", rules: words }
      : { command: "bwrap", args: this.bwrap(cwd, writable, denied, ports, command, args), env: {}, mechanism: "bwrap", rules: words };
  }

  /** The deny list, resolved, keeping only what exists: a rule for an absent path is noise, and bwrap cannot bind one. */
  private deniedPaths(cwd: string): string[] {
    const under = (root: string, names: readonly string[]) => names.map(name => join(root, name));
    const candidates = [...under(this.home, DENY_WRITE_UNDER_HOME), ...under(cwd, DENY_WRITE_UNDER_CWD), ...agentboxHomes(this.home)];
    return candidates.filter(path => existsSync(path)).map(real).filter((path, index, all) => all.indexOf(path) === index);
  }

  private seatbelt(writable: readonly string[], denied: readonly string[], ports: readonly number[]): string {
    // Later rules win in SBPL, so the denies come after the allows.
    const lines = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* ${writable.map(path => `(subpath ${sbplPath(path)})`).join(" ")} (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
      ...(denied.length > 0 ? [`(deny file-write* ${denied.map(path => `(subpath ${sbplPath(path)})`).join(" ")})`] : []),
      "(deny network-outbound)",
      ...ports.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`),
      "(allow network-outbound (remote unix-socket))",
    ];
    return lines.join("");
  }

  private bwrap(cwd: string, writable: readonly string[], denied: readonly string[], ports: readonly number[], command: string, args: readonly string[]): string[] {
    // No tmpfs over /tmp: the temp directory is writable because it is bound back in like every
    // other allowed path, so a write anywhere else under /tmp is refused rather than swallowed.
    const out = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const path of writable) out.push("--bind", path, path);
    // A denied path under a writable one is bound back read-only on top; order makes it win.
    for (const path of denied) out.push("--ro-bind", path, path);
    out.push("--unshare-net", "--unshare-pid", "--die-with-parent", "--chdir", cwd);
    // Inside the namespace there is only a fresh loopback. Each allowed port is bridged from a
    // Unix socket the host side listens on (host-egress.ts), so a client's 127.0.0.1:<port> lands there.
    const bridges = ports.map(port => `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${unixSocketFor(this.tmp, port)} & `).join("");
    out.push("--", "/bin/sh", "-c", `${bridges}exec "$0" "$@"`, command, ...args);
    return out;
  }
}

/** Where the host side listens for a loopback port's traffic from inside a Linux namespace. */
export function unixSocketFor(tmp: string, port: number): string {
  return join(tmp, `agentbox-host-port-${port}.sock`);
}

/** `~/.agentbox` and its siblings (`~/.agentbox-grok`…): the host's own records and tokens. */
function agentboxHomes(home: string): string[] {
  const parent = dirname(join(home, ".agentbox"));
  try {
    return readdirSync(parent).filter(name => name.startsWith(".agentbox")).map(name => join(parent, name));
  } catch {
    return [join(home, ".agentbox")];
  }
}

/**
 * The block a host process's result carries when the sandbox may have been what stopped it
 * (INV-1344): the rules in force, so the model reads "writes outside the working directory
 * are refused" instead of guessing at an EPERM. Nothing when the output shows no such sign.
 */
export function sandboxViolations(wrapped: Pick<WrappedCommand, "rules" | "mechanism">, result: { code: number | null; stderr: string }): string | undefined {
  if (result.code === 0) return undefined;
  const signs = /operation not permitted|permission denied|read-only file system|network is unreachable|could not resolve|couldn't connect|connection refused|failed to connect|EPERM|EACCES|EROFS|ENETUNREACH|EAI_AGAIN/i;
  if (!signs.test(result.stderr)) return undefined;
  return ["<sandbox_violations>", `This command ran under the host sandbox (${wrapped.mechanism}); the error above may be one of its rules:`, ...wrapped.rules.map(rule => `- ${rule}`), "An operator widens the rules in Settings (hostExec.allowWrite) or the relay's allow list; the sandbox itself is not something a command can leave.", "</sandbox_violations>"].join("\n");
}
