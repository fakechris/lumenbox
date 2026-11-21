/**
 * Which code this is: the package version and the git commit, read once.
 *
 * Shown on the web page since 0.29, and from R24 stamped into the turn ledger — so "did this
 * regression start with the model swap or with the deploy" can be answered from our own records
 * rather than from somebody's memory of what was running that evening. Cached because a turn
 * begins hundreds of times a day and `git rev-parse` is not free; the answer cannot change while
 * the process lives.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string;
  commit: string;
}

let cached: BuildInfo | undefined;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const UNKNOWN_VERSION = "0.0.0";

function findPackage(start: string): { dir: string; version: string; buildCommit?: string } | undefined {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg?.name === "agentbox" && typeof pkg.version === "string" && pkg.version !== "") {
        const buildCommit = typeof pkg.buildCommit === "string" && /^[a-f0-9]{7,40}$/i.test(pkg.buildCommit)
          ? pkg.buildCommit : undefined;
        return { dir, version: pkg.version, buildCommit };
      }
    } catch {
      // The package may be beside the bundle or above an unbundled source file.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function packageVersion(): string {
  return findPackage(moduleDir)?.version ?? UNKNOWN_VERSION;
}

export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo(moduleDir);
  return cached;
}

/**
 * The resolution, apart from the cache, so the packaged-stamp path is testable.
 *
 * Order says where each source can exist: `AGENTBOX_BUILD` is a developer pinning it for
 * one run; `buildCommit` is what the desktop and Docker builds stamp into package.json.
 * A shipped artifact has no .git directory, so only source checkouts can fall back to git.
 */
export function readBuildInfo(
  start: string,
  env: { AGENTBOX_BUILD?: string } = process.env
): BuildInfo {
  const pkg = findPackage(start);
  let commit = env.AGENTBOX_BUILD ?? "";
  if (commit === "") commit = pkg?.buildCommit ?? "";
  if (commit === "") {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: pkg?.dir ?? start,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      commit = "unknown";
    }
  }
  return { version: pkg?.version ?? UNKNOWN_VERSION, commit };
}
