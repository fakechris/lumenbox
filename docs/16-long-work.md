# Finishing long work: the protocol, the cost, and the stop

**Status: the design in section 1 was reviewed and did not survive.** Second hostile review,
2026-08-26: five fatal findings, five major, and ten false claims about our own code — in a
document whose opening paragraph asserted that every claim in it had been read out of the
source. Six of the ten were spot-checked against the files before this rewrite and all six
were the reviewer's, not mine.

The superseded design is kept below under [What was proposed](#what-was-proposed-and-what-it-got-wrong)
rather than deleted, because a design that fails twice in the same place is evidence about
the place. The review itself is in
[docs/reviews/2026-08-26-obligation-ledger.md](reviews/2026-08-26-obligation-ledger.md),
unedited.

**The finding that reorganises everything else:** the missing thing is not a ledger. It is
**one identifier that survives a resume and appears on every record** — usage rows,
transcript entries, task changes, artifacts. Without it there is nothing to join, and a
ledger of obligations is a second file with the same hole in it.

Three questions, one substrate:

1. How does long work *finish* — provably, not by a model's opinion?
2. How is its cost *estimated and bounded* before it is spent?
3. How does it *stop* when it is going nowhere?

---

## What exists today, measured

| mechanism | where | what it actually does |
|---|---|---|
| `MAX_ROUNDS` | `turn.ts:81` | 400 rounds per turn, then stop. A runaway guard, not a task budget — its own comment says so |
| `MAX_RESUMES` | `resume.ts:45` | 2 continuations after an interrupted turn |
| `detectLoop` | `progress.ts:91` | 4 consecutive rounds in which exactly **one distinct** signature appears, no empty round, and `stateHash` unchanged — all three required |
| `hasProgressed` | `progress.ts` | deliberately generous: one todo change in 400 rounds counts |
| `AgentBus.idle()` | `bus.ts:581` | in-process quiescence; `settle()` calls it in production |
| `PolicyGate` budget | `policy.ts` | refuses over `budgetTokens` in a rolling window, per installation and per principal — **tested and working** |
| `Usage` ledger | `usage.ts` | tokens for the **turn loop only**, keyed by agent, `principal` optional |

Two corrections to what this table said in the first version, both from the review and both
confirmed in the source:

- **`detectLoop` does not require one call per round.** It requires one *distinct*
  signature across the window (`progress.ts:96`), so a round that issues the same call
  twice still satisfies it. The earlier phrasing described a narrower check than the code.
- **The usage ledger does not record every call.** There is exactly one `usage.record` call
  site, in the turn loop (`turn.ts:1433`). Model calls in `remember.ts:157` and
  `orchestrator.ts` go through no ledger at all, and `principal` is explicitly optional
  (`usage.ts:34`) — absent for scheduled runs and teammate wakes. So "what did each person
  cost" is answerable for the traffic a person drove directly and silent about the rest.

**And the finding that matters for question 2:**

```ts
budgetTokens: envLimit("AGENTBOX_BUDGET_TOKENS"),          // undefined unless set
perPrincipalBudgetTokens: envLimit("AGENTBOX_PRINCIPAL_BUDGET_TOKENS"),
```

Neither is set. `config.json` has no `policy` block at all. `policy.test.ts:159` asserts
the default is `undefined` and calls that correct.

> **There is no spend ceiling on this installation. There never has been.** The gate that
> would enforce one is built, tested, and switched off.

Measured: **562 recorded calls, 1,725,069 input and 100,177 output tokens** — recorded
being the operative word, since the memory and orchestrator calls are not in that figure
and the file keeps only 48 hours anyway (`usage.ts:79`). Not a large bill, and entirely a
matter of how the day happened to go rather than of anything stopping it.

This is the ninth instance of the pattern in [docs/14](14-from-outside-reading.md) — a
capability present in the source and absent at runtime — and the first where the absent
thing is a *limit* rather than a feature.

---

## 1. The spine: one id that survives

Both questions — is it finished, what did it cost — are joins, and there is nothing to join
on. Verified in the source rather than recalled:

| record | has | file |
|---|---|---|
| `UsageRecord` | seq, at, agentId, agentName, `principal?`, provider, model, round, tokens | `usage.ts:29` |
| turn id | a fresh `randomUUID()` **per attempt** — a resume gets a new one | `turn.ts:818` |
| transcript entry | message ids, not turn ids | `turn.ts:454` |
| background job | a `Map` in the boxd process; nothing survives its restart | `job-service.ts:43` |

So `principal` is optional and absent for scheduled and teammate-driven work; there is no
`kind`, no turn, no conversation, no task on a usage row; and `parentTurnId` — the field the
old design made its spine — **changes every time a turn resumes.** A gate keyed on it sees
none of the obligations opened by the attempt it replaced.

What the four tables want is one field:

```
workId:  allocated once, when a piece of work begins
         unchanged across every resume, retry and continuation of that work
         written on: usage rows, transcript entries, task changes, artifacts, obligations
```

`turnId` stays what it is — an attempt id, useful for exactly that. `workId` is the thing
that is the same in the morning and the afternoon.

This is worth building **before** anything else here and **independently of the gate**,
because it is what makes R31's question ("where did last month go, drill into that task")
answerable at all, and because it is additive: a field on records that are already written.

### Retention pulls the two apart

Termination wants the open set and nothing else. Analytics wants months. Every operational
ledger here already compacts, and the numbers were read out of the source:

- usage keeps a count tail plus **48 hours** (`usage.ts:79`)
- tasks discard closed work after **30 days** (`tasks.ts:77`)
- turn history is erased entirely when nothing is open (`resume.ts:132`)

One file cannot hold both policies. So: **a compact index of open obligations** for the
gate, and **an exported immutable event stream** for the admin view, sharing ids and
sourced from the same events. That is not a compromise between the two, it is the
recognition that they are two.

---

## What was proposed, and what it got wrong

The review's verdict was that a completion gate cannot be built yet, because the graph it
would count over is not recorded. Reading the code confirms each part:

- **No durable fork edge.** `Fork` injects each brief through `sendFromUser`; the child's
  queue entry is marked started before its turn ledger begins; the parent's `tool_use`
  blocks are appended only after the whole batch returns. A crash inside that window
  leaves a child invisible to inbox recovery *and* to turn recovery, with nothing linking
  it to its parent.
- **`Fork` is one level.** The tool refuses a conversation already under `fork/`, so
  depth is exactly one, breadth capped at 12.
- **Work escapes the star.** `SendToAgent` returns immediately while the teammate runs on;
  the bus batches two senders into one turn, making a merge node; `bash --background` and
  `Delegate` return a job id and outlive everybody; a scheduled skill enters through
  `orchestrator.prompt()` as an independent turn.

### The record that has to exist

One append-only ledger of **obligations**. Not a counter — a counter is a summary of a
thing we are not keeping.

This is a **work graph**: nodes are jobs, edges are *this job needs what that one
produced*. Said explicitly because the same phrase names a second, unrelated thing — a
*knowledge* graph, whose nodes are entities the agents found and whose edges are shared
suppliers and citations, which is what Kimi's 300-agent swarm builds
([docs/14](14-from-outside-reading.md)). That one answers "which three share a supplier".
This one answers "is it finished, what did it cost, is it stuck". **Building the second to
fix the first would be a large feature aimed at a correctness bug.**

The vocabulary is worth borrowing for one artefact in particular, the **node contract**:

```
JOB:     one bounded job, nothing else
IN:      passed in, never assumed
OUT:     a fixed shape
SCHEMA:  enforced — free text is rejected
```

> A node whose output is a wall of free text is a node only a human can read.

Which is exactly today's `Fork` child, whose failure is prose inside a non-error result.
So the terminal states below are not an invention of this design: **a settlement record is
a node's `OUT`, enforced.**

```
obligation:  id, parentTurnId, childConversationId, kind, openedAt
settlement:  id, state, at, note
state:       running | succeeded | failed | abandoned | unknown
```

Four properties, each answering one of the review's faults:

**Written before the effect, not after.** The obligation is appended *before* the child is
dispatched. The crash window that loses a fork today becomes a window that leaves an
obligation with no child — recoverable, because a restart can see an obligation whose
conversation never began and settle it `abandoned`. The reverse (child with no obligation)
is what cannot be recovered, so the write goes first.

**Terminal states are not one state.** `--- fork N FAILED ---` currently rides inside a
tool result that is *not* an error, and `fork.test.ts` asserts that. Under this ledger a
failed child settles `failed`, which is **an unresolved obligation, not a settled one** —
the parent may decide to retry, to proceed without it, or to report it, but it may not
finish while pretending it is done. Deciding those are the same thing is how a gate
finishes early, which is the wrong-still-looks-correct shape docs/13 exists for.

**Settlement is idempotent.** Keyed by obligation id, last write wins on replay. A
settlement written twice is the ordinary case after a restart, not a bug.

**Every producer of work opens one, not just `Fork`.** `SendToAgent`, `Delegate`,
background jobs and scheduled skills each open an obligation of their own kind or are
explicitly declared *detached* — and a detached obligation is one the parent is allowed to
finish without. What is not allowed is work that is neither.

### Then, and only then, the gate

With the ledger in place, Dijkstra–Scholten's shape applies and is worth having: an agent
may finish when it is idle and has no unsettled non-detached obligations. Until it is in
place, a gate is a counter over a graph nobody wrote down — the board predicate wearing a
proof.

### What the review did to each of those four properties

Every one of them, in order.

**"Written before the effect."** There *is* a syntactic place to write it — `Fork` computes
the child conversation before calling `sendFromUser` (`tools.ts:1420`). But the claimed
*benefit* is false. The bus marks the inbox item started before invoking the turn runner
(`bus.ts:483`) and inbox compaction erases the admission once nothing is pending
(`inbox.ts:111`), so "obligation written, child never dispatched" and "child dispatched and
died during setup" reduce at restart to **the same observable state**: an obligation, no
pending message, no child turn. The distinction the design was built on cannot be made.

Two worse details underneath it, neither of which the design accounted for: an inbox append
failure is *warned about and dispatch continues* (`inbox.ts:125`), and `appendLine` does not
`fsync` (`jsonl.ts:44`) — so "durably written before the effect" is not established even
when the order is right.

**"Terminal states are not one state."** Correct as far as it goes, and it reintroduces the
livelock. A child that fails deterministically settles `failed`; `failed` is unresolved;
the parent may not finish; the retry fails identically. "The parent may retry, proceed
without it, or report it" names three *actions* and no *state transition*, and `abandoned`
has no writer and no evidence rule — so it comes down to the model deciding, which is
exactly the board predicate the previous review killed. The repair is real but is a
different design: separate **attempt outcome** from **obligation resolution**, so
`attempt_failed` is followed either by a bounded retry with a new attempt id or by an
explicit waiver from a named authority, with the retry and time limits themselves durable.

**"Settlement is idempotent."** It is not. Appending the same fact twice is idempotent;
allowing *different* facts to overwrite each other is not, and last-write-wins is the
second thing. The sequence: a restart reconciler reads an obligation and sees no
settlement; the child finishes and appends `succeeded`; the stale reconciler appends
`unknown`; replay takes the later one. A durably successful child is now unresolved, and
reversing the race lets a late child overwrite a deliberate abandonment. What is needed is
attempt-scoped events with monotonic transitions and one authorised writer.

**"Every producer opens one, or is detached."** Unenforceable, and the schema does not even
have the field. The bash tool exposes `background`, not dependency (`tools.ts:357`);
`Delegate` has nothing (`tools.ts:423`); and this repository has a test *proving* a detached
descendant escapes its process group (`shell-service.test.ts:180`). So detachment is a
declared intent, which is fine — it is being called a proof that is the problem. A
background build the answer depends on is not detached in any useful sense, and a dev
server is never not-detached, and no harness that hands out `/bin/sh -lc` can tell them
apart.

**And the node contract.** The design quoted "SCHEMA: enforced — free text is rejected" and
then proposed a settlement of `id, state, at, note` where `note` is free text. A child that
returns an essay instead of `{supplierIds, citations}` settles `succeeded` with
`note: "looks good"` and the gate lets the parent finish: wrong still looks complete, which
is the failure this whole document exists to prevent, reproduced inside the fix for it.

---

## 2. Cost: estimated before, bounded during, attributed after

The three are different jobs and only the third exists.

### Attributed after — half built, and the half that is missing is the join

`usage.jsonl` records the turn loop's calls against an agent, and against a principal when
there was one. What it cannot do is answer "what did *this task* cost", because the row has
no task, no conversation and no turn on it (`usage.ts:29`) — the answer would have to be
guessed from timestamps, and two tasks running near each other for the same agent make even
that guess wrong.

This is the concrete form of the `workId` problem in section 1, and it is the cheapest
thing on this page to fix: **one field on `UsageRecord`, set at the single write site.**

### Bounded during — built and switched off

Turn on `AGENTBOX_BUDGET_TOKENS` and `AGENTBOX_PRINCIPAL_BUDGET_TOKENS` and the gate
refuses. The reason to state a number rather than leave it unset is not that a runaway is
likely; it is that **an unset ceiling means the answer to "what is the worst case" is
"unbounded", and that is not an answer anyone can act on.**

The refusal has to be readable as a *stop*, not a failure: reaching a budget means
**stopped incomplete**, and an agent told only "refused" will report that the work failed.

### Estimated before — not built, and further off than claimed

The shape is right:

```
estimate(task) ≈ Σ over planned obligations of  median(cost | obligation kind)
```

But the claim that "we have the history for that: 562 calls with kinds and token counts"
was **false**. `UsageRecord` has no `kind` (`usage.ts:29`) and the write site supplies none
(`turn.ts:1433`), so there is no distribution to take a median of — and the file's 48-hour
retention means that even once `kind` exists, the history accumulates from the day it is
added, not from the ones already spent.

Which makes the ordering clear rather than disappointing: `workId` and `kind` on the usage
row are what start the clock. Everything estimative here is downstream of a field that
takes an afternoon.

The product consequence, which is the real reason to want it: **a long task can say what
it will cost before it starts, and ask.** "This looks like eight sub-questions, roughly
300k tokens, about four minutes — go ahead?" is a different product from one that
disappears for an afternoon.

### Depth and breadth are cost too

Breadth is capped at 12 per `Fork` call and depth at one, but that is a property of the
current tool rather than a budget. Under the ledger, **total descendants** is a bound that
can be enforced before spawning rather than discovered afterwards, and it is the bound
that actually prevents the fan-out explosion — token ceilings stop it late and expensively.

---

## 3. Stopping: four failures that look alike

The existing machinery is better than the previous roadmap entry claimed, and its
weaknesses are specific.

| failure | what it looks like | caught by |
|---|---|---|
| **repetition** — same call, nothing moving | 4× one signature, no other tool, plan and todos unchanged | `detectLoop`, and well |
| **churn** — varied calls, no progress | different calls every round, state never changes | **nothing**. `hasProgressed` returns true because signatures varied |
| **oscillation** — A, B, A, B | two calls alternating forever | **nothing**. `detectLoop` requires exactly one signature |
| **livelock across agents** — each waiting on the other | two agents messaging, neither finishing | **nothing** |

`detectLoop`'s three conditions are all required, which makes it precise and narrow: it
catches the honest repeat and misses everything that varies. The comment defends the
narrowness ("three of those in a row is patience") and it is right to — a false positive
kills real work. But the gap is real and named here rather than argued about.

**What would close it without a false-positive problem: progress has to be defined by
what changed, not by what was called.** `stateHash` already covers plan and todos.
Widening it to the artifacts a turn actually produced — files written, tasks settled,
obligations closed — turns "different calls, nothing changed" from invisible into
detectable, and it does so on evidence rather than on a pattern over call names.

And the fail-safe that belongs under all of it, from the review: **a hard budget, checked
before spawn, across descendants, wall time and spend.** Reaching it is not finishing. The
message a person gets has to say which of the two it was, because "stopped at the ceiling
with three of eight questions answered" and "finished" are opposite outcomes that a
progress bar renders identically.

---

## The budget decision, taken and recorded

**Not set, deliberately, on 2026-08-26.** The proposed number — 5M tokens in 24 hours,
about three times the heaviest day so far — was judged too conservative to be useful, and
a ceiling that stops real work is worse than none: it teaches people to raise it without
looking, which is a ceiling in name only.

So the decision is to **observe first**. The risk of that phrase is that it has no end,
and "observe first" becomes "never", which is how the other eight instances of this pattern
happened. So it is written down with what would end it:

- The observation is **partly** running. `usage.jsonl` records the turn loop, keyed by
  agent, with an optional principal — not every call and not against a task.
- **What to look at:** the heaviest *day*, and separately the heaviest *single turn*. The
  day bounds a bill; the turn bounds a runaway, and they want different ceilings.
- **The turn one is not observable today.** Usage rows carry no turn id, and `round`
  restarts at zero on every continuation (`turn.ts:1159`), so a long turn that resumed
  twice looks like three short ones. The day figure is sound; the turn figure needs the
  same field everything else on this page needs.
- **What would settle it:** a fortnight of ordinary use, or the first turn that costs more
  than a person expected. Either produces a number from evidence rather than from caution.
- **Today's baseline, for comparison later:** 562 calls, 1,725,069 input and 100,177
  output tokens, no ceiling in force.

Recorded rather than left implicit because an unset limit is a decision, and an
undocumented decision is indistinguishable from an oversight — which is what the other
eight were.

---

## What to build, in order

Reordered after the second review, and much shorter at the front than it was.

1. ~~**Turn on a budget.**~~ Deferred with a reason and an end condition, above.
2. **`workId` on the records that already exist.** One id, allocated when work begins,
   unchanged across resumes, written onto usage rows, transcript entries and task changes.
   Plus `kind` on the usage row, because the estimate has no distribution without it.
   Additive, one write site for the first of them, and it is the thing every later item
   turns out to need. It also makes R31's dashboard possible on its own, with no gate.
3. **Widen `stateHash` to artifacts**, closing the churn and oscillation gaps with
   evidence rather than heuristics. Independent of everything above — worth doing in
   parallel.
4. **A dispatch record**, preallocated before the effect, shared by inbox admission, child
   attempt, transcript cause and usage. This is what the obligation ledger was reaching
   for; it is one id and an ordering rule, not a graph.
5. **Separate attempt outcome from obligation resolution**, with bounded retries and a
   named authority for waiving — the repair the review specified for the livelock.
6. **The gate**, Dijkstra–Scholten-shaped, only once 4 and 5 exist.
7. **The estimate**, once `kind` has accumulated history, checked against outcomes.

Steps 4, 5 and 6 change what counts as finished and what a persisted record contains, so
per [docs/13](13-design-review.md) each goes to hostile review before it is built. Step 3
changes what a test asserts is correct, which is the same category. **Step 2 does not** —
it adds a field to records already being written, and nothing reads it yet.

### What the second review is evidence of

The first version of this document opened by saying its predecessor's central claim was
false because it was written from memory, and that this one was "wrong about things that
were read". Ten of its claims about our own code were then found false, and the six checked
before this rewrite were all genuinely wrong.

So the lesson is not "read the code first" — that was already the lesson, stated in the
first paragraph, and it did not work. It is narrower and less comfortable: **reading a
module to confirm a design reads it for what the design needs, and that is not the same
act as reading it to find out what it does.** Every false claim here was about a field that
did not exist on a record I had opened. What catches that is not more care; it is printing
the record.

The same fix that worked for the chevron — [stop reasoning about the artefact and print
it](17-two-agents.md) — applies to a schema. Before the next version of this design claims
a field exists, it should quote a line of the actual file.
