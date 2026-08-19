# Requirements

Written from what the system is for, not from what it currently does. Where the two differ,
the gap is a finding for [07-review.md](07-review.md) rather than a softened requirement.

## 1. Problem

An agent that can only read and write text is limited to work that has an API. A great deal
of real work does not: an internal tool with no API, a site that requires a login and a
click-through, a PDF that has to be opened, a form that has to be filled. Giving a model a
computer removes that limit, and introduces four problems that define this system.

**R1 — The computer must be real, and disposable.** Real, or the work does not transfer:
a real browser, real fonts, a real window manager, real files. Disposable, because an agent
will install things, break things, and occasionally be wrong in ways that should not reach
anyone's laptop.

**R2 — A person must be able to watch and take over.** Not as a debugging aid: watching is
how anyone decides whether to trust the thing at all, and taking over is how a stuck task
gets finished rather than abandoned. This is a product requirement, not an operator one.

**R3 — Several agents must work at once without corrupting each other.** Synthetic input
goes to whatever holds focus, so two agents on one screen type into each other's windows and
screenshot each other's work. Isolation has to be structural, not a convention.

**R4 — What an agent claims must be checkable.** A model that reports success it did not
achieve is worse than one that fails: the failure is silent and compounds. The record of
what happened must not be the model's own account of it.

## 2. Users

| User | Wants | Cares about |
| --- | --- | --- |
| **Operator** (runs it) | A box that starts, stays up, and says what is wrong | Failure being loud, upgrades not destroying data |
| **Reviewer** (accepts the work) | To see what the agents did and to intervene | Latency of the view, honesty of the record |
| **Agent** (does the work) | A computer that behaves predictably | Errors naming the cause, not the symptom |

The agent is a user. Most defects in this system were failures of the agent's experience —
an opaque error, a dialog with no way past it, a screen it could not read — and they cost
turns, money and trust.

## 3. Functional requirements

### F1 Computer

- F1.1 A graphical desktop with a window manager, a browser, a terminal and a file manager.
- F1.2 Synthetic input: pointer, keyboard, chords, drag, scroll.
- F1.3 Text entry for any character, not only ASCII.
- F1.4 Screen capture, at a defined resolution, that decodes.
- F1.5 Window enumeration, activation, per-window capture, and clicking in window coordinates.
- F1.6 A shell with working directory and environment that persist across calls within a session.
- F1.7 File read, write and list, independent of the shell.
- F1.8 A clipboard readable and writable from outside the box.

### F2 Agents

- F2.1 Multiple agents, each with an identity, a persona and its own conversation.
- F2.2 Asynchronous agent-to-agent messaging; a message wakes the recipient's own turn.
- F2.3 Priority messages that interrupt work that is not user-driven.
- F2.4 One turn at a time per agent, whatever wakes it.
- F2.5 Agents may create agents, and may not delete or overwrite each other.
- F2.6 Each agent has a desktop no other agent can drive.

### F3 Observation and control

- F3.1 A person can watch any agent's desktop live and use it with keyboard and pointer.
- F3.2 Watching one agent must not stop the others working.
- F3.3 The conversation is readable as a conversation, including tool calls and their results.
- F3.4 Recent activity across all agents survives a page reload and a process restart.
- F3.5 A desktop session can be recorded and replayed.
- F3.6 The box can be asked what is wrong with it, by a person or by an agent.

### F4 Provenance

- F4.1 Every tool call and result is persisted as data, not as prose.
- F4.2 The persisted record is not writable by the agent it describes.
- F4.3 Screenshots are excluded from the persisted record; their presence is noted.

### F5 Lifecycle

- F5.1 A box can be created, stopped, restarted and destroyed.
- F5.2 Restarting must restore a working desktop.
- F5.3 Upgrading the image must not destroy the agents' work or their logins.
- F5.4 Where a box comes from must be replaceable without touching the agent runtime.

## 4. Non-functional requirements

### N1 Latency

- N1.1 A screenshot returns in under 300ms at 1280x800, idle.
- N1.2 An agent saturating the box degrades N1.1 by less than 50%.
- N1.3 The live view updates within a second of the screen changing.

Why these numbers: a turn contains tens of captures, so capture latency multiplies, and the
live view is how a person decides whether to intervene — a stale screen is worse than no
screen, because it invites acting on the past.

### N2 Availability

- N2.1 No single process crash may destroy another component's state.
- N2.2 A component that cannot stay up is abandoned and reported, not restarted forever.
- N2.3 A crash of anything unsupervised is recorded.
- N2.4 Loss of the agents' work requires an explicit destructive action.

### N3 Isolation

- N3.1 The container boundary contains the agent. Nothing inside it is trusted.
- N3.2 An agent cannot drive another agent's desktop through the ordinary interface.
- N3.3 An agent's shell does not carry credentials it has no use for.
- N3.4 Anything that authorises access must be presentable by a person and not producible by
  an agent.

N3.2 and N3.3 are accident prevention and are documented as such. An agent with a shell and
`sudo` in the same container as another process can reach that process's files; the boundary
is the container, and a requirement that pretended otherwise would be a false one.

### N4 Honesty of failure

- N4.1 A failure names the thing that failed and, where possible, what to do.
- N4.2 A silent failure is a defect of the same severity as a crash.
- N4.3 A check that cannot fail is a defect.

N4.3 earns its place: this system has had three tests that passed while measuring nothing.

### N5 Operability

- N5.1 One command creates a working box.
- N5.2 Configuration that changes per run is environment; configuration decided once is a file.
- N5.3 State that must survive lives outside the container, and is named in the docs.
- N5.4 Logs are bounded.

## 5. Out of scope

Deliberately, with the reason:

- **Multi-user identity.** One secret, no users. A shared deployment needs identities; the
  seam is drawn ([03-architecture.md](03-architecture.md) §7) and the implementation is not
  written.
- **Scheduling boxes.** A box cannot create itself. Placement, quotas and admission belong to
  a control plane.
- **Model training or evaluation.** This runs agents; it does not measure them.
- **A general remote desktop.** The desktop exists to be driven by an agent and watched by
  its owner.
