<!-- doc: 91-watchdog
     title: The watchdog: a control loop outside the orchestrator
     family: guide
     status: current
     updated: 2026-11-06
-->
# The watchdog: a control loop outside the orchestrator

The orchestrator has its own stops: goal mode pauses on budget, idling and repetition, and a
second session checks "done". All of that runs inside the orchestrator. When the orchestrator
itself hangs, or a piece of work goes quiet without tripping any stop, nothing inside notices.
The watchdog is the loop outside. It is the first client of the supervisor contract in
[docs/90](90-outside-supervisor.md), and it follows the rule that page sets: a supervisor is a
principal on the door, not a hand in the box.

## In the app

Nothing to install. The desktop app runs the watchdog, together with the supervisor's run queue,
as one child process beside the server: `agentbox supervision`. The app starts it once the server
is ready, restarts it if it exits, restarts it when settings change, and stops it on quit. On
first start the process issues its own door token for the installation's admin, labelled
"LumenBox supervision" in that admin's Settings → Mine → Your MCP tokens. It keeps the token in `~/.agentbox/supervision/token`
and reuses it from then on. If the door refuses it, the process issues a new one once. What a person
should hear, such as the server not answering, a token refused, or a run that could not start,
arrives as the app's own notification. The log is `~/Library/Logs/LumenBox/supervision.log`. The tray shows
whether supervision is running. Its settings are in Settings → Supervision, which writes the `supervision` section of
`config.json`. The watchdog is on unless turned off there. A saved change restarts the process with the new settings.

## Running it by hand

Mint a side-door token in Settings → Mine → Your MCP tokens. The token belongs to a person, and every flag the
watchdog raises is in that person's name. Then run:

```
agentbox watchdog --token lmbx_… [--url http://127.0.0.1:7777] [--on-down 'osascript -e "display notification \"LumenBox is down\""']
```

The token can come from `AGENTBOX_WATCHDOG_TOKEN` instead. Other flags:

| Flag | Default | What it does |
|---|---|---|
| `--stall-minutes` | 60 | Work in hand with no change on its record for this long is flagged. |
| `--paused-minutes` | 30 | A goal the gate stopped, untouched for this long, is flagged. |
| `--wait` | 25 | Seconds each `watch` waits for a change; the loop's pace when nothing moves. |
| `--on-down` | none | A shell command run once per outage when the door stops answering; `WATCHDOG_REASON` says why. |
| `--judge` | off | Ask the decision model, once an hour per active goal, whether its latest moves advance the checklist. |

## Without the app

On a headless machine, run it by hand, or install it as a launchd service. App users need neither.

Install it once and it starts at login and restarts if it exits:

```
agentbox watchdog install            # mints a token for the installation's admin, decision model on
agentbox watchdog status             # running or not, the last flag, the recent log
agentbox watchdog uninstall          # stops it, revokes its token, removes its files
```

`install` takes the same `--stall-minutes`, `--paused-minutes` and `--on-down` flags, plus
`--principal <name>` when the installation has more than one admin and `--no-judge` to leave the
decision model off. By default, a door that stops answering raises a macOS notification. The
token is labelled "watchdog" in Settings → Mine → Your MCP tokens. It is kept in `~/.agentbox/watchdog/token`,
readable only by you, and never in the launchd job file. The job runs the same `agentbox` that
ran `install`, so install it from the app you use.

The watchdog needs a door with the structured record and the change feed. On an older LumenBox
it says so once in its log, and asks again every ten minutes, so upgrading the app is enough. A
token the door no longer accepts is also said once, and is not treated as an outage. Run
`uninstall` and then `install` to replace it.

## What it judges

Every rule reads the record only, and each says something a person can check by opening the task.

- **Stalled.** The task is in hand, its goal if any is active, and nothing on its record changed
  for the stall limit.
- **Stopped and unattended.** The gate stopped a goal for budget, repetition, idling or a failed
  check, and nobody touched it for the paused limit. A person's own pause is never flagged.
- **Verification failing.** A goal's verification failed twice or more.
- **Door down.** Two calls in a row could not reach the door.

Before acting on a finding, it reads that task again, because a note the change feed does not
carry may have moved it.

## What it may do

| It may | How |
|---|---|
| Flag a task for a person | `raise_attention`: a line on the task, an item on the requester's "needs you" list, a notice in the task's chat |
| Pause a goal its own principal started, stalled two hours or more | `goal_control pause`; only that principal can resume this pause from the door |
| Say the orchestrator is gone | the `--on-down` command, once per outage, and a log line when it is back |

A flag moves nothing. It holds until the task's status next changes. The same note on the same
task within six hours is the same flag, at the door and in the watchdog.

## What it may not do

It cannot mark anything done, resume what the gate stopped, raise a budget, change a rule, or
touch a box. It has no tool for any of these, because the door offers none to anyone. The
decision model's opinion, when asked for, is only ever a flag.
