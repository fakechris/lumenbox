<!-- doc: 89-thesis
     title: The design of LumenBox: a team of agents, real machines, and one record
     family: decision
     status: current
     updated: 2026-11-01
-->
# The design of LumenBox: a team of agents, real machines, and one record

> English · [中文](89-thesis.zh.md)
>
> This is for someone who has never used LumenBox. It covers the problem LumenBox solves,
> why it is layered the way it is, which decisions set its character, which paths it refuses,
> and how far it has come. It is about design, not features; each mechanism has its own document.

## 1. The problem: a single-session agent does not add up to a team

Over the past year, coding agents have shown that a model can do complex work with tools and
needs a person watching each step less and less. But the basic unit of a mainstream agent is
still **one session**: one person, one terminal, one task, until it is done. Wire it to a chat
app, a calendar and email, and it can receive messages, but nothing essential changes. It is a
synchronous loop that a long operation blocks. The context of several tasks is mixed in one
window. It stops when the laptop lid closes. And every time, a person has to speak first.

What we want is not a smarter session. We want **a group of colleagues a team can rely on over
time**. They have their own machines and are always online. People assign work from wherever
they already are: the desktop app, a Feishu or DingTalk group, a webhook. The agents say when
they are done, ask when they cannot finish, and leave evidence when they get something wrong.
And the team's boundaries, meaning who can reach what and what must be asked first, are held by
the system rather than by wording.

That turns "how do we make the model better at doing things" into four plainer questions:

1. On **which machine** does it work, and who can reach that machine?
2. **Who** should do a piece of work, and can they be interrupted and corrected while doing it?
3. **May** it do this? Who authorised it, and how far does that authorisation go?
4. When it says "done", **why should anyone believe it**?

Every layer in LumenBox exists to give one of these questions exactly one place where it is answered.

## 2. Three units

- **box**: a real Linux machine, either a local container or a remote machine you attach.
  Inside it, every agent has its own desktop, browser, shell and files. It is not a sandbox but
  a workstation: the agent has sudo, can install things, open Chrome, and run a job all night.
- **turn**: an agent receives one thing (a message, a schedule, an event), thinks, uses tools,
  and stops. An agent has one turn at a time per conversation. A turn can put a long command in
  the background and be woken when it ends.
- **record**: what each turn **actually did**, kept as data rather than as the agent's summary of
  itself. Tool calls, the evidence of desktop actions, receipts for outgoing messages and the
  verdicts of policy gates are all on the record. The agent's report is a paragraph beside it.

Assigning work, agents working together and the system's verdicts all revolve around these three.

## 3. Four layers, each answering one question

```
 person ─► doors ─────────► host orchestrator ─────► box ───────────────► outside world
           who is speaking,   whose turn is this,     did the action land,   credentials stay put,
           to whom            may it, what happened   is a person using it   was egress refused
```

| Layer | What it owns | What it explicitly does not do |
|---|---|---|
| **Doors** (desktop app, Feishu, DingTalk, Telegram, webhook, MCP) | Identity, address, message ids, the inbound ledger; the **purpose** of each outgoing message (result, question, answer, acknowledgement, notice) and its receipt | No routing decisions, **no authority**, no rewriting |
| **Host orchestrator** (on the owner's machine) | The turn loop, the message bus and priorities, the team roster (the one definition of which box belongs to which team), prompt assembly, memory, the skill index, the task board, work mandates, policy gates, budgets, the goal loop | Does not run tools itself, does not touch pixels, does not keep the agent's self-summary |
| **Box** (one desktop per agent) | Desktops, browser, shell and background jobs, files, recordings, the accessibility tree, desktop ownership (when a person takes over, the agent must stop), measuring the effect of actions | Does not decide whether to act (that is the gate one layer up), keeps no conversation state |
| **Egress** (the relay) | Credential injection (the agent never sees the value), blocking after the destination is resolved, one credential per call, a record of refusals | Does not understand content |

Why these four layers rather than the familiar "one routing brain plus many workers"? Our
bottleneck was never message volume. It is **authority and evidence**. Pin "who can reach what"
to the box (doors carry no authority, and agents in one machine are equal in reach). Pin "did it
really happen" to the box and the record. Then everything else can change freely: switching
models, moving a box from local to remote, swapping Feishu for DingTalk, none of these touch the
other three layers. The four layers share one contract: JSON over HTTP, plus one WebSocket for
watching screens.

## 4. Where work comes from: events, not prompts

For a team that is always online, most input is not a sentence someone typed. It is what keeps
happening around it: group messages, email, calendars, CI results, a routine that has come due.
LumenBox treats all of them as **triggers** on one path.

**Filter first, then judge.** Cheap, certain decisions are made in code: whether this group is
listened to, whether this person is on the list, whether this message names someone. Only what
passes code goes to a model to decide whether to act. The model's rules can be changed in plain
language at any time; the code's rules cannot be talked around.

**A thread belongs to whoever is working it.** Follow-ups in a topic thread, a pull request or an
email chain do not go back to the centre to be reassigned. They go straight to the agent already
doing that work, which either carries on or hands it back with a one-line reason; only then is
the message routed again. A group chat without threads does not get this treatment: a group is
not a subscription.

**Observe mode.** Anything that acts on its own (a listener, a scheduled routine, a webhook) has
three settings: `off`, `observe` and `auto`. Observe only records what it would have done. A team
can watch for a week what it wants to do before letting it.

**Act first, speak after.** Under a policy such as "quietly reproduce and fix", an agent may start
in the background and speak only once it has a confirmed result; if it cannot confirm, it stays
quiet. This is speculation within budget, not a promise.

## 5. Context: the window is a cache

A model's context window is finite. Fill it and attention is diluted; starve it and the model
keeps calling tools to re-read. We treat the window as a cache.

- **Summaries and pointers first, expanded on demand.** History, long output and skill bodies do
  not go into the window directly. What goes in is one line of description and a readable
  pointer. The skill index holds only "when to use"; the agent opens the body itself. A read that
  is too long is cut and leaves a pointer saying where to continue.
- **Memory is selected, not carried whole.** Each turn picks a small set of memories for the
  request and asks once more whether that is enough and whether any of it misleads. Each memory
  carries scores for being an event, a fact, a procedure or a preference, so "how do I" leans
  toward procedures and "what does this person like" leans toward preferences.
- **Each turn records which version of the agent it ran under.** The persona files, skill
  descriptions and built-in rules each have a hash written into the turn's record. "Did it get
  better after we changed the prompt" becomes a question you can replay, not a feeling.

## 6. Interaction: full duplex, and each channel has its own manners

**Long operations do not block the conversation.** A command that runs more than a few seconds
moves to the background and the turn ends; when it finishes, it wakes the agent as a message. A
person's message always has a slot of its own and never queues behind background work. A turn
in progress can be interrupted by a person's correction and take it in.

**Where and how to speak depends on the channel.** In a group: conclusions only, direct questions
only, and interrupt only when a decision is needed. In documents and pull requests: structured,
dense output. More importantly, **outgoing messages pass a gate**. A "result" must carry a
deliverable, a "question" must have something open to answer, and an "answer" must match a
question a person actually asked. What fails is not sent. Every outgoing message has a
deterministic id and a receipt, so a retry never sends twice; three failed deliveries become
something for a person to look at, not a line in a log.

**A person can always take over.** You can take over a desktop, and while you hold it every input
from the agent is refused and it has to wait. Taking over is also teaching: you do it once and the
agent learns it as a skill with parameters, which it only dry-runs and never runs on its own.

## 7. Machines: how compute, state and execution environment are split

The usual approach puts the agent's loop, its session state and its execution environment in the
cloud, then tries to sync a person's local environment up to it. We do the opposite.

- **The execution environment is the box, and it stays with its owner.** Whether a local container
  or a remote machine you attach, uncommitted changes, internal dependencies and private
  credentials stay where they already are. The orchestrator uses it through a lightweight daemon
  that keeps no session state.
- **State is files.** An agent is a directory, a conversation is an append-only file, and the
  record is JSONL. An agent reads a teammate's files with the same shell; a person can read them
  in an editor; a backup is a copy of the directory.
- **The orchestrator stays on the owner's machine.** This is deliberate: the owner's machine is the
  trust boundary. Moving the loop to the cloud means answering "who can reach what" all over
  again. To use your own box from outside, the answer is the outbound relay, where the box dials
  out with end-to-end encryption, not moving the box into the cloud.
- **Boxes have generations.** After a machine is rebuilt or reconnected, slow callbacks left by the
  previous generation (a job's "finished" wake-up, a routine's delivery) do not land on the new
  machine; they are dropped with one log line.

## 8. Authority: two gates, and no third

This is the hardest rule in the system.

- **The outer gate belongs to the installation.** Are you one of us, and may you manage this system.
- **The inner gate belongs to the box.** Whatever the holders of a machine can reach, everything in
  it can reach. Channels carry no authority and agents carry no authority. Two agents in one
  machine may differ in persona, model and duties, but **are equal in what they can reach**. A
  secret that one agent can touch and its colleague cannot is a modelling error: the secret is in
  the wrong machine.
- "Private" and "shared" are not two kinds of thing. They are the size of the holder set: one
  person, one department, everyone. One concept, one check.

Above these two gates, three more things are not governed by the agent's wording. **Work
mandates** say who asked for this, on what grounds, how far it may go and under which policy
version; they are re-checked before waking and before resuming, and a policy change makes the
agent stop and ask. **Policy gates** ask a person before irreversible actions such as paying,
sending, deleting and publishing, and ask before sending anything outside the allow-list after
private material was read. **Budgets** cap attempts, time and cost; at the line the work stops
and reports.

## 9. Evidence: why believe "done"

- Desktop actions carry **effect evidence**: the change in nearby pixels before and after a click,
  a read-back of the accessibility tree, a postcondition a person wrote. There are only four
  outcomes: succeeded, failed, refused, unknown. **Unknown is never success**, and a write is
  never retried automatically.
- Every desktop action also carries a **delivery verdict**: not sent, partly sent, sent but not
  verified, sent and a change seen, or don't know. Only "not sent" may be sent again as it was.
  Clicking a toggle twice undoes it, so judging idempotency by the kind of action is wrong; it has
  to be judged by this attempt's evidence.
- References to controls have **identity**. Before a click the screen is re-read and the control
  re-identified; if it has gone the click is refused rather than landing on whatever row moved
  into its place, and if there are two identical ones it is refused too.
- Pages and files cited in a report must have been read in this turn, or they are flagged.
- Every reply gets a cheap review label: answered, not answered, narrated the process instead of
  the result, or mixed up contexts. Bad examples become test cases automatically and can be
  replayed after the prompt changes.

## 10. Watchdogs: how long runs stay on course

A system that is always on cannot rely on its own internal logic. It needs a control loop from
outside.

- **Goal mode** has four stops: several rounds with no work done, several rounds with nothing
  changed, a cap on attempts, and a cap on time or cost. At the line it pauses and reports rather
  than stopping silently. Continuing runs keep an **experiment ledger** recording the hypothesis
  each round tried and how it went. Two rounds repeating an old hypothesis pause the run; having
  no new hypothesis is reported as blocked. "Done" is not for the worker to say: another session
  checks the checklist.
- **The attention table** derives mechanically, from one mutually exclusive and exhaustive table,
  who each piece of work is waiting on and for what: awaiting delivery, awaiting an answer,
  awaiting acceptance, stuck, queued, working, waiting for a trigger, finished. It sits on the
  first screen, so a person sees at a glance what needs them.
- **The check-up** is one command. It reads an agent's definition, generates a set of scenarios
  that always includes four edges (empty input, ambiguity, out of scope, must refuse), runs them
  for real in isolated conversations, scores them, and writes a proposed change to the agent's
  persona files. **It is never applied automatically.**

## 11. The decision model: cheap judgments behind switches

Besides the main model that does the work, the system has a cheap "decision model" that only
answers yes/no and multiple-choice questions. It is used at about a dozen points: which memories
are worth bringing, whether a reply actually answered, whether a routine's result should be
delivered, whether the button about to be clicked looks like "pay", which element in a list to
pick. Each point has its own switch: `off`, `shadow` or `on`. Shadow writes its judgment next to
the main path for comparison without changing behaviour. Two firm rules: **unset means off**, so
it never quietly makes a remote call; and **it never produces text to be typed**, because it reads
too literally and would take words on a page as instructions.

## 12. Decisions that set the character, and the paths refused

| Decision | Why | What was refused |
|---|---|---|
| One desktop per agent | Focus is what synthetic input follows; a shared display will collide | Routing windows on one display |
| The file system is the database | Agents and people read it the same way; a backup is a copy | A database |
| The box is the unit of authority; agents in a machine are equal | A difference in authority means a secret is in the wrong machine | Per-agent permission sets, per-channel authority |
| No shared volumes, no sync daemon, no "one agent, two machines" | Each one is a second authority hidden inside a worker | A second authority |
| Routing is code, not a long-lived "routing session" | A global node with memory grows into a third layer of authority | A global routing brain |
| The orchestrator stays on the owner's machine | That is the trust boundary | Moving the loop to the cloud |
| A plan is data, not code | A model-written script has no boundary; a real sandbox is one more runtime | Model-written scripts run in a sandbox |
| "Done" is verified by another session | Self-review is where stopping passes for finishing | Agents marking their own work done |
| Built-in rules can be overridden by the team; gates cannot | Teams want their own wording, but authority is not wording | Everything is a prompt |
| Safe by default | One extra question costs a sentence; a duplicate payment costs money | Optimistic defaults, automatic retries |
| Third-party desktop tools may run, but not as a product channel | They bypass the box daemon, so no gate and no record sees them | A side channel for execution |
| Not a hosted service, not an autonomous fleet, not a sandbox for untrusted code | One box, one team, one owner; the container is the boundary and the agent has sudo | — |

The paths refused matter as much as the ones taken: they are the answer the next time someone
proposes the same idea.

## 13. Where it stands

| Stage | What it covers | Status |
|---|---|---|
| Trustworthy releases | Pinned versions, signing, pinned engines, first-launch acceptance | Done; macOS notarization in progress |
| One person: from authorised material to an inspectable product | Turn engine, tool set, record, effect evidence, writing to office suites | Done |
| Teaching and reuse | Take-over as teaching, template export and import, skill contracts | Done |
| Safe use by a small team | Two gates, mandates, outgoing purpose and receipts, the attention table, audit | Mechanisms in place; consistent multi-user identity still open |
| Autonomy and self-improvement | Observe mode, the goal ledger, reply review to test cases, the check-up, decision-model points | In progress: mechanisms in place, comparison data not yet sufficient |
| Collaboration across installations | An outward MCP surface, capability cards, the outbound relay | Candidates, waiting for real demand |

## 14. Three sentences

- **Write the record before the capability.** A capability without a record is a liability here:
  it gets claimed, never proven.
- **Draw boundaries in code; let the team change the wording.** Gates, budgets and refusals live in
  code. Tone, order and "what counts as done" live in text the team can override.
- **When you can stop and ask, don't guess.** An unnecessary question costs one sentence; a wrong
  guess at sending, paying or deleting cannot be taken back.
