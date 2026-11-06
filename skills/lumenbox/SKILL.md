---
name: lumenbox
description: "Use when the user asks to hand work to LumenBox or its agents (\"let the research team look into X\", \"have LumenBox do this and tell me\"), or when a job needs a computer of its own, outlives this session, needs a team, or should leave a record: assign it through the lumenbox MCP tools, follow it with task_status or watch, and collect the result with fetch_deliverable."
---

# LumenBox

LumenBox is the user's own team of AI agents, each with a persistent Linux box (desktop,
browser, files that stay). This skill drives it from here through its MCP side door: the
`lumenbox` server, which is `agentbox mcp` talking to the user's running `agentbox web`.
Everything you do through it is done as the person whose token configured the server, and is
on the task board where they can see it.

## When to hand work to LumenBox, and when not

Hand it over when the work:

- **takes long** — minutes to hours; you get a task id now and ask later;
- **needs a real machine** — a desktop, a logged-in browser, installed tools that stay installed;
- **needs a team** — the user's agents have roles; one of them may already know the subject;
- **should leave a record** — the board keeps who did what, and the files it handed over.

Do it yourself when it is quick, local to this repository, or needs what only this session has.
Do not move work to LumenBox just to look busy, and never send it secrets the user did not ask
you to send.

## Install

1. `agentbox skill install` (Claude Code) or `agentbox skill install --codex` copies this file
   and prints the MCP entry to add. The entry has a placeholder where the token goes.
2. The user issues a token in the LumenBox app: **Settings → Mine → Your MCP tokens → Issue**.
   It is shown once. They paste it in place of the placeholder; you never need to see it, and
   you must never print, echo or commit it.
3. `agentbox web` must be running (default `http://127.0.0.1:7777`; another address goes in
   `AGENTBOX_MCP_URL`). Restart the client so it loads the server and the skill.

## The tools

Tool names below are as the server lists them; your client may prefix them (for example
`mcp__lumenbox__assign_task`).

### `assign_task`

- **The user says:** "Have the research team look into X and tell me when it's done."
- **Call:** `assign_task({ brief, agent? })`. `brief` is the whole request, self-contained:
  the agent cannot see this conversation. `agent` is a name from `list_agents`; omit it for the
  coordinator, who routes to the team. Pass `idempotency_key` (any unique string, the same on
  a retry) so a retried call does not create a second task.
- **Returns:** `t42 — Ada is on it. Ask task_status about t42.` and `status: in_progress`.
- **Then:** tell the user the task id and that it is running. Do not sit in a loop; check back
  with `task_status` or `watch`.

### `task_status`

- **The user says:** "How is the LumenBox task going?" / "What do I have open there?"
- **Call:** `task_status({ task_id })`; with no id, the user's open tasks (`scope: "all"` for
  every open task).
- **Returns:** first line `status: in_progress | completed | failed | incomplete | cancelled`,
  with the reason in brackets, then the task line and its history. `structuredContent.tasks[]`
  has the same as data: `outcome`, `stage`, `history`, and `deliverables` (id, name, size,
  sha256, note) when the task handed files over.
- **Waiting for you:** a `stage` starting with `person/` means the work waits for the user —
  `person/answer` (an agent asked a question), `person/review` (it is handed back for review),
  `person/blocked`, `person/delivery`. Say so plainly; the answer is given in the LumenBox app
  or the Channel the task came from, not by you guessing.
- `incomplete` (`turn_budget`, `rounds`, `held_for_review`, `partial`) means the agent stopped
  itself and handed the work back. It is not a failure to retry blindly and not a result.

### `fetch_deliverable`

- **The user says:** "Get me the report it made."
- **Call:** `fetch_deliverable({ task_id, deliverable_id? })` — the newest deliverable when no
  id is given; ids (`d1`, `d2`, …) are in `task_status`'s `deliverables`.
- **Returns:** a header line (name, size, sha256, note), then the file's text. A non-text file
  comes back as base64 in `structuredContent.content` (`encoding: "base64"`) up to 1 MiB:
  decode it and save it under its name. Larger binaries are downloaded from the task page.
- A deliverable is a copy taken when the agent marked it, so it is what was handed over, even
  if the box has changed since. Files merely mentioned in a reply are not deliverables.

### `list_agents`

- **The user says:** "Who's on my LumenBox team?" — or you need a name for `assign_task`.
- **Call:** `list_agents({})`. **Returns:** one line per agent: name, title, what it is for.

### `watch`

- **Use:** to wait for a change instead of polling `task_status`.
- **Call:** `watch({})` first, for a cursor; then `watch({ since: cursor, wait_seconds: 25 })`.
  It returns what moved (a task's status, stage, or goal), or nothing when the wait ran out.
  `reset: true` means changes were dropped: read `task_status` again.

### `goal_start`

- **The user says:** "Keep at it until X is verified done."
- **Call:** `goal_start({ objective, agent?, budget?, idempotency_key })` — `idempotency_key`
  is required. The agent drafts a checklist, works in rounds, and stops itself on budget,
  idling, repetition or a failed check. Follow it with `task_status`.

### `goal_control`

- **Call:** `goal_control({ task_id, action: "pause" | "clear" | "resume" })` on a goal the
  user started. Resume only undoes a pause they made; a goal the system stopped waits for the
  person, in the app.

### `raise_attention`

- **Use:** to ask the user to look at a task — a flag on it and an item on their "needs you"
  list. **Call:** `raise_attention({ task_id, note })`. It changes nothing about the work.

### `run_on_box`

- **Use:** a shell command on the user's box — not this machine, and not a scratch container.
  **Call:** `run_on_box({ command, cwd? })`. It passes the same policy gate as the agents'
  shell under the user's name; a dangerous command may be refused or wait for their approval.
  Returns the exit code, stdout and stderr.

### `box_screenshot`

- **Use:** to see the box's desktop now. **Call:** `box_screenshot({ agent? })`. Returns the
  path in the box where the screenshot was saved (not the image itself).

## What the answers mean, and do not

- **Assigned is not started.** `assign_task` returns as soon as the task exists; the work
  happens afterwards. Never tell the user it is done because you assigned it.
- **In Review is not Done.** `incomplete (held_for_review)` / `person/review` means the agent
  says it finished and a person decides. Report it as "ready for your review".
- **Completed means the board says so**, not that you checked the work. Read the deliverable
  before summarising it, and say what you read.
- **The result is in the deliverables**, fetched with `fetch_deliverable`. A task with none
  may still have answered in its chat; say that rather than inventing a file.

## When it does not work

1. **The `lumenbox` tools are missing, or every call fails to connect:** `agentbox web` is not
   running, or `AGENTBOX_MCP_URL` points elsewhere. Ask the user to start it; then restart
   the client.
2. **"This endpoint needs an access token issued to a person" (HTTP 401), or the server
   starts and then answers nothing:** the token is missing, mistyped or revoked. The user issues a new
   one in Settings → Mine and replaces it in the MCP entry. Do not ask them to paste it to you.
3. **"No box is running" from `run_on_box` or `box_screenshot`:** the installation runs
   without a box (`--no-box`) or the box is down; tasks still work, the box tools do not.
   `agentbox box up` starts it.
