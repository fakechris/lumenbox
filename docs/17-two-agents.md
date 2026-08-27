# Two agents on one repository

Written because there are already two, and the conflict is not hypothetical: on
2026-08-26 a branch in a second worktree and the work on `main` had touched **six of the
same files**, including one that had been edited a dozen times that day.

The trial merge came out clean — 0 conflicts, `tsc` clean, 788 tests passing. That result
is the reason for the rule below rather than an argument against it.

---

## Where the work happens

| | path | branch | who |
|---|---|---|---|
| main checkout | `agentbox/` | `main` | whoever is holding `main` |
| a feature | `agentbox-<topic>/` | `feat/<topic>` | one agent |

`git worktree list` is the answer to "who is where". It is worth running before starting,
because the failure this document exists for begins with two agents believing they are
alone.

**One agent per worktree, and the worktree owns its branch.** Two agents editing one
checkout is not a merge problem, it is a *sequencing* problem — one writes a file the
other is in the middle of reading, and neither git nor the test suite has anything to say
about it.

---

## The running system belongs to `main`

Only one `agentbox web` and one box, and they run from the **main checkout on `main`**.
A worktree that starts its own hits the port, the box's display leases and — worst — the
same `~/.agentbox` state directory, which is where the transcripts and ledgers live.

So an agent in a feature worktree:

- runs `npm test` and `tsc`, freely;
- does **not** run `agentbox web`, `box up`, or anything that writes to `~/.agentbox`;
- when it needs the running system, says so and asks, rather than starting a second one.

Checking which checkout is serving is one command:

```sh
lsof -p "$(pgrep -f 'cli.ts web' | head -1)" -a -d cwd -Fn | sed -n 's/^n//p'
```

---

## Merging a worktree branch

The order matters, and each step exists because of a failure it prevents.

**1. Rebase or merge `main` in, on your own branch, first.**
Conflicts are resolved by the person who understands the change, in their own worktree,
where a mistake costs nothing.

**2. Run the suite where the merge actually happened.** Not on your branch before the
merge — a clean textual merge of two correct changes is routinely broken. That is not a
hypothetical: this repository shipped a chevron that rendered as the literal text `\25b8`
because a template literal halves backslashes, and *both versions of that line compiled,
merged, and passed every test that existed.*

**3. Trial-merge into a scratch worktree before opening the PR**, when both branches have
touched the same files:

```sh
S=$(mktemp -d)/trial
git worktree add --detach "$S" main
cd "$S" && ln -sfn /path/to/agentbox/node_modules node_modules
git merge --no-commit --no-ff feat/<topic>
npx tsc --noEmit && npm test
git worktree remove --force "$S"
```

The `--no-commit` is the point: it answers "would this work" without deciding anything.

**4. One PR per branch, merged through GitHub**, which is this repository's existing
convention — `gh pr create`, then `gh pr merge --merge --delete-branch`.

**5. Whoever holds `main` pulls immediately after**, and says so, because the other agent's
next rebase is against whatever `main` now is.

---

## What "no conflicts" does not mean

The trial above merged cleanly and passed. It could equally have merged cleanly and been
broken, and git would have reported exactly the same thing. Three shapes, all seen in this
repository within one day:

- **Two edits to one function that are individually right.** `sendToChat` and
  `postTaskCard` learned a new key format while `sendFile` and `sendImage` did not — one
  commit, no conflict, files silently stopped being delivered.
- **A test that still passes and no longer means anything.** A grader whose whole pass
  condition was a model's opinion survived every merge and would pass on
  `"I did all of it, honestly."`
- **Two correct halves of an interface, moved apart.** The spill threshold was set against
  the display cap while the durable cap was somewhere else entirely; both numbers were
  defensible and the gap between them lost data.

So the check that matters is not `git status`. It is: **does the merged tree build, pass,
and — for anything a person looks at — actually render?** The third is the one this
repository keeps failing, which is why UI changes are verified against the running page
before they are committed, not after.

---

## When both agents must touch one file

Sometimes unavoidable — `app-html.ts`, `server.ts` and `feishu.ts` are all single files
that many features reach into.

- **Say so first.** A one-line message costs nothing next to an afternoon of rebasing.
- **Prefer a new file over a new section.** `absences.ts`, `liveness.ts`, `named-files.ts`
  and `env-shape.ts` were all extracted rather than added inline, and none of them
  collided with anything.
- **The shared file is the last thing you touch**, so the window between your edit and
  your merge is short.
