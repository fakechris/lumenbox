<!-- doc: 02-product
     title: Product
     family: spec
     status: current
     domain: product
     updated: 2026-11-06
-->
# Product

## 1. What it is

> **Your own team of AI agents, each with a real computer to work on — reached from your
> desktop and your chat apps, taken over at any moment, and believed on the record, not on
> its word.**

That sentence is the product's definition. The README, the operator's guide
([38](38-operators-guide.md)) and `package.json` repeat it; a change to it starts here.

The unit is the **box**: a Linux machine with a graphical desktop per agent, a browser, a
shell, and a daemon that lets an orchestrator drive all of it. The unit of work is a **turn**:
an agent receives something, thinks, uses tools, and stops. The unit of trust is the
**record**: what each turn actually did, stored as data rather than as the agent's summary of
itself.

### 1.1 How it differs

Each row is something the other two shapes do not give you by default — not a feature we also
have. The LumenBox column says where each claim is held to account.

| | LumenBox | A single coding-agent CLI | A hosted agent platform |
| --- | --- | --- | --- |
| **The computer** | A persistent Linux box with a desktop *per agent* — browser, file manager, terminal — that outlives any session; local Docker or attached elsewhere ([03](03-architecture.md), [30](30-multi-box.md), `docker/box/Dockerfile`, `src/boxd/displays.ts`) | The developer's own machine, borrowed for one session; no screen of its own | A sandbox the vendor runs per session, usually headless, gone when the session ends |
| **Where you reach it** | The app, and doors in the chat apps a team already uses — Feishu, DingTalk, Telegram — plus MCP and webhook routines; one person across every door, so an approval given in one counts in another ([22](22-domain-model.md), [48](48-identity-consistency.md), `src/channels/identity.ts`) | The terminal it was started in | An API and a console; the front end is yours to build |
| **A team, and taking over** | Several named agents that message, delegate to and create each other (`SendToAgent`, `Delegate`, `CreateAgent` in `src/host/tools.ts`); a person takes a desktop over and the agent's writes are refused until it is handed back, and what the person did becomes a lesson (`takeOver` in `src/boxd/displays.ts`, `src/boxd/teach-service.ts`) | One agent per session; sub-agents live and die inside it; taking over means interrupting it | Agents as API objects; there is no shared screen to hand over |
| **The record** | Every turn's tool calls and results kept as data on the machine the installation runs on, readable after the fact and across restarts ([05](05-data.md) §1, §4 below) | A transcript of one session, on one laptop | Session history held by the vendor |
| **Who says "done"** | The person, for anything someone will check: a task with acceptance criteria, a date or an outside dependency waits in review when its turn ends instead of closing; with a reviewer named, the assignee cannot accept its own work; "可以" / "收到" in the chat is the acceptance (`turnFinished` in `src/host/tasks.ts`, [20](20-completion-standard.md), `src/channels/verbs.ts`) | The agent, when it stops | The run's status, set when the run ends |
| **Where it runs** | One machine by default — a laptop, or a server for a company — with a multi-tenant control plane as an option, never in the path of a turn (§5, [08](08-control-plane.md), [36](36-enterprise.md)) | The developer's machine | The vendor's cloud |

## 2. Surfaces

### 2.1 The web UI

Three panes, which correspond to the three questions a person has.

| Pane | Question | Contents |
| --- | --- | --- |
| Left | Who is working? | Agents, with a busy indicator and their desktop number |
| Middle | What did they do? | The conversation: prose, collapsed tool calls, teammate messages |
| Right | What is happening now? | The selected agent's live desktop, and activity across all agents |

Decisions worth stating, because each was a correction:

- **The desktop never scrolls away.** Each column scrolls inside itself. Reading back through
  a conversation used to move the screen out of view, which is the one thing that must stay put.
- **Tool calls are collapsed.** A turn can make dozens and each result can be pages long;
  expanded by default, the conversation becomes a log with the reasoning buried in it.
- **A teammate's message is a one-line notice, not a bubble.** The scaffolding an orchestrator
  writes for a model is not something a person should read, and the message itself is one line.
- **Activity survives a reload.** It is kept outside the page, because coming back to see what
  happened is exactly when the page is new.

### 2.2 The desktop

A desktop someone recognises: wallpaper, icons, a dock, a real terminal, a real file manager.
This is not decoration. An empty grey screen is indistinguishable from a broken box, and
"looks broken" is the first conclusion anyone draws. It also gives a vision model landmarks.

The person can use it while the agent does — same screen, same keyboard, no handover ritual.

### 2.3 The CLI

For the operator and for scripting: create and destroy boxes, take a screenshot, run a
command, talk to an agent, serve the UI, run the egress relay. The CLI is the developer's
surface; in the self-contained topology the box carries its own orchestrator and the CLI is
not required to run anything.

### 2.4 The agent's own surface

The tools an agent has, and the fact that a tool's error message is a product decision.

The list is not kept here, because a hand-kept list is how this section came to name seven
tools when there were fifty. The registry is `buildTools()` in `src/host/tools.ts`; what each
tool does to the world — its side-effect tier, and the phrase on its consent card — is
`DECLARED` in `src/host/side-effects.ts`, and `side-effects.test.ts` fails when the two lists
disagree. A generated tool reference is to be drawn from those two (INV-1661). For scale: 52
tools on 2026-11-06 with every capability on, grouped as the desktop and browser, the shell
and files, the team (messages, delegation, new agents, tasks), memory, and the doors.

Inside the box, outside the tool list, are the commands a person and an agent share:
`box-doctor` (ask the computer what is wrong with it) and `box-clip` (the clipboard, from
the shell), both in `docker/box/`.

## 3. Flows

### 3.1 A person asks for something

1. They type into the middle pane.
2. The agent's turn starts; the right pane shows tool calls arriving as they happen.
3. Prose streams into the conversation; tool rows appear collapsed.
4. If the agent hands work to a teammate, a notice appears and the teammate starts its own turn.
5. The turn ends. The conversation holds what happened, including what the tools returned.

### 3.2 A person takes over

1. They select the agent whose desktop they want.
2. They click into the live view and use it.
3. The agent keeps working; its desktop is its own, so nothing is contended.

### 3.3 A person reviews afterwards

1. Activity, replayed with timestamps, says what happened and when.
2. The conversation, replayed, says what each agent did — tool calls with their real inputs
   and results, not the agent's account of them.
3. A recording, if one was made, says what the screen looked like while it happened.

### 3.4 Something is wrong

1. `box-doctor` names the broken part — a person runs it, or the agent does.
2. `/health` says which components are degraded and whether any were abandoned.
3. Crash records say what died unsupervised, and how.

## 4. What makes it good

Four properties, in the order they matter:

1. **The record is trustworthy.** Tool traffic is stored as data. An agent cannot claim work
   it did not do, because the claim and the evidence are different things.
2. **Failure is loud.** Silent breakage is treated as a defect of the same severity as a
   crash. Half the machinery in here exists because a failure was quiet once.
3. **Agents do not interfere.** One desktop each, one turn at a time each, priority when it
   matters.
4. **A person is never locked out.** Of the desktop, of the box, or of their own data.

## 5. Where it runs, and what it is not

**One machine is the default; the control plane is optional.** A personal installation is one
person, one installation, its first box local — the degenerate case of the multiuser model,
needing nothing turned on. A company runs the same core as a server: doors that log people
in, a directory, boxes with member sets, more boxes by attach ([36](36-enterprise.md) §0, §3;
people and their identities are [22](22-domain-model.md)). The multi-tenant control plane
(`agentbox control up`, `src/control`) is a separate, optional layer for hosting many
installations: it allocates boxes, authenticates people and meters use, and is never in the
path of a turn ([08](08-control-plane.md) §1). A single company does not need it.

- Not a service you must sign up for. Nothing here requires an account with us; the
  control plane is something an operator chooses to run.
- Not an unsupervised fleet. Agents work for named people, ask before what their tier says
  needs asking, and work someone will check is closed by that someone, not by a turn ending.
- Not a sandbox for untrusted code. The container is the boundary and the agent has `sudo`
  inside it; nothing in the box should be anything the owner would not hand to the model.
