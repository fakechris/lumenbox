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

**R5 — A long task must be able to finish.** Real work does not fit in one context window or
one uninterrupted connection. A system that only completes tasks short enough to fit is a
demo, and every mechanism in §F8 exists because a specific way of not finishing was observed.

**R6 — What was learned once must not have to be learned again.** An agent that has to be
told the same constraint every conversation, or re-derives the same procedure every week,
costs its owner the thing it was supposed to save. This is what §F6 and §F7 are for.

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
- F2.7 An agent's tools are part of what it is, and no agent can widen its own set or
  hand a colleague one it does not hold.

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

### F6 Memory

- F6.1 An agent keeps facts across conversations, and what it keeps is bounded.
- F6.2 What reaches the prompt is a selection under a budget, and omissions are stated.
- F6.3 A fact kept deliberately outranks one inferred automatically, and outlives it.
- F6.4 The same fact in different words does not accumulate.
- F6.5 What one agent learns about the person can be shared with the others without being told
  four times.
- F6.6 Nothing an agent has kept is lost by upgrading how memory is stored.

### F7 Reuse

- F7.1 A procedure worked out once can be saved, and is readable and editable by a person.
- F7.2 An agent is told which procedures exist without their contents entering every request.
- F7.3 A saved procedure may run on a schedule, with no person present.
- F7.4 A scheduled run is recognisable as one by the agent running it.
- F7.5 A scheduled run cannot overlap itself, and a missed window is not silently replayed.

### F8 Finishing

- F8.1 A conversation that outgrows the context window is compacted, and the compaction is
  reported rather than silent.
- F8.2 What an agent is trying to do — its plan and its remaining work — survives compaction.
- F8.3 The material compaction removed remains readable, by the agent as well as by a person.
- F8.4 A turn that outgrows the window mid-flight recovers rather than failing.
- F8.5 A failure a retry could fix is retried; one it could not is not.
- F8.6 A turn that runs out of rounds is distinguished from one that is repeating itself, and
  the two are reported differently.
- F8.7 A turn always ends with something said, including when there is nothing to report.

### F9 Tenancy and control

- F9.1 A box can be allocated per tenant on demand, and finding an existing one is idempotent.
- F9.2 A tenant is a team: several people share one box, and the box knows which of them is asking.
- F9.3 A person can be granted read-only access.
- F9.4 Administration is authorised separately from use, and every mutation is audited before it
  is attempted.
- F9.5 The provider credential need not be present inside a box.
- F9.6 What a box spent is measurable outside it.

### F10 Coordination

Agents here overlap in time and share one box, one work directory and one set of desktops. That
makes this a concurrent system, and the failures it produces are the ordinary ones — stale reads,
lost updates, write-write races, non-idempotent replay — wearing the costume of "the agents
miscommunicated". They are not fixed by asking the model in a prompt to avoid stepping on anyone;
a rule that is not enforced somewhere is a suggestion.

A second thing this section takes as given: **the other writer is not always another agent.** A
person pressing stop while a summariser runs, and a person uploading a file an agent is reading,
produce the same anomalies with a single agent in the system.

- F10.1 A message's acknowledgement says what it actually promises. "Sent" that means "queued and
  recorded" must not be indistinguishable from "read" or "acted on".
- F10.2 Work claimed by one agent cannot be claimed by another while the claim holds, and a claim
  survives the process that made it.
- F10.3 Two writers to the same file are detected rather than silently resolved by whoever writes
  last.
- F10.4 An action whose result was never recorded is reported as *unknown*, never as failed and
  never as done.
- F10.5 What happened across agents can be put in order after the fact, well enough to say which
  action preceded which — otherwise a failure in a team of agents has no author.
- F10.6 Nothing an agent reads — a teammate's message, a file, a fetched page — is executed as an
  instruction merely because it is phrased as one.
- F10.7 A turn interrupted by the process ending is resumed or reported, not silently lost, and a
  turn that keeps ending the process is reported rather than retried.

### F11 Organization

The system is not one person and one agent. Several people and several agents share it, over
several channels, and "who did what, on whose behalf, and who may" has to have answers that are
objects rather than assumptions.

- F11.1 **Conversations.** An agent's context is per-room: the team room the web page and teammates
  share, and one thread per outside chat. Two rooms talking to one agent never read each other, and
  different rooms of one agent may run at the same time.
- F11.2 **People.** A person is a named subject with a role (viewer / driver / admin) and a stable
  id that several channel identities resolve to. Permission is a property of the person; an unknown
  identity is a viewer, so a fresh install is safe.
- F11.3 **Tasks.** Work that outlives one reply is an object with an assignee, a status history, and
  a reviewer whose acceptance is what "done" means — the one place the board is enforced rather than
  advisory.
- F11.4 **Credentials.** A secret is granted to a holder with an optional expiry, used only where it
  never enters the box, and every use is audited. No read path returns a value.
- F11.5 **Reach.** An agent can reach the host machine (a device, a host CLI) only through an
  explicitly enabled door, and only with a person's per-command approval.
- F11.6 **Channels.** The agents are reachable from a chat channel, closed by default, with the same
  gates as every other way in.
- F11.7 **Attribution.** Spend and audit are attributed to the person who drove the work; work
  nobody drove is grouped separately, and the parts sum to the whole.

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

### N6 Cost and consent

- N6.1 A turn can be stopped by a person, and stopping it stops its tools as well as its next
  model call.
- N6.2 Spend can be bounded, and the bound refuses before spending rather than reporting after.
- N6.3 How often agents may wake each other is bounded.
- N6.4 A named action can require a person's consent, and that consent covers the exact action
  shown to them and nothing else.
- N6.5 Every decision to allow or refuse is recorded before the thing it decides about happens.

No default budget is a deliberate answer to N6.2 rather than an omission: a number invented here
would surprise whoever hit it, and an agent that stops mid-task because of a guess is worse than
one that spends visibly. The mechanism is the requirement; the number is the operator's.

### N5 Operability

- N5.1 One command creates a working box.
- N5.2 Configuration that changes per run is environment; configuration decided once is a file.
- N5.3 State that must survive lives outside the container, and is named in the docs.
- N5.4 Logs are bounded.

## 5. Out of scope

Deliberately, with the reason. Two things that used to be here have since been built, and are
now F9 — recorded because a requirements document that quietly absorbs its own exclusions is
not one anybody can check against.

- **Cluster scheduling.** One host, one container per tenant. Placement across machines,
  admission and bin-packing belong to an orchestrator, and the allocator seam exists so that is
  a substitution ([08-control-plane.md](08-control-plane.md) §4.2).
- **Anything on the person's own machine.** No shell, no filesystem, no keychain outside the
  box. Three capabilities genuinely need it — proxying a passkey ceremony, holding credentials
  in an OS keychain, reaching a real project directory — and each needs a local agent, which is
  the largest attack surface this system could acquire. Researched and deliberately not built.
- **Verifying that an action achieved what the agent claims.** Provenance (F4) makes a claim
  checkable; nothing checks it automatically. The criteria have to be designed rather than
  copied, and a review that cannot say why it passed is worse than none.
- **Semantic retrieval.** Memory recall and history search are word overlap. The trigger for
  revisiting is written down ([05-data.md](05-data.md) §7) so the decision is falsifiable rather
  than a preference.
- **Model training or evaluation.** This runs agents; it does not measure them.
- **A general remote desktop.** The desktop exists to be driven by an agent and watched by
  its owner.
