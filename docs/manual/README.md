<!-- doc: README
     title: The LumenBox manual
     family: manual
     status: current
     covers: manual
     audience: user
     updated: 2026-11-06
-->
# The LumenBox manual

English · [中文](README.zh.md)

How to use LumenBox, one page per thing you meet. Start with [docs/37](../37-onboarding.md) to
install it; come here when you want to know what something is and where to find it.

Every page has the same parts: what it is, how to do it in the app, in a chat and from the
command line, where to see the result, its limits, and what to read next. The words follow
[the glossary](../glossary.md). The design record says *why*; this manual says *how*.

## What LumenBox is

Your own team of AI agents, each with a real computer to work on — reached from your desktop
and your chat apps, taken over at any moment, and believed on the record, not on its word.
The table is the short form of [docs/02 §1.1](../02-product.md#11-how-it-differs), which says
where each row is held to account.

| | LumenBox | A single coding-agent CLI | A hosted agent platform |
|---|---|---|---|
| **The computer** | A Linux box with a desktop per agent, which outlives any session | Your own machine, for one session | A sandbox per session, gone when it ends |
| **Where you reach it** | The app, and Feishu, DingTalk and other chat apps; one person across all of them | The terminal it started in | An API and a console |
| **A team, and taking over** | Named agents that message and delegate to each other; you take a desktop over at any time | One agent; taking over means interrupting it | Agents as API objects; no shared screen |
| **The record** | Every turn's tool calls and results, kept on your machine | A transcript on one laptop | Session history held by the vendor |
| **Who says "done"** | You, for anything somebody will check | The agent, when it stops | The run's status |
| **Where it runs** | One machine by default; a control plane is optional | The developer's machine | The vendor's cloud |

## Everything you meet

One row per concept. **In a chat** is what you type in a Feishu or DingTalk chat. A dash means
there is no entry there yet.

| Concept | In the app | In a chat | Command line | State words | Page |
|---|---|---|---|---|---|
| box | Settings → Boxes; `+ box` in the box bar | `桌面`, `屏幕` | `agentbox box up`, `box list`, `box status`, `box attach` | box online · box unavailable | [box](box.md) |
| agent | sidebar `+`; Configure; Settings → Team → Agents | `@name`, `团队` | `agentbox agents`, `agentbox agent new` | Running · Waiting for you · paused | [agent](agent.md) |
| team | Configure → Teams; `teams` in the sidebar | `团队` | — | on or off an agent | [agent](agent.md) |
| crew | New agent → From catalog | — | — | in the catalog · added | [templates](templates.md) |
| template | sidebar Templates → Stamp | — | `agentbox template import`, `share`, `download` | staged · stamped | [templates](templates.md) |
| configuration version | Configure → History; the `config vN` chip | — | — | in effect · applies from the next turn | [agent](agent.md) |
| tool permission | Configure → Tools chips | — | — | allowed · ask me · off | [approvals](approvals.md) |
| channel | Settings → Channels → Add channel | the chat itself; `bind <code>` | — | connected · not connected | [channels](channels.md) |
| group chat | Settings → Channels, group rule | the group | — | only when addressed · answer all | [channels](channels.md) |
| connector | Settings → Channels → Connectors | — | — | connected · not connected | [channels](channels.md) |
| skill | type `/` in the chat box | — | `agentbox skills import`, `skills improve` | present in a box or not | [skills](skills.md) |
| LumenBox skill for Claude Code and Codex | Settings → Mine → Your MCP tokens | — | `agentbox skill install` | — | [skills](skills.md) |
| memory | Settings → Memory | — | `agentbox backup` copies it | live · withdrawn | [memory](memory.md) |
| team memory review | Settings → Team → Team memory | — | — | waiting · approved · rejected | [memory](memory.md) |
| task | Tasks tab | `看板`, `可以`, `停`, `/continue`, `/recover` | `agentbox usage --task tN` | open · doing · blocked · review · done · dropped | [tasks and records](tasks-and-records.md) |
| deliverable | task detail → Deliverables | the file arrives in the chat | MCP `fetch_deliverable` | delivered | [tasks and records](tasks-and-records.md) |
| division of work | task detail → Division of work; forks under their thread | — | — | sent · started · fenced · reported · merged · dropped | [tasks and records](tasks-and-records.md) |
| record | Audit tab | — | `agentbox usage`, `audit export`, `scan-records` | append-only | [tasks and records](tasks-and-records.md) |
| approval | the consent card in the chat; Settings → Mine | `允许`, `一直允许`, `本次会话`, `拒绝` | `~/.agentbox/rules` | waiting · allowed · refused · expired | [approvals](approvals.md) |
| credential check | the "Before … can start" card | `… 开始前需要：` | — | missing · expiring · in place | [approvals](approvals.md) |
| routine | Automations tab; Settings → Team → Routines | `定时` | `agentbox routines runs <slug>` | off · observe · auto; paused | [automations](automations.md) |
| goal | Settings → Supervision | `/goal <text>` | MCP `goal_start` | active · verifying · paused · complete · cleared | [supervision](supervision.md) |
| watchdog | Settings → Supervision → Watchdog | a notice in the task's chat | `agentbox watchdog` | on · off | [supervision](supervision.md) |
| supervisor | Settings → Supervision → Start a supervised goal | — | `agentbox supervise` | queued · running | [supervision](supervision.md) |
| MCP endpoint | Settings → Mine → Your MCP tokens | — | `agentbox mcp` | token valid · revoked | [skills](skills.md) |
| Owner (机主) | Settings → Team → People: Owner · 机主 | — | — | Owner · became an Admin | [channels](channels.md) |
| Admin (管理员) | Settings → Team → People: role admin | `bind <code>` | — | viewer · driver · admin | [channels](channels.md) |

## Boundaries

Each line is one thing that looks like another, and where to check which one you have.

- **A running box is not an agent at work:** the box can be up while every agent is idle or
  paused. Check the sidebar: the footer says `box online`, and each agent's row says Running,
  Waiting for you, or `paused`.
- **A finished turn is not accepted work:** a task with acceptance criteria, a due date or an
  outside dependency moves to `review` when its turn ends, and you decide `done`. Check the
  task's history on the Tasks tab: "turn ended; not closed because … — stopped, not verified".
- **An agent's proposal is not agreed work:** a task an agent proposes carries a `proposed`
  chip until a person presses Commit. Check the Tasks tab, with `inbox` on.
- **Importing a template is not a working agent:** the import makes a new agent, which installs
  its recipe on its first turn and asks for what it needs; a group chat reaches it only through
  a channel. Check the agent's chat for the "Before … can start" card, and Settings → Channels
  for its default agent.
- **Observe mode reports and does not act:** a routine in observe records that it would have
  run, and nothing runs. Check the Automations tab: "would have run N times".
- **A saved configuration is not the running one:** a change applies from the agent's next
  turn. Check the chip beside Configure: `config v3 · v4 next turn`.
- **The Owner is not an Admin:** the Owner is the one person of the desktop app on one
  computer; Admins run an installation with more people. Letting a second person in asks
  first, and on yes the Owner becomes the first Admin. Check Settings → Team → People: it
  shows Owner · 机主, or roles, never both.
- **"Always" is not a blanket yes:** it allows that exact action, for that agent, until you
  revoke it. Check Settings → Mine → Standing approvals.

## X and Y: what is the difference?

**Team, crew, and the default agent.** A *team* is a label on agents in one box, so they are
listed together; an agent can be on up to 5 teams. A *crew* is a catalog entry that adds
several agents in one step, as one team. The *default agent* is the one that answers a message
in a channel that names nobody; you set it per channel in Settings → Channels.

**Goal and task.** A *task* is one piece of work on the board, with a state and a history. A
*goal* is a way of working on one task: `/goal <text>` drafts a checklist, keeps going turn
after turn, pauses at its budget, and completes when the check passes. Every goal lives on a task; most
tasks have no goal.

**Skill, template, and a catalog agent.** A *skill* is a `SKILL.md` file in a box: instructions
an agent reads when a request matches. A *template* is a whole saved agent — persona, skills,
routines and conventions — and stamping it makes a new agent. A *catalog agent* (`expert` in the
code) is a catalog entry for one agent with a set of tools and skills; adding it makes that
agent.

**Watchdog and supervisor.** The *watchdog* is on by default and only flags: work that stopped
moving, or a goal the system stopped that nobody looked at. The *supervisor* is optional:
another model that starts a goal for you and watches it to the end. Neither can mark work done,
raise a budget or touch a box.

**Channel and box.** A *channel* is how people reach the agents: one app on a chat platform,
such as a Feishu app. A *box* is where the agents work: a Linux computer with a desktop for
each agent. A channel opens into a box; one box can have several channels.

**Recall and profile.** *Recall* is the tool an agent uses to search what it remembers, by
words and by meaning. Its *profile* (`profile.md` in the box) is a read-only copy of the same
memory, rewritten by the host; an edit there is lost. What agents know about *you* is in
Settings → Mine → About me.

**Approval and tool permission.** A *tool permission* is set before the work: whether an agent
may use a tool at all, or must ask first. An *approval* is the answer to one request, in the
moment. An "ask me" permission is one of the things that brings up an approval card.

## Teams

Whole designs you can copy: who does what, what one real run cost and how that was measured,
how to build the smallest version, and what to watch while it runs.

| Team | What it is for | Agents | Cost on record | Page |
|---|---|---|---|---|
| ship (研发小队) | Code: a spec, a change, a review by somebody else | Mo, Lin, Heng | one reviewer's turns | [ship](teams/ship.md) |
| media-desk (内容小队) | Content: one source as an article, a note and a script | Jian, He, Jing | not measured yet | [media desk](teams/media-desk.md) |
| starter team | Your chat group's first contact, research, machine work and checking | Ada, Rex, Ops, Vera | docs/83's measured episodes | [starter team](teams/starter.md) |

## Pages

Concepts: [box](box.md) · [agent](agent.md) · [channels](channels.md) ·
[templates](templates.md) · [skills](skills.md) · [memory](memory.md) ·
[tasks and records](tasks-and-records.md) · [approvals](approvals.md) ·
[automations](automations.md) · [supervision](supervision.md).

Teams: [ship](teams/ship.md) · [media desk](teams/media-desk.md) · [starter team](teams/starter.md).

Reference, generated from the code: [chat commands](reference-commands.md) ·
[Settings panes](reference-settings.md) · [tools](reference-tools.md) ·
[skills that ship](reference-skills.md) · [template shelf](reference-templates.md) ·
[rules grammar](reference-rules.md) · [prompt parts](reference-prompt-parts.md).
