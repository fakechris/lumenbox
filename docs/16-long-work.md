# Finishing long work: the protocol, the cost, and the stop

**Status: design, not built.** Written after the R30 review found three fatal faults in a
completion gate whose load-bearing claim — "`Fork` is already a spawn tree, this needs a
counter and a rule" — was false. The lesson taken from that is procedural and applied
here: **every claim below about our own code was read out of the code while writing this
paragraph, not recalled.** Ten claims in the previous version were written from module
comments and memory, and eight of them were wrong.

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
| `detectLoop` | `progress.ts:91` | 4 consecutive rounds of **one** repeated call, **no other tool alongside**, **plan and todos unchanged** — all three required |
| `hasProgressed` | `progress.ts` | deliberately generous: one todo change in 400 rounds counts |
| `AgentBus.idle()` | `bus.ts:581` | in-process quiescence; `settle()` calls it in production |
| `PolicyGate` budget | `policy.ts` | refuses over `budgetTokens` in a rolling window, per installation and per principal — **tested and working** |
| `Usage` ledger | `usage.ts` | every call's tokens, attributed to a principal |

**And the finding that matters for question 2:**

```ts
budgetTokens: envLimit("AGENTBOX_BUDGET_TOKENS"),          // undefined unless set
perPrincipalBudgetTokens: envLimit("AGENTBOX_PRINCIPAL_BUDGET_TOKENS"),
```

Neither is set. `config.json` has no `policy` block at all. `policy.test.ts:159` asserts
the default is `undefined` and calls that correct.

> **There is no spend ceiling on this installation. There never has been.** The gate that
> would enforce one is built, tested, and switched off.

Measured: **562 recorded calls, 1,725,069 input and 100,177 output tokens.** Not a large
bill, and entirely a matter of how the day happened to go rather than of anything
stopping it.

This is the ninth instance of the pattern in [docs/14](14-from-outside-reading.md) — a
capability present in the source and absent at runtime — and the first where the absent
thing is a *limit* rather than a feature.

---

## 1. Finishing: the protocol the gate needs first

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

---

## 2. Cost: estimated before, bounded during, attributed after

The three are different jobs and only the third exists.

### Attributed after — built

`usage.jsonl` records every call against a principal. This is the part that works, and it
is what makes the other two possible: an estimate needs history to be an estimate rather
than a guess.

### Bounded during — built and switched off

Turn on `AGENTBOX_BUDGET_TOKENS` and `AGENTBOX_PRINCIPAL_BUDGET_TOKENS` and the gate
refuses. The reason to state a number rather than leave it unset is not that a runaway is
likely; it is that **an unset ceiling means the answer to "what is the worst case" is
"unbounded", and that is not an answer anyone can act on.**

The refusal has to be readable as a *stop*, not a failure: reaching a budget means
**stopped incomplete**, and an agent told only "refused" will report that the work failed.

### Estimated before — not built, and the interesting one

The obligation ledger makes this possible for the first time, because cost becomes a
property of a *shape* rather than of a run:

```
estimate(task) ≈ Σ over planned obligations of  median(cost | obligation kind)
```

We have the history for that: 562 calls with kinds and token counts. A fork that fetches
and summarises has a cost distribution; so does a verifier pass. An estimate from the
median of past obligations of the same kind is worth far more than a model's guess, and it
is checkable afterwards — the estimate and the actual go in the same ledger, and the error
is measurable.

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

## What to build, in order

1. **Turn on a budget.** One config line, today. It is the only item here that reduces
   worst-case exposure without new code, and the worst case is currently unbounded.
2. **The obligation ledger.** Everything else depends on it: the gate cannot be correct
   without it, and the estimate cannot be honest without it.
3. **Widen `stateHash` to artifacts**, closing the churn and oscillation gaps with
   evidence rather than heuristics.
4. **The gate**, Dijkstra–Scholten-shaped, over the ledger.
5. **The estimate**, from the ledger's own history, checked against outcomes.

Steps 2 and 4 change what counts as finished and what a persisted record contains, so per
[docs/13](13-design-review.md) each goes to hostile review before it is built. Step 3
changes what a test asserts is correct, which is the same category.

The review of the previous attempt is the reason this document leads with measurements. It
is also worth stating plainly: **the last design's central claim was false because it was
written from memory of the codebase.** This one may still be wrong, but it is wrong about
things that were read.
