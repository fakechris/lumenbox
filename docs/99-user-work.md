<!-- doc: 99-user-work
     title: A person's work: requests, work, and what happens inside it
     family: spec
     status: current
     domain: user-work
     updated: 2026-11-12
-->
# 99. A person's work: requests, work, and what happens inside it

2026-11-12 (INV-1824, under INV-1821). This document owns one question: when a person asks an
agent for something, what records exist, who writes each, and what a person is shown. It was
written after two fast rounds of change (INV-1776, the long-run work; INV-1797–1814, attention and
work roots) that each fixed a real failure and together left the idea "work that outlives a turn"
implemented twice, on one table that also held four other things. No document owned the area; the
design lived in handoff notes outside the repository.

It does not replace [docs/74](74-goal-mode.md) (why a goal has a gate nobody on the executing side
controls) or [docs/16](16-long-work.md) (the protocol and the stop). It says where those mechanisms
sit in one model. Where this document and older prose disagree about records and their writers,
this one stands.

## 1. What went wrong, in one paragraph

A turn is not a piece of work, and the system protected turns. An agent with an unfinished request
was woken by an audit, adopted the audit as its plan, and reported the audit complete (INV-1797).
The repair gave every request a durable root and held unrelated messages while it was unfinished —
correct — and then stored the root on the task board, so every chat message became a card; cut the
transcript per request, so a follow-up no longer saw what the last turn read; and left goals, which
are also work that outlives a turn, as a second mechanism with its own identity, status and
recovery. The page then had to show all of it. INV-1822 and INV-1823 repaired the three worst
symptoms. This is the model they were repairs toward.

## 2. Three records

| Record | What it is | Lives | Written by | A person sees |
|---|---|---|---|---|
| **Request** | One thing a person said to an agent: the words, who, where, when. Immutable. | The inbound ledger (`inbox.jsonl`), admitted before the reply is promised | The door that admitted it | The message, in the conversation |
| **Work** | A request that was not settled in its own turn, or that a person made a card for. One identity across turns, slices, restarts and collaborators. | The task board (`tasks.jsonl`) | The work lifecycle (§4), and nothing else | One row: title, who has it, one state, one reason |
| **Activity** | Something that happened inside a piece of work or inside the system: a turn, a tool step, a check, a message between agents, a probe. | The turn ledger, the transcripts, the check and message ledgers | Whatever did it | Nothing by default; the work's process on request; the raw record under diagnostics |

Three rules follow, and each removes something that exists today.

**A request is not work until it has to be.** A question answered in its own turn is a chat
exchange. It is recorded as a request; it has no card. A request becomes work when its first turn
ends with something still owed — a budget line with work done, a tool that was unavailable, a
question back to the person, an unfinished plan, a collaborator's result — or when it produced
something to inspect, or when a person asked for a card. Until the board stops being where roots
are stored (§7, stage 3), the same effect is had by closing the card when the turn settles and
keeping such cards off every list (`answeredInChat`, INV-1822).

**An activity is never work.** A result check, an audit, a probe an agent invents, a message
between agents: each belongs to a piece of work, or to the system, and is recorded as such. None
creates a card. `origin.kind: "internal"` on a task is the mark of a record in the wrong store; new
code does not write one, and `architecture-guard.test.ts` holds that line.

**A goal is work with two more fields.** What made a goal different was never a mode: it was a
budget (how far the host may carry it unattended) and a completion standard (who says it is
finished). Both are fields of work:

| Field | Values | Meaning |
|---|---|---|
| `completion` | `answer` | Finished when a turn ends with the agent's reply. The default for a request. |
|  | `gate` | Finished when the checklist is proven to an independent verifier (docs/74). What `/goal` asks for. |
| `limits` | slices, active time, optional token budget | The ceiling on unattended continuation. Installation default from `longWork`; a person may set it per work. |

Since INV-1823 this is literally how it runs: a request that outgrows its turn is given a pursuit
with `completion: "answer"` and the continuation loop carries it. `/goal` remains, as the way to ask
for the gate.

## 3. One conversation, one thread

A conversation is a place. Everything a person says to an agent in one conversation, and everything
the agent did in answer, is one transcript, per context epoch; `/new` starts another. Each piece of
work keeps its own plan, todo list and checkpoints, because a plan is about one objective.

Activities do not write to the person's thread. An audit runs in its own conversation with
read-only tools; a message between agents is handled in a conversation derived from the work it
belongs to. This is the isolation the incident needed. It is achieved by routing what is not the
person's somewhere else — never by cutting the person's thread.

## 4. One lifecycle, two axes, one writer each

Work has an **execution** state and an **acceptance** state. Nothing else is a state of work;
everything else is a reason.

| Axis | States | Writer |
|---|---|---|
| Execution | `queued` → `running` ⇄ `waiting` → `finished` \| `stopped` | The lifecycle module, from facts the host observed: a turn started, a turn ended and how, a dependency opened or closed, a person stopped it |
| Acceptance | `none` → `submitted` → `accepted` \| `changes-requested` | The delivery commands (`submit`, `accept`, `request changes`), each by the party allowed to give it |

`waiting` always carries one reason from a closed list — the person's answer, an approval, a tool or
computer that is unavailable, a collaborator's result, a running command, the next slice, an
interruption — and each reason names what ends it. A wait that nothing can end is a defect in the
list, not a state.

Today the same facts are spread over `Task.status`, the root's `status` and `wait`, the pursuit's
`status`, the delivery record, the check plans and the request states, and `taskStage` reconciles
them for the page. The target is that `taskStage` reads two fields. Until then, the mapping below is
the contract and `taskStage` is its one implementation:

| Shown | Is |
|---|---|
| 进行中 | execution `running`, or `waiting` on the next slice |
| 等你回答 / 等你批准 | execution `waiting` on the person |
| 卡住了 | execution `waiting` on a tool, a computer, or after repeated failure; or a ceiling reached |
| 待验收 | acceptance `submitted` |
| 完成 | acceptance `accepted`, or execution `finished` where nothing was submitted |
| 已停止 | execution `stopped` |

A model ending its turn, a command exiting 0, and a process being killed are observations. None of
them is `accepted`.

## 5. Attention

An agent serves one person's unfinished work in a conversation before anything else addressed to
that conversation. That is custody, and it is the rule INV-1797 established. Three limits keep it
from becoming a lock:

1. **A colleague is answered beside a waiting person, never instead of one.** A message from
   another agent that is not part of the person's work runs on a side lane — one errand at a time
   per agent, in a conversation of its own — and only while the person's work waits on something
   outside the agent: the person's answer, an approval, a tool, a colleague's result. While one of
   the person's turns is running, or their work is between two slices of its own, nothing starts
   beside it. When the person's work can move again, the errand in flight is interrupted and tried
   again afterwards; that is not a failure and its sender is not told it was. An errand the host
   did not stamp as part of somebody's work gets a small call budget, so answering a colleague
   cannot spend what the person's work needs. The errand sees none of the person's work — not its
   thread, its plan, nor its card on the board — cannot address the person, and shows nowhere on a
   default surface. Everything else addressed to the person's conversation — a routine's result, a
   notice from the host, an informational note — still waits for it.
2. **A person's new request always gets in.** It moves the focus; the earlier work waits with the
   reason "focus moved" and is resumed, not lost.
3. **Custody ends with the work**, by the lifecycle — not by the model tidying its todo list. A
   plan left unfinished keeps the work open and visible; it does not silence the agent's
   colleagues.

Stopping work is revocation first: the stop is recorded durably, then executors are interrupted,
and anything that arrives late under the old identity is refused. What had already happened in the
world is reported as unknown where it is unknown.

## 6. What a person is shown

Three levels, the same in every context. [docs/92](92-web-ui.md) owns how they look; this section
owns what belongs at each.

| Level | Holds | Reached |
|---|---|---|
| Default | What the person needs to know or decide: a state and a reason per item | Without a click |
| Detail | The substance: the result rendered, progress with where each number came from, the plan, the process in plain language | One click, in place or in the work's panel |
| Diagnostics | The record as it is: tool calls with input and output, tokens and cost per turn, compactions, retries, messages between agents verbatim, identifiers, export | An explicit tab inside the detail; never on a default surface |

Consequences: the only place that asks for a person's attention is the inbox, and it holds only
things a person can decide. A list of work holds work (§2) and nothing else. Records with no
verified source — the residue of earlier versions — are reached from the system page, described as
what they are, and archived in bulk; they are not a view beside the person's work.

## 7. Getting there

Each stage is independently shippable and leaves the suite green.

1. **Done.** The person's thread is continuous; answered requests leave no card; a bad record does
   not stop the host (INV-1822). An ordinary request crosses turn budgets under a ceiling the
   operator sets (INV-1823).
2. **Done: a side lane instead of holding.** A colleague's errand runs beside a person's waiting
   work and yields to it (§5); the hold remains for what must enter the person's thread. Scenario: a person's work waits on a tool; a colleague's unrelated message is
   handled; the person's plan and context are unchanged.
3. **One writer.**
   - **Done: the card follows the root, and the three records are read in one place.** A request
     that started is `doing` and one a person stopped is `dropped`, written where the root is
     written (`followRoot`) instead of corrected for by each reader. `work-execution.ts` puts
     `Task.status`, the pursuit's status and the root's side by side — the root is the
     conversation's focus, so `answered` means released, which a finished request and a parked one
     both are — and an episode that ends with them contradicting each other fails. Nothing new
     creates a card marked internal: the guard test names the two places that still do.
   - **Not done, on purpose: one stored field.** Making the pursuit's and the root's statuses one
     field changes every reader and writer of a goal for no difference a person or an agent can
     see: since the card follows the root and an episode fails when the three records contradict
     each other, they are already one state said three ways. It is done when something needs it.
   - **Done: ended internal records can be archived.** An admin moves them, from the system view,
     to the month's archive beside the ledger (`task-archive.ts`): appended and checked on disk
     before anything leaves the board, and put back with one press. Nothing is deleted.
4. **Requests leave the board.**
   - **Done: an answered request leaves the ledger.** It was already off every list
     (`answeredInChat`). A record carrying a work root was never retired, so every chat message
     stayed in the file for good; a request that was answered or stopped now leaves it a month
     after it closed, for the archive, like any closed card (`closedLongEnough`). Closed records
     past their time are archived, where they used to be dropped.
   - **Not done, on purpose: no record at all for an answered request.** The record is where the
     request's root lives while its turn runs, and how a message delivered twice is recognised as
     the same one (`TaskWorkRoots.prepare`). Promotion instead of create-then-retire would move
     both elsewhere and buy nothing a person sees. If it is taken up, the inbound ledger has to
     carry the root and the duplicate check first.
5. **Done.** The page is rebuilt on the three levels (INV-1825) and is the one a person gets;
   [docs/92](92-web-ui.md) is its rule.

## 8. What this document refuses

- A second store that mirrors the board "for the new model". There is one table of work; it gets
  smaller.
- Deciding what is internal from a title, or what is a person's from a flag the model can set.
  Provenance is host-issued.
- A status the page computes for itself. The page reads; `taskStage` decides.
- Unbounded unattended spend. Every continuation runs under a ceiling a person chose or accepted
  (`longWork`), because the model budget is the operator's own.
