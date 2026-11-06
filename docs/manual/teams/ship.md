<!-- doc: ship
     title: Ship: a product, an engineer and a reviewer
     family: manual
     status: current
     covers: crew:ship
     audience: user
     updated: 2026-11-06
-->
# Ship: a product, an engineer and a reviewer

A design you can copy for code work: one agent writes the spec, one builds it, and a different
one reviews it.

## Architecture

The `ship` crew (研发小队 in the app) adds three agents from the catalog. Each has its own
desktop and files in the same box. The split is real because each one can do different
things, not because each one is described differently.

| Role | Agent | What it does | What it touches | What it does not do |
|---|---|---|---|---|
| Product | Mo (产品) | Turns a wish into a spec: who uses it, what counts as done, what is out | Files in the box, Feishu docs (`ReadFeishuDoc`) | Write code |
| Engineer | Lin (工程师) | Writes and runs code; hands large changes to a coding engine | Files, the shell, `Delegate` to a coding engine | Decide whether to build it |
| Reviewer | Heng (审查) | Reviews the change for correctness and security, in a review file | Files and the shell; no outside services | Rewrite the code it reviews |

```
you ──▶ Mo ── spec in /home/box/work ──▶ Lin ── change + tests ──▶ Heng ── review file
 ▲                                                                       │
 └──────────── the task moves to review; you decide done ◀───────────────┘
```

## Core design

### Prompt

Each persona is written in Chinese and re-read on every turn (`src/host/catalog-data/experts/`).
Each one names its handoff: Mo writes the spec for Lin, Lin hands to Heng, and Heng "does not
change the code under review". Lin's rule is that a failing test is not done, and an engine's
"finished" is not a result until Lin re-runs it.

### Tools and permissions

- Mo has the desk tools — files, tasks, memory, teammates and the box's MCP services — plus
  `ReadFeishuDoc`.
- Lin has the desk tools plus `Delegate`, and no browser: the coding engine reads the repository.
- Heng has the desk tools without the MCP services, because a service's tool may write.
- Set each tool to allowed, ask me or off in Configure → Tools. The task card's *Gate* line
  counts each step: allowed, asked you, waiting for you, refused.

### Skills

The skills ship with every box, so a persona only says when to read one: Mo reads `grill-me`,
`market-researcher` and `deep-research`. Lin reads `diagnose`, `fullstack-dev`, `grill-me` and
`code-review`. Heng reads `code-review`, `diagnose` and `fullstack-dev`.

### Memory

Each agent keeps its own memory. The spec, the code and the review are files under
`/home/box/work`, so they outlive the conversation and the next agent reads them there. Share a
fact with the whole team through team memory; a person approves it in Settings → Team → Team
memory.

### Credentials

The crew needs no secret of its own. A coding engine runs through LumenBox's model connection;
the `engine-check` skill installs one in the box. A private repository needs a deploy key or a
token in the box. Store it with Settings → Team (secrets), so that a "Before Lin can start"
card asks for it instead of the agent failing halfway.

## Configuration: minimal and daily

| | Minimal | Daily |
|---|---|---|
| Agents | Mo, Lin and Heng, as the crew adds them | The same three, on the `ship` team |
| Box | The default Docker box | A box with the repository checked out under `/home/box/work` and an engine installed (`engine-check`) |
| Tools | As the catalog gives them | Heng: `edit_file` off; Lin: `bash` on ask me until you trust it |
| Review | You read Heng's review file | A task with Heng as reviewer: Lin's `done` moves it to `review`, Heng's closes it |
| Channel | The app only | A Feishu or DingTalk group with Mo as the default agent |
| Spend | No limit | A per-agent daily limit in Settings → Team |

## Running cost

**Basis:** this installation's own records (`~/.agentbox/usage.jsonl` and `turns.jsonl`) for the
agent installed from `catalog:heng`, for its 93 turns from 2026-11-03 15:24 to 2026-11-04 02:46 UTC. The model is
MiniMax-M3.1-Flash. Money uses the rates in this installation's `config.json`, per million
tokens: 0.30 input, 1.20 output, 0.06 cache read, in the currency `agentbox usage` prints as `$`.
The table holds those rates under the name `MiniMax-M3.1-Flash-Preview`. Every row says
`cache_unknown`, so `agentbox usage` itself withholds money for these turns. The figures below
assume no cache writes, and the provider reported 0.

| What | Time | Model calls | Input | Output | Cache read | Money |
|---|---|---|---|---|---|---|
| One review reply (turn `809ab446`) | 478 s | 28 | 83,068 | 70,807 | 2,824,704 | 0.28 |
| A typical reviewer turn (median of 71 that ended done) | 34 s | 1 | — | — | — | 0.016 |
| The costliest reviewer turn of the 71 | — | — | — | — | — | 1.43 |
| All 93 reviewer turns (71 done, 13 stopped at the 60-call limit, 9 aborted) | 10.8 h | — | — | — | — | 23.73 |

What is not measured yet: the whole crew on one task. Lin was not installed on this
installation. Mo's only turn, on 2026-09-08, was its set-up turn, and its usage rows were
compacted after 48 hours. Measure it this way: install the crew and give Mo one change to
specify. Let Lin build it and Heng review it, with `AGENTBOX_USAGE_RETAIN_HOURS` long enough.
Then run `agentbox usage --task tN` on the task.

## Build the minimal version

### In the app

1. Press `+` beside *Agents*. Under *From catalog*, press `研发小队`.
2. Read the three members in the preview and press *Create these 3 in <box>*.
3. The crew's members are not put on a team by themselves yet. Open Configure on each one and
   type `ship` under *Teams*; the sidebar then lists them under SHIP.
4. Pick Mo and write the wish: who it is for, and what counts as done.
5. When the spec is in the box, ask Lin to build it and to hand the result to Heng.

### In a chat

1. In Settings → Channels, set the group's default agent to Mo.
2. In the group, send the wish to Mo. Send `@Lin` and `@Heng` messages for the later steps.
3. Send `看板` to see the task, and `可以` to accept it when it waits for you.

### From the command line

```
agentbox agents                                  # Mo, Lin and Heng are listed after the install
agentbox chat Mo "给团队写一页说明：……给谁用、怎样算做成、明确不做哪些。"
agentbox usage --task t12                        # what that task cost, once it has turns
```

The crew is added from the app or by an agent's `CreateAgent` with `from: ship`; there is no
install command.

## Run monitoring

- **The sidebar:** each row says `Running`, or `Waiting for you: …` when an agent needs a person.
  That happens when it asks a question, needs an approval, hands you the desktop, reaches a
  spend limit or waits for the model provider.
- **The Tasks tab:** a healthy task goes `doing` → `review`. "turn ended; not closed because …"
  means it stopped and was not verified; you decide.
- **Stuck:** a turn that ends `incomplete` in `turns.jsonl` hit the per-turn limit (60 model calls
  by default). A watchdog line "flagged for a person: …" on the task means no change for an hour.
- **The task card:** *Deliverables*, *Configuration vN* (the settings the work ran on), *Division
  of work* when Lin splits the job into forks, and the *Gate* line.
- **Spend:** the tokens-today figure in the top bar opens the Spend view.

## Outside the box

- You decide `done`. A reviewer's approval moves the task; nobody else's word closes it.
- The repository's access: a deploy key or token, and who may push.
- Merging and releasing: the crew writes the change and the review, and a person merges.
- A Feishu or DingTalk app registered in that platform's console, if the crew works in a group.

## Extensions

- Add `xi` (分析师) when the work needs numbers with sources behind them.
- Make a routine that has Heng review every new change each night (Automations → *+ New*).
- Save the tuned Lin as a template (Configure → *Ask it to draft a template*) for the next box.
- Install the LumenBox skill for Claude Code or Codex (`agentbox skill install`) to hand the crew
  work from your own editor.

## The run this page is based on

- Cost: one installation's records, turn `809ab446-1ebf-4884-a063-29790ca09ae6` and its 92
  siblings by the same agent in `turns.jsonl` and `usage.jsonl`, read on 2026-11-06. The
  arithmetic is above, so it can be re-run.
- The minimal version, reproduced on 2026-11-06 in a new, empty home. It ran
  `agentbox web --no-box` with a scripted model that has no key (`AGENTBOX_PROVIDER=custom`
  pointed at a local stub). Steps 1–4 of *In the app* ran: the crew was added,
  three agents appeared, Mo answered with one usage row (`in 1,200 out 60`), and
  `agentbox usage` printed it. Without a box, each member logged "cannot install its recipe; it
  will start blank". Not reproduced: step 5 (it needs a box and a model), the chat steps, and
  any cost.
- Design: [docs/94](../../94-catalog.md) (the catalog), [docs/75](../../75-cost-per-accepted-task.md)
  (why a cost is per accepted task).
