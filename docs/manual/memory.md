<!-- doc: memory
     title: Memory
     family: manual
     status: current
     covers: memory
     audience: user
     updated: 2026-11-06
-->
# Memory

What an agent keeps between conversations, and how you read, correct or remove it.

## What it is

**Memory** is the facts an agent keeps: one line each, with where it came from. Each agent has
its own memory, and a team has a shared memory every agent in the box can read. An agent saves
a fact with its `RememberFact` tool, finds facts with `Recall`, and removes one with `Forget`.
`Recall` finds a fact by its words and by what it is about, so "deploy" also finds a line about
a release.

A team fact is not shared until it is approved when review is on: with Settings → Team → Team
memory → *Review first* ticked, a write to the team's memory waits for an admin. Check the list
under Team memory.

## How to do it

### In the app

- **Read it:** Settings → Memory lists the agents by box, with how many lines each keeps. Open
  an agent to read its lines; team lines are marked `· team`.
- **Correct a line:** press *Edit* on the line. **Remove one:** press *Withdraw*. To remove
  everything learned from one source, press *Withdraw <source>*.
- **Review team writes:** Settings → Team → Team memory. Tick *Review first*, then *Approve* or
  *Reject* each write that waits.
- **What agents know about you:** Settings → Mine → About me. Your own lines outrank what agents
  learned.

### In a chat

There is no memory command. Say what to keep in plain words — "记住：周报发到产品群" — and the
agent saves it. Ask it to forget something the same way; it asks you to confirm first.

### From the command line

There is no memory command. `agentbox backup` copies the memory with the rest of
`~/.agentbox`, which is where the memory lives on your machine.

## Where to see the result

- Settings → Memory: every line, its source, and the withdrawn ones.
- The next turn: a change is in the agent's next turn.
- In the box, `memory/<agent id>/profile.md` under the *Files* tab: a read-only copy of the same
  memory.

## Limits

- One fact is under 500 characters.
- `profile.md` is rewritten by LumenBox. An edit there is lost; use Settings → Memory instead.
- Team memory review is off until an admin ticks *Review first*. A rejected write is never
  shared.
- Finding by meaning uses a fixed list of related words, not a model. A fact phrased very
  differently may still be missed.

## Next

- [Skills](skills.md): how-to, as opposed to facts.
- [Approvals](approvals.md): who may change shared things.
- [Agent](agent.md): one agent's settings.
