<!-- doc: starter
     title: The starter team: a coordinator on call, with a researcher, an operator and a reviewer
     family: manual
     status: current
     covers: team:starter
     audience: user
     updated: 2026-11-06
-->
# The starter team: a coordinator on call, with a researcher, an operator and a reviewer

The four agents a new installation starts with, set up as the team that answers your chat
group, finds things out and checks its own work.

## Architecture

A new installation makes these four when it has no agents at all. It is not a catalog crew: you
do not add it, and deleting one does not bring it back. Ada is first, so she answers a channel
that names nobody.

| Role | Agent | What it does | What it touches | What it does not do |
|---|---|---|---|---|
| Coordinator | Ada | Answers you, does small things herself, hands the rest to a teammate | Every tool, including making and changing agents | Hand off a one-line job |
| Researcher | Rex | Follows sources to their origin and leaves what it found in a file | The browser, files, the shell | Build the team, forget for you |
| Operator | Ops | Installs, builds, runs scripts, moves files | The shell first, files | Build the team, forget for you |
| Reviewer | Vera | Reproduces what a teammate claims and reports what held | The shell, the browser, reading files | Write files, use outside services |

```
chat group / app ──▶ Ada ──┬── small job: does it herself ───────────────▶ reply
                           ├── "find out" ──▶ Rex ── notes in /home/box/work
                           ├── "make it run" ──▶ Ops
                           └── "is it true?" ──▶ Vera ── what was verified, what was not
```

## Core design

### Prompt

The four descriptions are in English and re-read on every turn (`STARTER_TEAM` in
`src/host/orchestrator.ts`). Each says how its work fails, not how helpful it is. Ada is told to do
the work herself when that is faster than a handoff. She proposes a catalog agent rather than
inventing one.

### Tools and permissions

- Ada has every tool, including `CreateAgent`, `UpdateAgent` and `Forget`.
- Rex and Ops have everything except building the team and forgetting.
- Vera has the same minus `write_file` and the MCP services: a reviewer that can change what it
  checks is no longer a reviewer.
- Change any of them in Configure → Tools; the task card's *Gate* line shows what the gate
  decided on each step.

### Skills

The starter skills and the hub skills ship with every box (see
[skills that ship](../reference-skills.md)). Type `/` in the chat box to see them. Rex reaches
for `deep-research`; Ops for `engine-check` when a coding engine is needed.

### Memory

Each agent keeps its own memory. What it found goes into a file under `/home/box/work`, so the
next person can read it. A fact for all four goes to team memory after a person approves it in
Settings → Team → Team memory.

### Credentials

None for the team itself. A channel needs the platform app's credentials (Settings → Channels).
`WebSearch` needs a search key (Settings → Model). A connector such as Notion needs its login
(Settings → Channels → Connectors). Work that needs a missing one shows a "Before … can start"
card instead of starting.

## Configuration: minimal and daily

| | Minimal | Daily |
|---|---|---|
| Agents | Ada alone does most of it; the other three are there | All four, or Ada alone if you never see a handoff pay off |
| Where you reach it | The app | A Feishu or DingTalk group with Ada as the default agent, *groups: only when addressed* |
| Review | You read the answer | Vera named as reviewer on work somebody will check |
| Tools | As shipped | `bash` on ask me for Ada in a group many people can write to |
| Supervision | The watchdog, on by default | Plus a daily spend limit per agent (Settings → Team) |

## Running cost

**Basis:** the measured comparison in [docs/83](../../83-team-vs-single-eval.md) (INV-1340), run
on 2026-10-24 with this team as shipped. It used the MiniMax (China) provider with
MiniMax-M3.1-Flash, in a scratch home and a dedicated box. The raw file is
`research/2026-10-24-inv1340/eval.json`. That file records input tokens with cached tokens
included and no split. So money is a range at this installation's configured rates (per million
tokens: 0.30 input, 1.20 output, 0.06 cache read). The high end treats all input as uncached; the
low end treats it all as a cache read.

| Episode | Agents that worked | Time | Model calls | Input | Output | Money |
|---|---|---|---|---|---|---|
| A brief from sources that disagree (`brief`, run 2) | Ada alone | 96 s | 18 | 464,859 | 16,125 | 0.05–0.16 |
| Checking a claim against files (`verify`, run 2) | Ada and one teammate, 2 messages | 97 s | 16 | 325,531 | 10,810 | 0.03–0.11 |
| Mean over 11 tasks, team | — | 641 s | 61 | 6.7M tokens in and out | | — |
| Mean over 11 tasks, one agent with the same tools | — | 316 s | 34 | 3.5M tokens in and out | | — |

What the comparison found: in 8 of 11 tasks Ada worked alone, and then the team costs the same as
one agent. Each handoff cost 3 to 10 times the calls and tokens, and the reviewer could not see
any better quality. The team's typical failure is no answer at all, rather than a wrong one.
That is the case for the daily column's "Ada alone".

## Build the minimal version

### In the app

1. Start LumenBox with a model key. The first start makes Ada, Rex, Ops and Vera.
2. Pick Ada in the sidebar and write your request.
3. Optional: in Configure, type one team name under *Teams* for all four, so they are listed
   together.

### In a chat

1. Settings → Channels → *Add channel*, choose `feishu` or `dingtalk`, and paste the app
   credentials.
2. On the channel's row, keep Ada as the default agent and choose *groups: only when addressed*.
3. Settings → Team → *New invite code*; in the group, each person sends `bind <code>`.
4. Mention the app in the group with a request. `团队` lists the four, `看板` shows the board,
   `/help` lists every command.

### From the command line

```
agentbox web                       # first start: "created Ada, Rex, Ops, Vera to start with"
agentbox agents                    # the four, with their descriptions
agentbox chat Ada "<request>"
agentbox usage --day 2026-11-06    # what the day cost
```

## Run monitoring

- **The sidebar:** a row that says `Waiting for you: …` is the one to answer. It means a
  question, an approval, a desktop handed to you, a spend limit or a provider that is resting.
- **The Tasks tab:** a request from the group becomes a task. One left in `doing` with no new
  history line is the one to look at.
- **Stuck:** in docs/83, the team failed by never settling: a handoff to Vera that did not come
  back within ten minutes. A watchdog "flagged for a person: …" line marks a task with no change
  for an hour. A turn that ends `incomplete` hit the per-turn limit of 60 model calls.
- **The task card:** *Division of work* shows each fork Ada or a teammate started and whether it
  reported. *Configuration vN* shows which settings the work ran on.

## Outside the box

- The Feishu or DingTalk app: registered in that platform's console by someone with the right to
  add apps, with the permissions the channel page lists.
- Who may talk to the team: invite codes, and the roles in Settings → Team.
- Who says done: you, on the Tasks tab or with `可以` in the chat. Ada's "finished" is not the
  same thing.
- Search keys and connector logins, which are paid or owned outside LumenBox.

## Extensions

- Add a catalog agent when the work needs one: Ada proposes it, and you agree.
- Start a supervised goal for long work (Settings → Supervision).
- Add the [ship crew](ship.md) for code, or the [media desk](media-desk.md) for content.
- `agentbox skill install` lets Claude Code or Codex hand work to this team over MCP.

## The run this page is based on

- Cost: [docs/83](../../83-team-vs-single-eval.md) §2 and its raw episodes in
  `research/2026-10-24-inv1340/eval.json` (`brief` run 2 and `verify` run 2, configuration
  `team`). The research folder is not in the repository.
- The minimal version, reproduced on 2026-11-06 in a new, empty home with `agentbox web
  --no-box` and a scripted model that has no key. The first start printed "created Ada, Rex,
  Ops, Vera to start with", and the app listed the four. Not reproduced: a reply from a real
  model, the chat steps (they need a registered Feishu or DingTalk app), and any cost.
