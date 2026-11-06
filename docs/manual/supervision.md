<!-- doc: supervision
     title: Supervision
     family: manual
     status: current
     covers: supervision
     audience: user
     updated: 2026-11-06
-->
# Supervision

Goals that keep going until they are checked, and who notices when work stops moving.

## What it is

A **goal** is a way of working on one task: the agent drafts a checklist, keeps going turn after
turn, completes when the checklist passes, and pauses when its budget runs out. Its states are `active`,
`verifying`, `paused`, `complete` and `cleared`. The **watchdog** watches every task and flags
the ones that stopped moving; it is on by default. The **supervisor** is optional: another model
that starts a goal for you and watches it to the end.

A flag is not a fix: the watchdog only says something is wrong, and moves nothing. Check the
task, where the flag is a line in its history and an item on your "needs you" list.

## How to do it

### In the app

- **Set it up:** Settings → Supervision. The first time, a five-step guide walks you through it:
  what it can do, the model, the agent and budget, the first goal, and the start.
- **Change the watchdog:** the *Watchdog* section; press *Save supervision settings*.
- **Start a supervised goal:** write what done looks like and press *Start a supervised goal*.
  It makes a task on your board, marked `supervised` while the supervisor watches it.
- **See the runs:** the *Supervisor runs* section.

### In a chat

In a private chat with the agent:

- `/goal <what done looks like>` — start a goal; its first turn drafts the checklist.
  `--budget <amount>` sets a budget.
- `/goal` — show the current goal.
- `/goal pause`, `/goal resume`, `/goal clear` — pause, resume or clear it.
- `/goal replace <text>` — change what the goal is.

A watchdog flag also arrives as a notice in the task's chat.

### From the command line

The app runs the watchdog and the supervisor for you. Without the app, on a server:

```
agentbox watchdog install      # start it at login, with its own token
agentbox watchdog status       # is it running, its last flag, its recent log
agentbox watchdog uninstall    # stop it and revoke its token
agentbox supervise --objective "<what done looks like>" --token-file <file>
```

These commands are not in `agentbox --help` yet. A token comes from Settings → Mine → Your
MCP tokens.

## Where to see the result

- The task: the goal's checklist and state, and any watchdog flag in its history.
- Your "needs you" list at the top of the sidebar and of the Tasks tab.
- Settings → Supervision → Supervisor runs.

## Limits

- Neither the watchdog nor the supervisor can mark work done, resume what the system stopped,
  raise a budget or touch a box.
- The watchdog flags work in hand with no change for 60 minutes, and a goal the system stopped
  that nobody touched for 30 minutes. Your own pause is never flagged.
- A supervised goal spends twice: the supervisor's model and the agent's model.
- `/goal` works in a private chat, not in a group chat.

## Next

- [Tasks and records](tasks-and-records.md): the board a goal lives on.
- [Automations](automations.md): work that starts by itself.
- [docs/91](../91-watchdog.md): the watchdog in full.
