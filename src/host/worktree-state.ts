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
 *
 * It also names the changed files that are run later (INV-1861, run-later-paths.ts): a delegated
 * engine edits with its own tools, which the policy gate never sees, so its work is checked here,
 * when the result is recorded. Read from the same status, so it covers what is still loose in the
 * tree — not what the engine already committed, and not `.git/` itself, which git does not list.
 */
import type { BoxClient } from "../box/client.ts";
import { quoteForShell } from "./presets.ts";
import { packageRunChanges, runLaterUnder } from "./run-later-paths.ts";

export type WorktreeState =
  | { kind: "repo"; modified: number; untracked: number; unpushed?: number; /** Changed files that are run later, as git names them. */ runLater?: string[] }
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

/** The paths a status names, as git wrote them: the new name of a rename, and a directory git reported whole keeps its slash. */
export function changedPaths(stdout: string): string[] {
  const statusAt = stdout.indexOf("__STATUS__");
  const unpushedAt = stdout.indexOf("__UNPUSHED__");
  if (statusAt < 0 || unpushedAt < 0) return [];
  return stdout.slice(statusAt + "__STATUS__".length, unpushedAt).split("\n").filter(line => line.length > 3)
    .map(line => line.slice(3).split(" -> ").at(-1)!.replace(/^"(.*)"$/, "$1"));
}

/** How many changed package.json files have their contents compared: each is one more question to the box. */
const PACKAGE_CHECKS = 5;

/**
 * Which of the changed files are run later. A path decides for all but a package.json, which is
 * compared with what the last commit held — only a change to its scripts counts (`packageRunChanges`).
 */
async function runLaterChanges(box: Pick<BoxClient, "exec">, cwd: string, paths: readonly string[], timeoutMs: number): Promise<string[]> {
  const out: string[] = [];
  let compared = 0;
  for (const path of paths) {
    const entry = runLaterUnder(path);
    if (entry === undefined) continue;
    if (entry.byContent !== true) { out.push(path); continue; }
    if (compared >= PACKAGE_CHECKS) continue;
    compared += 1;
    const quoted = quoteForShell(path);
    const read = await box.exec(`cd ${quoteForShell(cwd)} && { git show HEAD:./${quoted} 2>/dev/null; echo; echo "__AFTER__"; cat -- ${quoted}; }`, { timeoutMs });
    const at = read.stdout.indexOf("__AFTER__");
    if (at >= 0 && packageRunChanges(read.stdout.slice(0, at), read.stdout.slice(at + "__AFTER__".length)).length > 0) out.push(path);
  }
  return out;
}

/** Asks the box; never throws — a failure to ask is an `unknown` with the reason. */
export async function worktreeState(box: Pick<BoxClient, "exec">, cwd: string, timeoutMs = WORKTREE_TIMEOUT_MS): Promise<WorktreeState> {
  try {
    const result = await box.exec(worktreeCommand(cwd), { timeoutMs });
    if (result.timed_out) return { kind: "unknown", why: `git did not answer within ${Math.round(timeoutMs / 1000)}s` };
    const state = parseWorktree(result.stdout);
    if (state.kind !== "repo") return state;
    const runLater = await runLaterChanges(box, cwd, changedPaths(result.stdout), timeoutMs);
    return runLater.length > 0 ? { ...state, runLater } : state;
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
    ...(state.runLater !== undefined ? [`changed files that are run later: ${state.runLater.join(", ")}`] : []),
  ];
  if (parts.length === 0) return state.unpushed === undefined ? "clean (no upstream to compare with)" : "clean";
  return parts.join(", ");
}

/** Tracked changes not committed: what a repo-clean check refuses over. Untracked and unpushed are reported, not refused. */
export function worktreeDirty(state: WorktreeState): boolean {
  return state.kind === "repo" && state.modified > 0;
}
