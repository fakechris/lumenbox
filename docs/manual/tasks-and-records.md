<!-- doc: tasks-and-records
     title: Tasks and records
     family: manual
     status: current
     covers: task
     audience: user
     updated: 2026-11-06
-->
# Tasks and records

The board of what is being done, how work gets accepted, and the record that shows what
actually happened.

## What it is

A **task** is one piece of work on the board: a title, who asked, who has it, a state and a
history. A request in a chat becomes a task; you can also add one yourself. The states are
`open`, `doing`, `blocked`, `review`, `done` and `dropped`. A **deliverable** is a file an agent
hands over on a task. The **record** is what every turn actually did — each tool call and its
result — kept on your machine, apart from what the agent says about itself.

A finished turn is not accepted work: when a task has acceptance criteria, a due date or an
outside dependency, the end of the turn moves it to `review`, and a person decides `done`.
Check the task's history: "turn ended; not closed because … — stopped, not verified". A plain
one-off question closes when it is answered.

An agent's proposal is not agreed work: a task an agent proposes carries a `proposed` chip, and
nobody takes it until a person presses *Commit*.

## How to do it

### In the app

- **Add a task:** the Tasks tab → type in *New task title…*, pick an agent or leave it
  `unassigned`, and press *Add*.
- **See what needs you:** the board lists what waits on you first. Press `inbox` to see only
  what agents proposed; press *Commit* to make one real work, or *Dismiss* to close it.
- **Accept work:** set the task's state to `done` in its row. If a reviewer is named, the
  assignee's `done` moves the task to `review` instead, and the reviewer's closes it.
- **Open a task:** click its id or title. The detail shows *Deliverables* (each file with
  *Download*), *Configuration vN* (the agent's settings it ran on), *Division of work*, and the
  history with its evidence.
- **Follow the division of work:** when an agent splits a task, each part runs as a **fork** —
  a copy of the agent with a one-line brief. Forks are folded under the thread that started
  them (`▸ 2 forks · 1 done · 1 running`), and the task's *Division of work* shows each one's chain:
  sent → started → reported → merged.
- **Read the record:** the Audit tab shows each tool call. *Hide system probes* is on by default.

### In a chat

- `看板` (or `board`) — the board; tasks that wait for you are under 待验收.
- `可以` (or `收到`, `通过`, `ok`) — accept the task that waits on you. It only counts while a
  task is in `review`; otherwise it is just chat.
- `停` (or `stop`) — stop what is running and withdraw its task.
- `/continue <task> <text>` — add an instruction to a task of yours that is running.
- `/recover t<number>` — rebuild a task from its record and carry on (private chat only).
- A deliverable arrives in the chat as a file, with the reply.

### From the command line

```
agentbox usage --task t12        # what one task cost, across its turns
agentbox usage --day 2026-11-06  # what one day cost
agentbox audit export --box <name> --from <date> --out <dir>   # one box's record, secrets redacted
agentbox scan-records            # what in the record looks like a credential
agentbox backup                  # copy ~/.agentbox without stopping anything
```

From another tool over MCP, `fetch_deliverable` reads a task's deliverable.

## Where to see the result

- The Tasks tab: the state, the chips (`due …`, `waiting on …`, `proposed`) and the history.
- The task detail: its deliverables, the configuration version and the division of work.
- The Audit tab and `agentbox usage`: what was done and what it cost.

## Limits

- Only the person who asked, the named reviewer, or the assignee may close a task. Only the
  person who asked or the reviewer may drop it; anyone may dismiss a proposal.
- A deliverable is at most 25 MiB. A file that cannot be opened as its name says — a `.pdf`
  that is not a PDF — is refused, and the agent has to make it again.
- A fork's thread is read-only; you talk to the agent that started it.
- `fetch_deliverable` returns at most 1 MiB; download a larger file from the task.

## Next

- [Approvals](approvals.md): what an agent asks before it acts.
- [Supervision](supervision.md): goals, and who watches work that stops moving.
- [Automations](automations.md): tasks that start by themselves.
