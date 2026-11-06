---
name: lumenbox
description: "Use when the user asks to hand work to LumenBox or its agents (\"let the research team look into X\", \"have LumenBox do this and tell me\"), or when a job needs a computer of its own, outlives this session, needs a team, or should leave a record: assign it through the lumenbox MCP tools, follow it with task_status or watch, and collect the result with fetch_deliverable."
---

# LumenBox

LumenBox is the user's own team of AI agents. Each agent has a persistent Linux box with a
desktop, a browser and files that stay. This skill drives LumenBox from here through its MCP
endpoint: the `lumenbox` server, which is `agentbox mcp` talking to the user's running
`agentbox web`. Everything you do through it is done as the person whose token configured
the server. Every task you start is on their Tasks tab.

## When to hand work to LumenBox, and when not

Hand it over when the work:

- **takes long**: minutes to hours. You get a task id now and ask later.
- **needs a real machine**: a desktop, a signed-in browser, tools that stay installed.
- **needs a team**: the user's agents have roles, and one of them may know the subject.
- **should leave a record**: the task keeps who did what and the files the agent delivered.

Do it yourself when it is quick, local to this repository, or needs what only this session
has. Never send LumenBox a secret the user did not ask you to send.

## Install

1. Run `agentbox skill install` (Claude Code) or `agentbox skill install --codex`. It copies
   this file and prints the MCP entry to add, with a placeholder where the token goes.
2. The user issues a token in the LumenBox app: Settings → Mine → Your MCP tokens → Issue.
   The app shows it once. The user pastes it in place of the placeholder. You never need to
   see it; never print, echo or commit it.
3. `agentbox web` must be running. The default address is `http://127.0.0.1:7777`; another
   address goes in `AGENTBOX_MCP_URL`. Restart the client so it loads the server and the skill.

## The tools

The names below are the server's. Your client may prefix them, for example
`mcp__lumenbox__assign_task`.

### `assign_task`

- **The user says:** "Have the research team look into X and tell me when it's done."
- **Call:** `assign_task({ brief, agent? })`. The `brief` is the whole request, self-contained,
  because the agent cannot see this conversation. The `agent` is a name from `list_agents`.
  Omit it, and the default agent takes the work and hands it to the right agent.
- Pass `idempotency_key` (any unique string, the same one on a retry). A retried call then
  returns the first answer instead of making a second task.
- **Returns:** `t42 — Ada is on it. Ask task_status about t42.` and `status: in_progress`.
- **Then:** tell the user the task id and that it is running. Check back with `task_status`
  or `watch`; do not poll in a tight loop.

### `task_status`

- **The user says:** "How is the LumenBox task going?" or "What do I have open there?"
- **Call:** `task_status({ task_id })`. Without an id, it lists the user's open tasks;
  `scope: "all"` lists every open task.
- **Returns:** a first line `status: in_progress | completed | failed | incomplete | cancelled`,
  with the reason in brackets, then the task and its history. `structuredContent.tasks[]` has
  the same as data: `outcome`, `stage`, `history`, `reply` (the agent's final reply when
  its turn ended: `at`, `by`, `text`, at most 2000 characters), and `deliverables` (id, name,
  size, sha256, note) once the task has delivered files. In the text, the reply is the
  history line that says `replied:`.
- **Waiting for you:** a `stage` that starts with `person/` means the work waits for the user.
  `person/answer`: an agent asked a question. `person/review`: the work is back for review.
  `person/blocked` and `person/delivery` also wait for the user. Say so plainly. The user
  answers in the LumenBox app or in the channel the task came from; do not answer for them.
- `incomplete` (`turn_budget`, `rounds`, `held_for_review`, `partial`) means the agent stopped
  itself and handed the work back. Do not retry it blindly, and do not report it as a result.

### `fetch_deliverable`

- **The user says:** "Get me the report it made."
- **Call:** `fetch_deliverable({ task_id, deliverable_id? })`. Without an id, you get the
  newest deliverable. The ids (`d1`, `d2`, …) are in the `deliverables` of `task_status`.
- **Returns:** a header line (name, size, sha256, note), then the file's text. A file that is
  not text comes back as base64 in `structuredContent.content` (`encoding: "base64"`), up to
  1 MiB. Decode it and save it under its name. The user downloads larger files on the Tasks
  tab: task detail → Files.
- LumenBox copies a deliverable when the agent delivers it. You get what was handed over,
  even if the box has changed since. A file an agent only mentions in a reply is not a
  deliverable.

### `list_agents`

- **The user says:** "Who's on my LumenBox team?" Or you need a name for `assign_task`.
- **Call:** `list_agents({})`. **Returns:** one line per agent: name, title, what it is for.

### `watch`

- **Use:** to wait for a change instead of calling `task_status` again and again.
- **Call:** `watch({})` first, to get a cursor. Then call `watch({ since: cursor, wait_seconds: 25 })`.
  It returns what moved (a task's status, its stage, or its goal), or nothing when the wait
  ran out. `reset: true` means changes were dropped: read `task_status` again.

### `goal_start`

- **The user says:** "Keep at it until X is verified done."
- **Call:** `goal_start({ objective, agent?, budget?, idempotency_key })`. The
  `idempotency_key` is required. The agent drafts a checklist and works in rounds. It stops
  itself on budget, idling, repetition or a failed check. Follow it with `task_status`.

### `goal_control`

- **Call:** `goal_control({ task_id, action: "pause" | "clear" | "resume" })` on a goal the
  user started. Resume only undoes a pause the user made. A goal that LumenBox stopped waits
  for the user in the app.

### `raise_attention`

- **Use:** to ask the user to look at a task. It puts a flag on the task and an item on
  their "needs you" list. **Call:** `raise_attention({ task_id, note })`. It changes nothing
  about the work.

### `run_on_box`

- **Use:** to run a shell command on the user's box. The box is not this machine and not a
  scratch container. **Call:** `run_on_box({ command, cwd? })`. The command passes the same
  approval rules as the agents' shell, under the user's name. A dangerous command may be
  refused or wait for the user's approval. **Returns:** the exit code, stdout and stderr.

### `box_screenshot`

- **Use:** to see the box's desktop now. **Call:** `box_screenshot({ agent? })`.
  **Returns:** the path in the box where the screenshot was saved, not the image.

## What the answers mean, and do not

- **Assigned is not started:** `assign_task` returns as soon as the task exists. Never tell
  the user the work is done because you assigned it.
- **Review is not Done:** `incomplete (held_for_review)` or stage `person/review` means the
  agent says it finished. A person decides Done on the Tasks tab. Report it as "ready for
  your review".
- **Completed is not checked:** `completed` means the task says so. Read the deliverable
  before you summarise it, and say what you read.
- **A reply is not a deliverable:** files are in the deliverables, and `fetch_deliverable`
  gets them. A task with none may still have answered: its `reply` is what the agent said
  when it finished, cut at 2000 characters. Quote it as the agent's answer, say it was cut
  when it ends in `…`, and do not invent a file it only mentions.

## When it does not work

1. **The `lumenbox` tools are missing, or every call fails to connect:** `agentbox web` is
   not running, or `AGENTBOX_MCP_URL` points somewhere else. Ask the user to start it, then
   restart the client.
2. **"This endpoint needs an access token issued to a person" (HTTP 401), or the server
   starts and then answers nothing:** the token is missing, mistyped or revoked. The user
   issues a new one in Settings → Mine → Your MCP tokens and puts it in the MCP entry. Do not
   ask the user to paste it to you.
3. **"No box is running" from `run_on_box` or `box_screenshot`:** the installation runs
   without a box (`--no-box`), or the box is down. Tasks still work; the box tools do not.
   `agentbox box up` starts the box.
