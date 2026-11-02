<!-- doc: 91-watchdog
     title: The watchdog: a control loop outside the orchestrator
     family: guide
     status: current
     updated: 2026-11-02
-->
# The watchdog: a control loop outside the orchestrator

The orchestrator has its own stops: goal mode pauses on budget, idling and repetition, and a
second session checks "done". All of that runs inside the orchestrator. When the orchestrator
itself hangs, or a piece of work goes quiet without tripping any stop, nothing inside notices.
The watchdog is the loop outside. It is the first client of the supervisor contract in
[docs/90](90-outside-supervisor.md), and it follows the rule that page sets: a supervisor is a
principal on the door, not a hand in the box.

## Running it

Mint a side-door token in Settings → MCP. The token belongs to a person, and every flag the
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
