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
 * The native-environment box (INV-438, INV-1700) runs its whole shell under the same sandbox from
 * inside boxd (src/boxd/confinement.ts), with three more rules a host command does not need: the
 * directory a command starts in is not thereby writable (`runIn`), read-only repositories stay
 * read-only even under a writable one (`readOnly`), and the credential places are hidden from
 * reads too (`hideCredentials`) — an agent living on the machine reads without being asked.
 * Hiding also closes the secret stores a file rule does not reach (INV-1711): on macOS the
 * Keychain, which is a service (securityd) rather than a file — Claude Code's login and git's
 * osxkeychain credentials live there — and on Linux the session bus that Secret Service
 * (gnome-keyring, KWallet) answers on, and the gpg-agent and keyring sockets.
 * And it closes the Unix sockets (INV-1716): a socket is a door to a process running as the person —
 * the ssh-agent signs with their keys without a key file being read, docker.sock is root on the
 * machine, tmux runs whatever it is sent. Seatbelt refuses every Unix-socket connection except to
 * sockets under the box's own writable roots (its work directory, rw repositories; never the shared
 * temp directories, where the person's agent and tmux live); bubblewrap has no such rule, so the
 * socket places are hidden instead (`SOCKET_HOMES_UNDER_HOME`, `SOCKET_PATHS`, the whole runtime
 * directory, `$SSH_AUTH_SOCK`'s directory), the variables that name a socket are unset
 * (`SOCKET_VARIABLES`), and the shared temp directories are not there at all: the box gets a /tmp
 * of its own (`privateTmp`, INV-1724), so a socket the person opens in /tmp — before the command
 * started or after — is not in the command's /tmp. Only the egress bridges are bound in, read-only.
 *
 * Known gaps, stated: a hard link made outside the rules is not covered; on Linux the hidden
 * places outside /tmp are the paths that exist when the command starts (a docker socket made
 * later at a new path is reachable); Seatbelt matches the real path,
 * so every path here is resolved first (a `/var/folders` rule silently misses `/private/var`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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
  /** Where the command starts, when that is not `cwd`; starting there makes nothing writable. */
  runIn?: string;
  /** Never writable, even under a writable path: a repository granted read-only. */
  readOnly?: readonly string[];
  /** Refuse reads of the credential places and the person's engine homes as well as writes (`CREDENTIAL_READS_UNDER_HOME`, `ENGINE_HOMES_UNDER_HOME`, `~/.agentbox*`). */
  hideCredentials?: boolean;
  /**
   * With `hideCredentials`, on Linux: the directory that is the command's /tmp and temp directory,
   * kept from one command to the next (the session wrapper's files, an agent's scratch files). The
   * shared ones are never bound in, so the person's sockets there — made before the command or
   * after — are not reachable (INV-1724). Without it the command gets an empty /tmp of its own.
   * macOS refuses a socket by its path instead, and ignores this.
   */
  privateTmp?: string;
  /**
   * Programs that may not be started at all (macOS only): where a node opened the machine's own
   * screen (INV-1707), the programs that capture it or drive it, so the shell cannot reach around
   * the computer tool's gates with the screen permission the node's app holds.
   */
  denyExec?: readonly string[];
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
/** Under the home directory: what a confined process may not even read. Shell rc files stay readable, a login shell needs them. */
export const CREDENTIAL_READS_UNDER_HOME = [".ssh", ".gnupg", ".aws", ".config/gh", ".kube", ".docker/config.json", ".netrc", "Library/Keychains", ".local/share/keyrings"] as const;
/**
 * The Mach services a macOS process reads the Keychain through (INV-1711). `securityd`
 * (`com.apple.SecurityServer`) decrypts the file keychains, `secd` (`com.apple.securityd.*`) the
 * data-protection one, SecurityAgent asks the person to unlock. Measured 2026-11-07 with a
 * throwaway keychain: denying the file is not enough — the keychain is reached through these —
 * and denying `com.apple.SecurityServer` alone already refuses the read. Certificate checks go to
 * `com.apple.trustd`, which stays open: curl, Go, git and node's bundled roots still verify TLS.
 */
export const KEYCHAIN_SERVICES = ["com.apple.SecurityServer", "com.apple.secd", "com.apple.security.KeychainStasher", "com.apple.security.kcsharing", "com.apple.keychainsharingmessagingd"] as const;
/** Prefixes of the same: every `com.apple.securityd.*` endpoint, SecurityAgent and its authhost. */
export const KEYCHAIN_SERVICE_PREFIXES = ["com.apple.securityd", "com.apple.security.agent", "com.apple.security.authhost"] as const;
/**
 * Under the home directory: where container engines keep their sockets (Docker Desktop, OrbStack,
 * Colima, Rancher Desktop, Lima — the last two also keep the VM's ssh key there). Hidden with the
 * credentials (INV-1716): a docker socket is root on the machine.
 */
export const SOCKET_HOMES_UNDER_HOME = [".docker/run", ".orbstack/run", ".colima", ".rd", ".lima"] as const;
/** System-wide sockets of the same kind, hidden on Linux (macOS refuses every Unix socket instead). */
export const SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock", "/run/podman", "/var/run/podman"] as const;
/** The variables that name a socket of the person's: unset in every confined start, so a tool does not even try. */
export const SOCKET_VARIABLES = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "DOCKER_HOST", "CONTAINER_HOST", "DBUS_SESSION_BUS_ADDRESS", "GPG_AGENT_INFO"] as const;
/**
 * Under the home directory: where the person's own coding engines keep their login and history
 * (INV-1710). A confined box runs its engines with a state directory of its own instead
 * (src/boxd/confinement.ts), so these are hidden with the credentials and never writable.
 */
export const ENGINE_HOMES_UNDER_HOME = [".claude", ".claude.json", ".codex", ".gemini", ".config/opencode", ".local/share/opencode", ".pi"] as const;

export interface HostSandboxOptions {
  platform?: NodeJS.Platform;
  home?: string;
  tmp?: string;
  /**
   * The user's runtime directory on Linux (`/run/user/<uid>`), which `hideCredentials` hides whole: the
   * session bus Secret Service answers on, gpg-agent's, the keyring's and systemd's sockets, rootless
   * docker and podman, the ssh-agent a desktop session starts. Replaced in tests.
   */
  runtimeDir?: string;
  /** The person's ssh-agent socket (`$SSH_AUTH_SOCK` where the daemon started), whose directory `hideCredentials` hides. */
  sshAuthSock?: string;
  /** The shared temp directory (`/tmp`), which a confined box on Linux does not see; replaced in tests. */
  systemTmp?: string;
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
  private readonly runtimeDir: string | undefined;
  private readonly sshAuthSock: string | undefined;
  private readonly systemTmp: string;
  private readonly probe: (command: string, args: string[]) => boolean;
  private checked: string | undefined | null = null;

  constructor(options: HostSandboxOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = real(options.home ?? homedir());
    this.tmp = real(options.tmp ?? tmpdir());
    this.probe = options.probe ?? defaultProbe;
    this.sshAuthSock = options.sshAuthSock;
    this.systemTmp = real(options.systemTmp ?? "/tmp");
    this.runtimeDir = options.runtimeDir ?? (this.platform === "linux" && process.getuid !== undefined ? `/run/user/${process.getuid()}` : undefined);
  }

  /** The temp directory the egress bridges listen in (`unixSocketFor`), so the far end and the sandbox agree. */
  get tempDir(): string {
    return this.tmp;
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
    const readOnly = (rules.readOnly ?? []).filter(path => existsSync(path)).map(real);
    const hideSecrets = rules.hideCredentials === true;
    // The box's own places: a socket there is one the box made. The shared temp directories are not its own.
    const owned = writable.filter(path => path !== this.tmp && path !== this.systemTmp);
    const hidden = hideSecrets ? this.hiddenPaths(owned) : [];
    // What is hidden is not writable either: a rw grant of a parent must not reopen it.
    const denied = [...this.deniedPaths(writable.filter(path => path !== this.tmp)), ...readOnly, ...hidden].filter((path, index, all) => all.indexOf(path) === index);
    const ports = [...new Set(rules.loopbackPorts ?? [])];
    const words = [
      `writes only under ${writable.join(", ")}`,
      `never under ${denied.map(path => path.replace(this.home, "~")).join(", ")}`,
      ...(hidden.length > 0 ? [`no reads at all under ${hidden.map(path => path.replace(this.home, "~")).join(", ")}`] : []),
      ...(rules.denyExec !== undefined && rules.denyExec.length > 0 && this.mechanism === "sandbox-exec" ? [`these do not run: ${rules.denyExec.join(", ")}`] : []),
      ...(hideSecrets && this.mechanism === "sandbox-exec" ? ["no Keychain: the securityd services are refused and /usr/bin/security does not run, so no stored login or password can be read"] : []),
      ...(hideSecrets && this.mechanism === "bwrap"
        ? [`a /tmp of its own (${rules.privateTmp === undefined ? "empty for each command" : real(rules.privateTmp)}): the shared ${[...new Set([this.systemTmp, this.tmp])].join(" and ")} and the sockets in them, made before the command or after, are not there`]
        : []),
      ...(hideSecrets
        ? [`no Unix sockets but the box's own${this.mechanism === "sandbox-exec" ? ` (under ${owned.join(", ") || "nothing"})` : ""}: not the person's ssh-agent, docker, tmux or session bus, and no name lookups (the egress proxy resolves names); ${SOCKET_VARIABLES.join(", ")} are unset`]
        : []),
      ports.length > 0 ? `network only to loopback port${ports.length === 1 ? "" : "s"} ${ports.join(", ")} (the egress proxy, which applies the relay's allow list)` : "no network at all (no egress relay is configured for host processes)",
    ];
    return this.mechanism === "sandbox-exec"
      ? { command: "/usr/bin/sandbox-exec", args: ["-p", this.seatbelt(writable, denied, ports, hidden, hideSecrets, owned, rules.denyExec ?? []), ...(hideSecrets ? ["/usr/bin/env", ...SOCKET_VARIABLES.flatMap(name => ["-u", name])] : []), command, ...args], env: {}, mechanism: "sandbox-exec", rules: words }
      : { command: "bwrap", args: this.bwrap(real(rules.runIn ?? cwd), writable, denied, ports, command, args, hidden, hideSecrets, readOnly, rules.privateTmp === undefined ? undefined : real(rules.privateTmp)), env: {}, mechanism: "bwrap", rules: words };
  }

  /**
   * The deny list, resolved, keeping only what exists: a rule for an absent path is noise, and bwrap
   * cannot bind one. The hook and git-config denies hold under every writable root, not only the
   * working directory: a hook planted in any repository a command may write is the same hook.
   */
  private deniedPaths(roots: readonly string[]): string[] {
    const under = (root: string, names: readonly string[]) => names.map(name => join(root, name));
    const candidates = [...under(this.home, DENY_WRITE_UNDER_HOME), ...roots.flatMap(root => under(root, DENY_WRITE_UNDER_CWD)), ...agentboxHomes(this.home)];
    return candidates.filter(path => existsSync(path)).map(real).filter((path, index, all) => all.indexOf(path) === index);
  }

  /** What `hideCredentials` hides, resolved, keeping only what exists. `owned` are the box's own places, never hidden. */
  private hiddenPaths(owned: readonly string[]): string[] {
    const candidates = [...CREDENTIAL_READS_UNDER_HOME, ...ENGINE_HOMES_UNDER_HOME, ...SOCKET_HOMES_UNDER_HOME]
      .map(name => join(this.home, name))
      .concat(agentboxHomes(this.home))
      .concat(this.agentSocket(owned))
      // Seatbelt refuses every Unix socket outside `owned`; bubblewrap can only hide where they are.
      .concat(this.mechanism === "bwrap" ? [...(this.runtimeDir === undefined ? [] : [this.runtimeDir]), ...SOCKET_PATHS] : []);
    return candidates.filter(path => existsSync(path)).map(real).filter((path, index, all) => all.indexOf(path) === index);
  }

  /**
   * The person's ssh-agent: its directory (`/tmp/ssh-XXXX`, `com.apple.launchd.*`), or the socket
   * alone when the directory is one a box needs (the temp directory, the home, a root of its own).
   */
  private agentSocket(owned: readonly string[]): string[] {
    const socket = this.sshAuthSock;
    if (socket === undefined || socket === "" || !socket.startsWith("/")) return [];
    const dir = real(dirname(socket));
    const needed = ["/", this.tmp, this.systemTmp, this.home, ...owned].some(path => path === dir || path.startsWith(`${dir}/`));
    return [needed ? socket : dir];
  }

  private seatbelt(writable: readonly string[], denied: readonly string[], ports: readonly number[], hidden: readonly string[] = [], hideSecrets = false, owned: readonly string[] = [], denyExec: readonly string[] = []): string {
    // The Keychain is a service, not a file: without the Mach lookups nothing can ask securityd for an item (INV-1711).
    // The `security` binary is refused too, so the agent reads a plain "Operation not permitted"; a copy of it is stopped by the lookups.
    const keychain = [...KEYCHAIN_SERVICES.map(name => `(global-name ${sbplPath(name)})`), ...KEYCHAIN_SERVICE_PREFIXES.map(name => `(global-name-prefix ${sbplPath(name)})`)].join(" ");
    // Later rules win in SBPL, so the denies come after the allows.
    const lines = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* ${writable.map(path => `(subpath ${sbplPath(path)})`).join(" ")} (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
      ...(denied.length > 0 ? [`(deny file-write* ${denied.map(path => `(subpath ${sbplPath(path)})`).join(" ")})`] : []),
      ...(hidden.length > 0 ? [`(deny file-read* ${hidden.map(path => `(subpath ${sbplPath(path)})`).join(" ")})`] : []),
      ...(hideSecrets ? [`(deny mach-lookup ${keychain})`, '(deny process-exec (literal "/usr/bin/security"))'] : []),
      ...(denyExec.length > 0 ? [`(deny process-exec ${denyExec.map(path => `(literal ${sbplPath(path)})`).join(" ")})`] : []),
      "(deny network-outbound)",
      ...ports.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`),
      // A host command keeps every Unix socket; the native box only its own (INV-1716). Measured 2026-11-07: with no
      // other socket, curl, git and node reach https through the egress proxy (127.0.0.1, no lookup), npm, python's
      // multiprocessing and node's fork IPC run; refused are the ssh-agent, docker's socket and mDNSResponder (DNS).
      ...(hideSecrets ? (owned.length > 0 ? [`(allow network-outbound (remote unix-socket ${owned.map(path => `(subpath ${sbplPath(path)})`).join(" ")}))`] : []) : ["(allow network-outbound (remote unix-socket))"]),
    ];
    return lines.join("");
  }

  private bwrap(cwd: string, writable: readonly string[], denied: readonly string[], ports: readonly number[], command: string, args: readonly string[], hidden: readonly string[] = [], hideSecrets = false, readOnly: readonly string[] = [], privateTmp?: string): string[] {
    const out = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    // A host command keeps the shared temp directory, bound back writable like every other allowed path. A confined
    // box gets its own (INV-1724): bubblewrap cannot refuse a connect(), so a socket the person opens in /tmp after
    // the command started would be reachable; a /tmp that is not the shared one has no such socket in it, ever.
    const shared = hideSecrets ? [...new Set([this.systemTmp, this.tmp])] : [];
    for (const path of shared) out.push(...(privateTmp === undefined ? ["--tmpfs", path] : ["--bind", privateTmp, path]));
    // The egress bridges (host-egress.ts listens in the shared temp directory) are the one thing bound back in, read-only:
    // a read-only mount does not refuse a connect(), and the box cannot remove or replace its way out.
    if (shared.length > 0) for (const port of ports) if (existsSync(unixSocketFor(this.tmp, port))) out.push("--ro-bind", unixSocketFor(this.tmp, port), unixSocketFor(this.tmp, port));
    // Under the private /tmp only what is bound is there: a granted root under /tmp, bound after it, is; anything else is gone already.
    const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
    const bound = [...writable.filter(path => !shared.includes(path)), ...readOnly];
    const there = (path: string) => !shared.some(top => isUnder(path, top)) || bound.some(root => isUnder(path, root));
    // Roots under the shared temp directory come after it, so they are bound on top of the private one.
    for (const path of writable) if (!shared.includes(path)) out.push("--bind", path, path);
    // A denied path under a writable one is bound back read-only on top; order makes it win.
    for (const path of denied.filter(there)) out.push("--ro-bind", path, path);
    // A hidden directory becomes an empty tmpfs, a hidden file /dev/null: last, so it covers any bind above.
    // The tmpfs is remounted read-only, so a write there fails as it does on macOS instead of vanishing on exit (INV-1710).
    for (const path of hidden.filter(there)) out.push(...(statSync(path).isDirectory() ? ["--tmpfs", path, "--remount-ro", path] : ["--ro-bind", "/dev/null", path]));
    out.push("--unshare-net", "--unshare-pid", "--die-with-parent", "--chdir", cwd);
    // Inside the namespace there is only a fresh loopback. Each allowed port is bridged from a
    // Unix socket the host side listens on (host-egress.ts), so a client's 127.0.0.1:<port> lands there.
    const bridges = ports.map(port => `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${unixSocketFor(this.tmp, port)} & `).join("");
    const unset = hideSecrets ? `unset ${SOCKET_VARIABLES.join(" ")}; ` : "";
    out.push("--", "/bin/sh", "-c", `${unset}${bridges}exec "$0" "$@"`, command, ...args);
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
export function sandboxViolations(wrapped: Pick<WrappedCommand, "rules" | "mechanism">, result: { code: number | null; stderr: string }, widen = "An operator widens the rules in Settings (hostExec.allowWrite) or the relay's allow list"): string | undefined {
  if (result.code === 0) return undefined;
  const signs = /operation not permitted|permission denied|read-only file system|network is unreachable|could not resolve|couldn't connect|connection refused|failed to connect|EPERM|EACCES|EROFS|ENETUNREACH|EAI_AGAIN/i;
  if (!signs.test(result.stderr)) return undefined;
  return ["<sandbox_violations>", `This command ran under the host sandbox (${wrapped.mechanism}); the error above may be one of its rules:`, ...wrapped.rules.map(rule => `- ${rule}`), `${widen}; the sandbox itself is not something a command can leave.`, "</sandbox_violations>"].join("\n");
}
