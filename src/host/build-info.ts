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
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // The page shows 0.0.0, which reads as "could not tell" and is exactly true.
  }
  let commit = process.env.AGENTBOX_BUILD ?? "";
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
  cached = { version, commit };
  return cached;
}
