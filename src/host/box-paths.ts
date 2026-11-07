/**
 * Where a delegated engine's files go in an agent's box (INV-1712): one function that knows the
 * box's kind, so no preset and no tool asks "is this a host box?" on its own.
 *
 * A Docker box (and an attached one, which is the same image somewhere else) has the image's
 * layout: the work volume at `/home/box/work`, and each engine's home under `/home/box`, which is
 * the box user's and nobody else's. These paths are exactly what they were before this file.
 *
 * A host box (INV-438) is the person's own machine. Its `~` is the person's, holding their own
 * engine logins, and the OS sandbox refuses writes there (INV-1700) — so nothing is put in it.
 * The work directory is the box's, and each agent's engine homes are in its state directory
 * `<work>/.state/<agent>` (INV-1710), which the box points the engines at through the environment
 * (`STATE_VARIABLES`, set by the box on every confined start). The table below is that layout's
 * one definition: boxd builds the environment from it, and this file builds the paths from it.
 */

import { posix } from "node:path";

/** The image's home and work volume (docker/box). */
export const DOCKER_HOME = "/home/box";
export const DOCKER_WORK = "/home/box/work";

/** Where an agent's tools and engines keep their state, relative to its state directory; variable → subdirectory. */
export const STATE_VARIABLES = {
  XDG_CACHE_HOME: "cache",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  npm_config_cache: "npm",
  CLAUDE_CONFIG_DIR: "claude",
  CODEX_HOME: "codex",
  // pi's agent directory (models.json, skills); measured on 0.85.1, config.js getAgentDir().
  PI_CODING_AGENT_DIR: "pi",
} as const;

/** The state directory's name for who asked: `agent:a1` → `a1`; nobody named → `unlabelled`. */
export function stateName(actor: string | undefined): string {
  const name = (actor ?? "").replace(/^agent:/, "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 64);
  return name === "" ? "unlabelled" : name;
}

export interface BoxPaths {
  /** The box's work directory: survives a rebuild, and the default place an engine works in. */
  work: string;
  /** The box's skills directory, projected into each engine's own skills place. */
  skills: string;
  /** Where an engine installed on demand lives, and its `bin`. */
  engines: string;
  enginesBin: string;
  /**
   * The pinned engine's absolute path where only the pinned install may run, or undefined where
   * PATH decides. A Docker box resolves through PATH, the image's layer first, the install after.
   * On a host box the PATH ahead of the install is the person's own (Homebrew, `~/.local/bin`),
   * so an engine is run by this path and never looked up (INV-1720).
   */
  pinnedEngine: ((program: string) => string) | undefined;
  /** Where the MCP face config files are written (docs/33). */
  mcpFaces: string;
  /** Where an engine without an MCP client leaves its report (INV-1261). */
  reports: string;
  /**
   * The directory engines resolve as `~` when they read no variable for their home, or undefined
   * where it is not the box's to write (a host box: it is the person's).
   */
  home: string | undefined;
  /** Each engine's own home: its config, its skills place. */
  homes: { opencode: string; claude: string; pi: string; mcode: string };
  /**
   * Whether the skills links are made before every run rather than once at install: on a host box
   * the engine homes are per agent, and the install is not any one agent's.
   */
  skillsAtRun: boolean;
  /** A path as the box's shell writes it: the image's own engine homes as `~/.x`, as they always were. */
  shell(path: string): string;
}

/** The image's layout: a Docker box's paths, and an attached box's (the same image elsewhere). */
export const DOCKER_BOX_PATHS: BoxPaths = {
  ...lumenboxDirs(DOCKER_WORK),
  pinnedEngine: undefined,
  home: DOCKER_HOME,
  homes: {
    opencode: `${DOCKER_HOME}/.config/opencode`,
    claude: `${DOCKER_HOME}/.claude`,
    pi: `${DOCKER_HOME}/.pi/agent`,
    mcode: `${DOCKER_HOME}/.agents`,
  },
  skillsAtRun: false,
  shell: path => (path.startsWith(`${DOCKER_HOME}/.`) ? `~${path.slice(DOCKER_HOME.length)}` : path),
};

/** A host work directory is spliced into shell lines unquoted, so it must not need quoting. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/@+-]*$/;

/** The paths for this agent on this box, or what to do when a host box's work directory cannot be used. */
export function boxPaths(box: { kind: "docker" | "attached" | "host"; workDir?: string }, agentId: string): BoxPaths | { error: string } {
  if (box.kind !== "host") return DOCKER_BOX_PATHS;
  const work = hostWork(box.workDir);
  if (work === undefined) {
    return {
      error:
        `This host box's work directory (${box.workDir ?? "not recorded"}) cannot hold an engine's files: it must be an absolute path of letters, digits and . _ - / @ +. ` +
        "Start the box again with agentbox host up --work <such a directory>.",
    };
  }
  const state = posix.join(work, ".state", stateName(`agent:${agentId}`));
  const dirs = lumenboxDirs(work);
  return {
    ...dirs,
    pinnedEngine: program => `${dirs.enginesBin}/${program}`,
    home: undefined,
    homes: {
      opencode: posix.join(state, STATE_VARIABLES.XDG_CONFIG_HOME, "opencode"),
      claude: posix.join(state, STATE_VARIABLES.CLAUDE_CONFIG_DIR),
      pi: posix.join(state, STATE_VARIABLES.PI_CODING_AGENT_DIR),
      // mcode reads ~/.agents and has no variable for it, so on a host box this holds only its note.
      mcode: posix.join(state, "agents"),
    },
    skillsAtRun: true,
    shell: path => path,
  };
}

/** A host box's work directory as its paths are built from it, or undefined when it cannot be used. */
function hostWork(workDir: string | undefined): string | undefined {
  const work = workDir === undefined || workDir === "" ? undefined : posix.normalize(workDir).replace(/\/+$/, "");
  return work !== undefined && PLAIN_PATH.test(work) ? work : undefined;
}

/**
 * The box's skills directory (INV-1719): where skills are seeded, indexed, written and read, on
 * every box, whoever asks — the same directory `boxPaths(...).skills` projects into the engines.
 * Not per agent: a box's skills are its own and every agent's on it. A Docker or attached box,
 * or no box named, has the image's `/home/box/work/skills`, as it always had. A host box whose
 * work directory cannot be used keeps that too: the box refuses it with a sentence, where an
 * invented path would be silently empty.
 */
export function skillsDir(box: { kind?: "docker" | "attached" | "host" | undefined; workDir?: string | undefined } | undefined): string {
  const work = box?.kind === "host" ? hostWork(box.workDir) : undefined;
  return work === undefined ? DOCKER_BOX_PATHS.skills : lumenboxDirs(work).skills;
}

function lumenboxDirs(work: string): Pick<BoxPaths, "work" | "skills" | "engines" | "enginesBin" | "mcpFaces" | "reports"> {
  return {
    work,
    skills: `${work}/skills`,
    engines: `${work}/.lumenbox/engines`,
    enginesBin: `${work}/.lumenbox/engines/bin`,
    mcpFaces: `${work}/.lumenbox/mcp`,
    reports: `${work}/.lumenbox/reports`,
  };
}

