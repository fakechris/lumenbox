# Product

## 1. What it is

A team of agents with a shared computer, and a window into it.

The unit is the **box**: one Linux container with a graphical desktop, a browser, a shell, and
a daemon that lets an orchestrator drive all of it. The unit of work is a **turn**: an agent
receives something, thinks, uses tools, and stops. The unit of trust is the **record**: what
each turn actually did, stored as data rather than as the agent's summary of itself.

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

The tools an agent has, and the fact that a tool's error message is a product decision:

| Tool | For |
| --- | --- |
| `computer` | Pointer, keyboard, windows, capture |
| `bash` | Shell, with per-agent session state |
| file tools | Read, write, list — independent of the shell |
| `SendToAgent` | Asynchronous message to a teammate, optionally priority |
| `CreateAgent` | A new teammate, when the work needs one |
| `box-doctor` | Ask the computer what is wrong with it |
| `box-clip` | The clipboard, from the shell |

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

## 5. What it is not

- Not a hosted service. There is no account, no billing, no tenancy.
- Not an autonomous fleet. One box, one team, one owner.
- Not a sandbox for untrusted code. The container is the boundary and the agent has `sudo`
  inside it; nothing in the box should be anything the owner would not hand to the model.
