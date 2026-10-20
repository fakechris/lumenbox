/**
 * Did the code land in the repository? One read-only question to git, answered in the box
 * (INV-1258, after Cyrus's Stop hook): tracked files changed and not committed, files not
 * tracked at all, commits not pushed to the upstream. A cheap, certain signal that needs no
 * model — the engine saying "done" with its edits still loose in the working tree is exactly
 * the thing a report alone cannot see.
 *
 * Read-only by construction: `git status` and `git rev-list` only; never stash, commit or
 * push. A directory that is not a repository is said to be one; a repository with no upstream
 * reports changes but no unpushed count; a check that does not answer in time is `unknown`
 * rather than a stuck settlement.
 */
import type { BoxClient } from "../box/client.ts";
import { quoteForShell } from "./presets.ts";

export type WorktreeState =
  | { kind: "repo"; modified: number; untracked: number; unpushed?: number }
  | { kind: "not-a-repo" }
  | { kind: "unknown"; why: string };

export const WORKTREE_TIMEOUT_MS = 10_000;

/** One command, three answers separated by markers; the markers survive an empty status. */
export function worktreeCommand(cwd: string): string {
  return (
    `cd ${quoteForShell(cwd)} 2>/dev/null || { echo "__NOT_A_DIR__"; exit 0; }; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "__NOT_A_REPO__"; exit 0; }; ` +
    `echo "__STATUS__"; git status --porcelain=v1 --untracked-files=normal 2>/dev/null; ` +
    `echo "__UNPUSHED__"; git rev-list --count '@{u}..HEAD' 2>/dev/null || echo "none"`
  );
}

export function parseWorktree(stdout: string): WorktreeState {
  if (stdout.includes("__NOT_A_DIR__")) return { kind: "unknown", why: "the directory does not exist" };
  if (stdout.includes("__NOT_A_REPO__")) return { kind: "not-a-repo" };
  const statusAt = stdout.indexOf("__STATUS__");
  const unpushedAt = stdout.indexOf("__UNPUSHED__");
  if (statusAt < 0 || unpushedAt < 0) return { kind: "unknown", why: "git answered in a shape this does not read" };
  const lines = stdout.slice(statusAt + "__STATUS__".length, unpushedAt).split("\n").filter(line => line.trim() !== "");
  const untracked = lines.filter(line => line.startsWith("??")).length;
  const modified = lines.length - untracked;
  const tail = stdout.slice(unpushedAt + "__UNPUSHED__".length).trim();
  const unpushed = /^\d+$/.test(tail) ? Number(tail) : undefined;
  return { kind: "repo", modified, untracked, ...(unpushed !== undefined ? { unpushed } : {}) };
}

/** Asks the box; never throws — a failure to ask is an `unknown` with the reason. */
export async function worktreeState(box: Pick<BoxClient, "exec">, cwd: string, timeoutMs = WORKTREE_TIMEOUT_MS): Promise<WorktreeState> {
  try {
    const result = await box.exec(worktreeCommand(cwd), { timeoutMs });
    if (result.timed_out) return { kind: "unknown", why: `git did not answer within ${Math.round(timeoutMs / 1000)}s` };
    return parseWorktree(result.stdout);
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.message : String(error) };
  }
}

/** The state in a few words, for a note or a verdict. */
export function describeWorktree(state: WorktreeState): string {
  if (state.kind === "not-a-repo") return "not a git repo";
  if (state.kind === "unknown") return `unknown (${state.why})`;
  const parts = [
    ...(state.modified > 0 ? [`${state.modified} modified`] : []),
    ...(state.untracked > 0 ? [`${state.untracked} untracked`] : []),
    ...(state.unpushed !== undefined && state.unpushed > 0 ? [`${state.unpushed} unpushed`] : []),
  ];
  if (parts.length === 0) return state.unpushed === undefined ? "clean (no upstream to compare with)" : "clean";
  return parts.join(", ");
}

/** Tracked changes not committed: what a repo-clean check refuses over. Untracked and unpushed are reported, not refused. */
export function worktreeDirty(state: WorktreeState): boolean {
  return state.kind === "repo" && state.modified > 0;
}
