<!-- doc: automations
     title: Automations
     family: manual
     status: current
     covers: routine
     audience: user
     updated: 2026-11-06
-->
# Automations

Work that starts by itself: on a timer, when a URL is called, or when a message matches.

## What it is

A **routine** is a skill that runs by itself. Its file says when: `schedule:` for a timer,
`trigger: webhook` for a URL anything can call, or `trigger: message` for a message that
matches. `deliver:` names the chat that gets the report. A routine is in one of three modes:
`off` never runs, `observe` records what it would have done, and `auto` runs.

Observe mode reports and does not act: a routine in observe records that it would have run, and
nothing runs. Check the Automations tab: "would have run N times · last …".

## How to do it

### In the app

- **Make one:** the Automations tab → *+ New*. Give it a name and an instruction, choose *When
  to run* — on a schedule, a webhook, or a message — and the agent it runs as.
- **Try it safely:** press *Observe* to watch what it would do, then *Let it run* when you trust
  it. *Run now* runs it once at once.
- **Pause or resume it:** *Pause* and *Turn on*.
- **Read its history:** press *Runs*. You see the last runs with their outcome — done, partial,
  failed, skipped, observed, running or interrupted — and the next ones due.
- **Webhook routines:** *Show* and *Copy* give the secret; *New secret* replaces it. The old
  secret keeps working for 24 hours; *Stop it now* ends that at once.
- **Auto-pause:** Settings → Team → Routines → *Pause after failures in a row* (3 by default;
  0 never pauses).

### In a chat

- `定时` (or `automations`) — list what runs by itself.
- `早报` — this group chat's digest now; `早报 8点` sends it daily at 8; `早报 关` stops it.
- A routine reports to the chat its `deliver:` names.

### From the command line

```
agentbox routines runs <name> [--limit N]   # a routine's last runs, and whether it was paused
```

A webhook routine is started with an HTTP POST to its URL, with
`Authorization: Bearer <secret>`.

## Where to see the result

- The Automations tab: each routine's mode, its last run, and why it is paused.
- *Runs* on a routine: its run history.
- The chat named by `deliver:`: the report itself.

## Limits

- A routine that fails 3 times in a row (or the number you set) is paused, with the last
  failure as the reason, until someone presses *Turn on*.
- A routine whose secret or connector is missing does not start: the run is skipped and the
  routine is held until it is turned on again.
- A routine with no mode written runs: it is `auto`, shown as "auto (no mode set)".

## Next

- [Skills](skills.md): a routine is a skill with a `schedule:` or `trigger:`.
- [Approvals](approvals.md): what a routine may do without asking.
- [Supervision](supervision.md): who notices work that stops moving.
