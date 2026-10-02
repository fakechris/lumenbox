---
name: code-work
description: Use when someone asks for coding work in a repository (build, fix, refactor, find out how code behaves), or to read or act on GitHub repos, pull requests, issues or CI runs.
description_zh: "仓库里的编码工作，以及 GitHub 仓库、PR、issue、CI 的读取与操作"
description_en: "Coding work in a repository, and reading or acting on GitHub repos, PRs, issues and CI"
version: 1.0.0
provenance: "Written for LumenBox from a study of Grok Bot 0.63's managed skills (2026-10-02). Facts restated; no text copied."
---

# Code work

Your box is a real workstation: `git`, `node`, `python3` and passwordless `sudo` are there.
Repository work happens in it, under `/home/box/work`, which is the directory that survives a
rebuild. Other skills own narrower jobs: **code-review** writes a review without changing code,
**diagnose** is the loop for a hard bug, **fullstack-dev** covers app architecture, and
**engine-check** installs and tests a coding engine. Open those when the request is theirs.

## 1. Small question or real work?

- **A lookup** ("what does this PR change?", "is CI green?", "what is in that config?"):
  answer it with `gh` from `bash`. No checkout needed. Commands are in `references/github.md`.
- **A change or an investigation**: clone into `/home/box/work/<repo>` (or reuse the clone
  that is already there; `git fetch` first) and work on a branch.

## 2. Do it yourself, or hand it to an engine

Do it yourself when the change is a few files you can hold in mind: `read_file`, `edit_file`,
`write_file` and `bash` are enough.

Use `Delegate` when the job is reading a lot of the repository and iterating against its
tests. The engines are `opencode`, `claude` and `pi` (pi cannot call MCP tools). If the
engine is not installed, ask the person before calling `Delegate` with `install: true`; it
takes minutes and runs as a job. Its cost is billed to whoever asked.

Writing the brief:
- The engine cannot ask you anything. Put everything in the prompt: the goal, how to
  reproduce the problem, constraints (branch name, files not to touch), and what finished
  looks like, ideally a test command that must exit 0.
- Describe the problem, not your fix. If you have a guess about the cause, label it as a
  guess the engine may reject.
- Set `cwd` to the checkout. A later `Delegate` with the same directory and model resumes the same
  engine thread, so send follow-ups there rather than starting fresh on the same work.

`Delegate` returns a job id. Use `Jobs` (`wait`, or `wait` with `until`) to follow it and
read its output file when the tail is not enough. Then check its work yourself: read the
diff and rerun the tests. An engine saying "done" is a claim, not evidence.

For several independent investigations at once, `Fork` with `background: true` keeps your
own context small and your replies quick.

## 3. Branches, commits, pull requests

- One branch per piece of work, named for it. Do not commit to the default branch unless the
  person asked for exactly that.
- Read the repository's own rules first (`AGENTS.md`, `CONTRIBUTING.md`, the CI workflow)
  and follow its commit and branch conventions over these defaults.
- Run the project's tests and linters before committing. Commit messages say why.
- Push the branch and open the PR with `gh pr create`. Merging is a separate decision: only
  when asked, and only after the checks on the head commit pass.
- Comments, reviews and issue edits on GitHub are normal work when requested. Say what you
  posted and where.

## 4. CI

Read checks on the PR, then the log of the failing job, not the whole run. A long wait goes
in a background `bash` command, followed with `Jobs`; do not loop on polls. When a check
fails, say which job, the first real error line, and whether your change caused it.

## 5. What to report

Every result names things the person can open or rerun:
- the PR URL (or branch name if no PR), and the commit SHA;
- each verification command with its exit code, e.g. `npm test` exited 0;
- what you did not verify, and why.

Save results as they land with `Checkpoint`, so a cut-off turn still leaves them. If the
conversation has a `Goal`, its `claim_complete` takes these same pointers as evidence. If
the work is a task on `Tasks` with a reviewer, your finish is `review`, not `done`.

## 6. When access is refused

If `gh` is missing, install it (you have `sudo`). If it says you are not logged in, a push
gets a 403, or a repository comes back as not found, **stop and tell the person what is
needed**:
- which repository and which action was refused, with the exact error line;
- what would unblock it: a `gh auth login` in this box (run `gh auth login --web`; it prints
  a one-time code the person enters on GitHub), or access for that account to that repo.

A `gh` login is stored under `~/.config` and survives a rebuild; it is also copied into
every backup archive, so tell the person that when they log in. A token saved with
`AskSecret` reaches only `RunOnHost` commands that name it, not your box shell.

Never route around a refusal: no tokens pasted into chat, no searching files for
credentials, no other account, no pushing to a fork or new remote the person did not
choose, no `--no-verify` or disabled hooks. Finish the parts that do not need the access,
and say which parts wait.
