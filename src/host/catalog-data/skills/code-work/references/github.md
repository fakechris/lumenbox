# GitHub from the box with `gh`

All of these run through `bash`. `OWNER/REPO` can be dropped when the current directory is
a checkout of that repository.

## Is it set up?

```sh
command -v gh || echo "gh not installed"
gh auth status            # which account, which scopes; non-zero exit means not logged in
```

Not logged in: stop and follow section 6 of SKILL.md. Do not guess at a token.

## Reading without a checkout

```sh
gh repo view OWNER/REPO
gh pr view 123 -R OWNER/REPO --json title,state,headRefName,headRefOid,mergeable,url
gh pr diff 123 -R OWNER/REPO
gh issue view 45 -R OWNER/REPO --comments
gh api repos/OWNER/REPO/contents/path/to/file --jq .content | base64 -d
gh api repos/OWNER/REPO/commits?per_page=10 --jq '.[].sha'
gh search prs --repo OWNER/REPO "text"   # or: gh search issues / gh search code
```

Prefer one search over many list calls, and `--json` with `--jq` over parsing tables.

## Working copy

```sh
cd /home/box/work
gh repo clone OWNER/REPO   # or git fetch in the existing clone
cd REPO && git switch -c <branch>
```

## Pull requests

```sh
git push -u origin <branch>
gh pr create --title "..." --body "..."     # add --draft when it is not ready
gh pr ready 123                              # draft -> ready
gh pr comment 123 --body "..."
gh pr review 123 --comment --body "..."      # --approve / --request-changes only when asked
gh pr merge 123 --squash                     # only when asked; pick the repo's usual method
```

Before a merge: `gh pr view 123 --json mergeable,mergeStateStatus` and `gh pr checks 123`.

## CI

```sh
gh pr checks 123                              # one line per check
gh run list -R OWNER/REPO --branch <branch> -L 5
gh run view <run-id> --log-failed             # only the failing steps
gh run watch <run-id> --exit-status           # long: run with bash background, follow with Jobs
gh run rerun <run-id> --failed                # only when the person wants a retry
```

## Refusals and what they usually mean

| What you see | Likely cause | What the person needs to do |
|---|---|---|
| `gh auth status` exits non-zero | not logged in | log `gh` in inside this box |
| HTTP 404 on a repo you were told exists | account cannot see it | grant that account access |
| HTTP 403 on push or write | read-only access or branch protection | grant write, or say which branch to use |
| `Resource not accessible by integration` | token lacks a scope | log in again with the needed scope |

Report the exact error line with the command that produced it.
