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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string;
  commit: string;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached !== undefined) return cached;
  cached = readBuildInfo(fileURLToPath(new URL("../..", import.meta.url)), process.env);
  return cached;
}

/**
 * The resolution, apart from the cache, so the packaged-stamp path is testable.
 *
 * Order says where each source can exist: `AGENTBOX_BUILD` is a developer pinning it for
 * one run; `buildCommit` is what scripts/dist.mjs stamped into the packaged package.json,
 * and on a user's machine it is the only source that can answer — /Applications sits
 * nowhere near a .git directory, so the rev-parse below is the "unknown" that 0.3.1
 * shipped with (INV-876).
 */
export function readBuildInfo(
  root: string,
  env: { AGENTBOX_BUILD?: string } = process.env
): BuildInfo {
  let version = "0.0.0";
  let packagedCommit = "";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
      buildCommit?: unknown;
    };
    if (typeof pkg.version === "string") version = pkg.version;
    if (typeof pkg.buildCommit === "string") packagedCommit = pkg.buildCommit;
  } catch {
    // The page shows 0.0.0, which reads as "could not tell" and is exactly true.
  }
  let commit = env.AGENTBOX_BUILD ?? "";
  if (commit === "") commit = packagedCommit;
  if (commit === "") {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      commit = "unknown";
    }
  }
  return { version, commit };
}
