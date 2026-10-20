/**
 * The working-tree check (INV-1258): read-only, one command, and every way it can answer —
 * a clean repo, a dirty one with and without an upstream, no repo, no directory, a timeout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWorktree, parseWorktree, worktreeCommand, worktreeDirty, worktreeState } from "./worktree-state.ts";

test("the command is read-only and the parser reads each shape git answers in", () => {
  const command = worktreeCommand("/home/box/work/repo");
  assert.match(command, /git status --porcelain=v1 --untracked-files=normal/);
  assert.match(command, /git rev-list --count '@\{u\}\.\.HEAD'/);
  for (const forbidden of ["stash", "commit", "push", "checkout", "reset", "clean"]) assert.doesNotMatch(command, new RegExp(`git ${forbidden}`));

  assert.deepEqual(parseWorktree("__STATUS__\n__UNPUSHED__\n0\n"), { kind: "repo", modified: 0, untracked: 0, unpushed: 0 });
  assert.deepEqual(parseWorktree("__STATUS__\n M src/a.ts\nM  src/b.ts\n?? notes.txt\n__UNPUSHED__\n2\n"), { kind: "repo", modified: 2, untracked: 1, unpushed: 2 });
  assert.deepEqual(parseWorktree("__STATUS__\n M src/a.ts\n__UNPUSHED__\nnone\n"), { kind: "repo", modified: 1, untracked: 0 }, "no upstream: no unpushed count, not a failure");
  assert.deepEqual(parseWorktree("__NOT_A_REPO__\n"), { kind: "not-a-repo" });
  assert.equal(parseWorktree("__NOT_A_DIR__\n").kind, "unknown");
  assert.equal(parseWorktree("fatal: something else").kind, "unknown");
});

test("the words a note or a verdict gets, and what counts as dirty", () => {
  assert.equal(describeWorktree({ kind: "repo", modified: 3, untracked: 1, unpushed: 2 }), "3 modified, 1 untracked, 2 unpushed");
  assert.equal(describeWorktree({ kind: "repo", modified: 0, untracked: 0, unpushed: 0 }), "clean");
  assert.equal(describeWorktree({ kind: "repo", modified: 0, untracked: 0 }), "clean (no upstream to compare with)");
  assert.equal(describeWorktree({ kind: "not-a-repo" }), "not a git repo");
  assert.equal(describeWorktree({ kind: "unknown", why: "git did not answer within 10s" }), "unknown (git did not answer within 10s)");
  assert.equal(worktreeDirty({ kind: "repo", modified: 1, untracked: 0 }), true);
  assert.equal(worktreeDirty({ kind: "repo", modified: 0, untracked: 5, unpushed: 9 }), false, "untracked and unpushed are said, not refused");
  assert.equal(worktreeDirty({ kind: "unknown", why: "x" }), false);
});

test("asking the box: a timeout or a thrown error is unknown with the reason, never a throw", async () => {
  const timedOut = await worktreeState({ exec: async () => ({ stdout: "", stderr: "", exit_code: 0, timed_out: true }) } as never, "/r", 10_000);
  assert.deepEqual(timedOut, { kind: "unknown", why: "git did not answer within 10s" });
  const unreachable = await worktreeState({ exec: async () => { throw new Error("box unreachable"); } } as never, "/r");
  assert.deepEqual(unreachable, { kind: "unknown", why: "box unreachable" });
  const seen: string[] = [];
  const clean = await worktreeState({ exec: async (command: string) => { seen.push(command); return { stdout: "__STATUS__\n__UNPUSHED__\n0\n", stderr: "", exit_code: 0, timed_out: false }; } } as never, "/home/box/work/repo");
  assert.deepEqual(clean, { kind: "repo", modified: 0, untracked: 0, unpushed: 0 });
  assert.match(seen[0]!, /cd '\/home\/box\/work\/repo'/);
});
