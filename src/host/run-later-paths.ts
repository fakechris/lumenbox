/**
 * Files that are run later: the one table (INV-1861).
 *
 * The policy gate stops a command when it runs. It did not stop a write to a file that something
 * else will run afterwards, under somebody else's authority: a git hook runs at the person's next
 * commit, a CI workflow at the next push with the project's secrets, a `postinstall` on every
 * machine that installs the project, a shell startup file in every terminal. An edit that becomes
 * a command without anyone having been asked about a command is the gap this closes.
 *
 * Three roots, because that is how the paths are written: under a home directory, inside a
 * project, and absolute on the system. `hostDenied` marks the entries the OS sandbox already
 * refuses outright on the person's own machine — host-sandbox.ts builds its deny lists from them,
 * so that list and this one cannot drift. Every other entry is a question for the policy gate (the
 * `run-later` tier): a person is asked, and the card says who will run the file.
 *
 * A path is judged by its shape, not by where it resolves: `.git/hooks/` counts wherever it
 * appears in the path, because the gate is asked on the host about a file in a box it cannot
 * stat. A symlink, a variable in a shell command, or a program that writes one of these files
 * itself (`git config`, `npm pkg set`, `sed -i`, `crontab -e` in an editor) is not seen. The
 * shell recognition below is the same standing as ui-automation-guard.ts: it makes the boundary
 * real for an agent that is not trying to evade it. It is not a sandbox and is not called one.
 */

import { posix } from "node:path";
import { engineToolNames } from "./engine-tools.ts";

/** Who runs the file afterwards. The words a person reads for each are in src/i18n (`ui.consent.runLaterBy.*`). */
export type RunLaterBy = "git" | "assistant" | "editor" | "shell" | "packages" | "build" | "ci" | "system";

export interface RunLaterEntry {
  /** As written under its root: relative under a home or a project, absolute on the system. */
  path: string;
  /** A directory: everything under it counts. */
  dir?: true;
  by: RunLaterBy;
  /** Refused outright by the OS sandbox on the person's own machine, before any question (host-sandbox.ts). */
  hostDenied?: true;
  /** Judged by what changes in it, never by the path alone: only its fields that run (`PACKAGE_RUN_FIELDS`). */
  byContent?: true;
}

/** Under a home directory: what every shell, login or git command of that person runs or obeys. */
export const RUN_LATER_UNDER_HOME: readonly RunLaterEntry[] = [
  { path: ".bashrc", by: "shell", hostDenied: true },
  { path: ".bash_profile", by: "shell", hostDenied: true },
  { path: ".profile", by: "shell", hostDenied: true },
  { path: ".zshrc", by: "shell", hostDenied: true },
  { path: ".zprofile", by: "shell", hostDenied: true },
  { path: ".zshenv", by: "shell", hostDenied: true },
  { path: ".gitconfig", by: "git", hostDenied: true },
  { path: ".bash_login", by: "shell" },
  { path: ".bash_logout", by: "shell" },
  { path: ".zlogin", by: "shell" },
  { path: ".zlogout", by: "shell" },
  { path: ".config/fish", dir: true, by: "shell" },
  { path: ".config/git/config", by: "git" },
  { path: ".claude.json", by: "assistant" },
  { path: ".config/systemd/user", dir: true, by: "system" },
  { path: ".config/autostart", dir: true, by: "system" },
  { path: "Library/LaunchAgents", dir: true, by: "system" },
];

/** Inside a project: what turns a later command — the person's, a teammate's, a CI run's — into this write's. */
export const RUN_LATER_UNDER_REPO: readonly RunLaterEntry[] = [
  { path: ".git/hooks", dir: true, by: "git", hostDenied: true },
  { path: ".git/config", by: "git", hostDenied: true },
  { path: ".husky", dir: true, by: "git" },
  { path: ".pre-commit-config.yaml", by: "git" },
  { path: ".claude", dir: true, by: "assistant" },
  { path: ".mcp.json", by: "assistant" },
  { path: ".vscode/tasks.json", by: "editor" },
  { path: ".vscode/launch.json", by: "editor" },
  { path: ".envrc", by: "shell" },
  { path: "package.json", by: "packages", byContent: true },
  { path: "Makefile", by: "build" },
  { path: "GNUmakefile", by: "build" },
  { path: ".github/workflows", dir: true, by: "ci" },
  { path: ".gitlab-ci.yml", by: "ci" },
  { path: ".circleci", dir: true, by: "ci" },
  { path: ".buildkite", dir: true, by: "ci" },
  { path: "Jenkinsfile", by: "ci" },
  { path: "azure-pipelines.yml", by: "ci" },
  { path: "bitbucket-pipelines.yml", by: "ci" },
  { path: ".travis.yml", by: "ci" },
];

/** On the system: startup files for every shell, and what cron, systemd and launchd run on their own. */
export const RUN_LATER_SYSTEM: readonly RunLaterEntry[] = [
  { path: "/etc/profile", by: "shell" },
  { path: "/etc/profile.d", dir: true, by: "shell" },
  { path: "/etc/bash.bashrc", by: "shell" },
  { path: "/etc/zshrc", by: "shell" },
  { path: "/etc/zprofile", by: "shell" },
  { path: "/etc/zshenv", by: "shell" },
  { path: "/etc/zsh", dir: true, by: "shell" },
  { path: "/etc/crontab", by: "system" },
  { path: "/etc/cron.d", dir: true, by: "system" },
  { path: "/etc/cron.hourly", dir: true, by: "system" },
  { path: "/etc/cron.daily", dir: true, by: "system" },
  { path: "/etc/cron.weekly", dir: true, by: "system" },
  { path: "/etc/cron.monthly", dir: true, by: "system" },
  { path: "/var/spool/cron", dir: true, by: "system" },
  { path: "/etc/systemd/system", dir: true, by: "system" },
  { path: "/etc/systemd/user", dir: true, by: "system" },
  { path: "/usr/lib/systemd/system", dir: true, by: "system" },
  { path: "/lib/systemd/system", dir: true, by: "system" },
  { path: "/etc/init.d", dir: true, by: "system" },
  { path: "/etc/rc.local", by: "system" },
  { path: "/Library/LaunchAgents", dir: true, by: "system" },
  { path: "/Library/LaunchDaemons", dir: true, by: "system" },
];

/** The fields of a package.json that are run: its scripts, and the git hooks a package manager installs from it. */
export const PACKAGE_RUN_FIELDS = ["scripts", "husky", "simple-git-hooks", "lint-staged", "pre-commit", "gitHooks"] as const;

/** A write the gate found, as the card names it: the file as the call wrote it, and who runs it. */
export interface RunLaterFinding {
  path: string;
  by: RunLaterBy;
}

// Lower-cased: on a Mac `.Git/Hooks` is the same directory, and `makefile` is a Makefile everywhere.
const segmentsOf = (path: string): string[] => path.toLowerCase().split("/").filter(part => part !== "" && part !== ".");
const ANYWHERE = [...RUN_LATER_UNDER_REPO, ...RUN_LATER_UNDER_HOME].map(entry => ({ entry, parts: segmentsOf(entry.path) }));
const ABSOLUTE = RUN_LATER_SYSTEM.map(entry => ({ entry, parts: segmentsOf(entry.path) }));

/** `~/x` and `$HOME/x` name a place under a home whatever the home is; `a/../b` is judged where it lands. */
function cleaned(path: string): string {
  const trimmed = path.trim().replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, "/~");
  return trimmed === "" ? "" : posix.normalize(trimmed);
}

/** The table's entry for a path, or undefined when writing it runs nothing later. */
export function runLaterPath(path: string): RunLaterEntry | undefined {
  const clean = cleaned(path);
  const parts = segmentsOf(clean);
  if (parts.length === 0) return undefined;
  const at = (wanted: readonly string[], start: number) => wanted.every((part, index) => parts[start + index] === part);
  if (clean.startsWith("/")) {
    for (const { entry, parts: wanted } of ABSOLUTE) {
      if (at(wanted, 0) && (entry.dir === true ? parts.length >= wanted.length : parts.length === wanted.length)) return entry;
    }
  }
  for (const { entry, parts: wanted } of ANYWHERE) {
    for (let start = 0; start + wanted.length <= parts.length; start += 1) {
      // A file is the end of the path; a directory is itself or anything below it.
      if (entry.dir !== true && start + wanted.length !== parts.length) continue;
      if (at(wanted, start)) return entry;
    }
  }
  return undefined;
}

/**
 * The same question about a directory git reported whole (`?? .github/`): the entry it is, or the
 * first one that lies inside it. A new directory's contents are not listed, so the directory answers.
 */
export function runLaterUnder(path: string): RunLaterEntry | undefined {
  const direct = runLaterPath(path);
  if (direct !== undefined || !path.endsWith("/")) return direct;
  const parts = segmentsOf(cleaned(path));
  const last = parts.at(-1);
  return ANYWHERE.find(({ parts: wanted }) => wanted.length > 1 && wanted[0] === last)?.entry;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function runFieldsOf(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined || text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return Object.fromEntries(PACKAGE_RUN_FIELDS.filter(field => record[field] !== undefined).map(field => [field, stable(record[field])]));
  } catch {
    return undefined;
  }
}

/**
 * The fields of a package.json that are run and differ between two versions of it; empty when a
 * write changes only what is not run (a version, a dependency, key order).
 *
 * A file that was absent or unreadable as JSON counts as running nothing, so a first write with
 * scripts is a change. A result that is not JSON runs nothing either, and the write that later
 * makes it valid is judged against that — two steps do not get past what one would not.
 */
export function packageRunChanges(before: string | undefined, after: string): string[] {
  const now = runFieldsOf(after);
  if (now === undefined) return [];
  const was = runFieldsOf(before) ?? {};
  return PACKAGE_RUN_FIELDS.filter(field => was[field] !== now[field]);
}

// ── a shell command that writes one ───────────────────────────────────────────────────

interface Word { text: string; redirectTarget?: true }

/**
 * A command line as simple commands of words, with what each `>` writes to marked. Quotes are
 * removed and nothing is expanded: a target that is a variable or a substitution is not known
 * here, and is not guessed.
 */
function simpleCommands(command: string): Word[][] {
  const out: Word[][] = [[]];
  let word = "";
  let started = false;
  let redirect = false;
  const end = () => {
    if (started) out.at(-1)!.push(redirect ? { text: word, redirectTarget: true } : { text: word });
    if (started) redirect = false;
    word = ""; started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "\\" && i + 1 < command.length) { word += command[i + 1]; started = true; i += 1; continue; }
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, i + 1);
      const stop = close < 0 ? command.length : close;
      word += command.slice(i + 1, stop); started = true; i = stop;
      continue;
    }
    if (char === " " || char === "\t") { end(); continue; }
    if (char === ">") {
      // `2>file` and `&>file`: the digit or ampersand is the stream, not a word. `>&2` writes no file.
      if (/^(?:\d+|&)$/.test(word)) { word = ""; started = false; }
      end();
      while (command[i + 1] === ">" || command[i + 1] === "|") i += 1;
      if (command[i + 1] === "&") { i += 1; while (/[\d-]/.test(command[i + 1] ?? "")) i += 1; continue; }
      redirect = true;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
      if (char === "&" && command[i + 1] === ">") { word += char; started = true; continue; }
      end(); redirect = false;
      out.push([]);
      continue;
    }
    word += char; started = true;
  }
  end();
  return out.filter(words => words.length > 0);
}

/** Words that only say how the next command runs, and are not it. */
const PREFIXES = new Set(["sudo", "doas", "env", "command", "nohup", "time", "exec", "builtin", "{", "then", "do", "else", "!"]);
/** Programs whose last operand is where they write, and whose other operands are what lands there. */
const COPIERS = new Set(["cp", "mv", "ln", "install", "rsync"]);

/** What a simple command writes to, as far as its own words say. */
function writeTargets(words: readonly Word[]): string[] {
  const targets = words.filter(word => word.redirectTarget === true).map(word => word.text);
  const plain = words.filter(word => word.redirectTarget !== true).map(word => word.text);
  let first = 0;
  while (first < plain.length && (PREFIXES.has(plain[first]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[first]!) || (first > 0 && plain[first]!.startsWith("-")))) first += 1;
  const name = posix.basename(plain[first] ?? "");
  const args = plain.slice(first + 1);
  const operands = args.filter(arg => !arg.startsWith("-"));
  if (name === "tee") targets.push(...operands);
  if (name === "dd") targets.push(...args.filter(arg => arg.startsWith("of=")).map(arg => arg.slice(3)));
  if (COPIERS.has(name)) {
    const named = args.flatMap((arg, index) => (arg === "-t" || arg === "--target-directory" ? [args[index + 1] ?? ""] : arg.startsWith("--target-directory=") ? [arg.slice("--target-directory=".length)] : []));
    const into = named[0] ?? operands.at(-1);
    const sources = named[0] !== undefined ? operands.filter(operand => operand !== named[0]) : operands.slice(0, -1);
    if (into !== undefined && into !== "") {
      targets.push(into);
      // `cp .bashrc ~/` and `mv ci.yml .github/workflows/`: into a directory, the file lands under its own name.
      if (/(?:^|\/)(?:~|\.{1,2}|\$\{?HOME\}?)?$/.test(into)) for (const source of sources) targets.push(`${into.replace(/\/$/, "")}/${posix.basename(source)}`);
    }
  }
  // Installing a crontab is the write; listing one is not.
  if (name === "crontab" && !args.includes("-l")) targets.push("/var/spool/cron/crontabs");
  return targets;
}

/**
 * The first file a shell command plainly writes that is run later: a redirection, `tee`, `cp`,
 * `mv`, `ln`, `install`, `rsync`, `dd of=`, or a crontab being installed. Best effort, as the
 * header says. A package.json is left to the file tools, which can compare what it held before:
 * a shell write to it cannot be judged without running it.
 */
export function runLaterShellWrite(command: string): RunLaterFinding | undefined {
  for (const words of simpleCommands(command)) {
    for (const target of writeTargets(words)) {
      const entry = runLaterPath(target);
      if (entry !== undefined && entry.byContent !== true) return { path: target, by: entry.by };
    }
  }
  return undefined;
}

/**
 * What a tool call writes that is run later, from the call alone: a file tool by its path, a
 * shell command by what it plainly writes, a delegated engine's own Write or Edit by the path
 * it names. A package.json is not answered here — dispatch compares its contents (run-later-gate.ts).
 */
export function runLaterOf(tool: string, input: Record<string, unknown>): RunLaterFinding | undefined {
  const ours = tool.startsWith("engine:") ? engineToolNames(tool.slice("engine:".length)) ?? [] : [tool];
  if (ours.includes("bash") || tool === "RunOnHost") return runLaterShellWrite(typeof input.command === "string" ? input.command : "");
  if (!ours.includes("write_file") && !ours.includes("edit_file")) return undefined;
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
  const entry = runLaterPath(path);
  return entry !== undefined && entry.byContent !== true ? { path, by: entry.by } : undefined;
}
