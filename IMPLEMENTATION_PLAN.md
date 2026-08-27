# workId and the admin view

The join key first, then the thing that needed it. Four stages, each shippable alone.

Background: [docs/16](docs/16-long-work.md) section 1, and R31 in
[docs/11-roadmap.md](docs/11-roadmap.md). The short version is that every question worth
asking about long work is a join, and there is nothing to join on — `turnId` is minted
fresh per attempt (`turn.ts:818`), so a turn that resumed twice looks like three unrelated
short ones.

---

## Stage 1: `workId`, stable across resumes

**Goal**: one id, allocated when work begins, unchanged across every resume, written on
turn ledger records and usage rows.

**Design.** A turn that is not a resumption mints a `workId`. A resumption inherits the one
belonging to the turn it picked up, which means the ledger has to carry it and
`interrupted()` has to return it — the review found that `interrupted()` already discards
`resumeOf` from its returned shape, and repeating that mistake with `workId` would make the
whole stage a no-op.

Path: `BeginRecord.workId` → `InterruptedTurn.workId` → `Orchestrator.resuming` →
`TurnDeps.resumeOf` → `runTurn` → `turns.begin` and `usage.record`.

**Success criteria**
- A turn resumed twice writes three begin records with three `id`s and **one** `workId`.
- A usage row carries the `workId` of the turn that produced it.
- A ledger written by an older build (no `workId` on its records) still replays, and a turn
  resumed from one of those gets a fresh id rather than crashing.

**Status**: Complete. Four ledger tests and two that drive `runTurn` end to end — the
second of those exists because the first one only proves the id is *stable*, and an id so
stable it groups everything reports as one enormous piece of work that never ends.

---

## Stage 2: `kind` and `conversation` on usage, and the calls nobody was counting

**Goal**: make the sentence "usage records every model call" true, since docs/16 asserted
it and it was false.

**Measured**: there is exactly one `usage.record` call site (`turn.ts:1433`). Three model
calls go through no ledger at all — `summarise` (`turn.ts:580`), `Remember.ask`
(`remember.ts:157`) and `Orchestrator.askCheaply` (`orchestrator.ts:625`). All three run on
the cheap profile, which is the argument for why nobody noticed and not an argument that
they are free.

`kind` is what makes the estimate possible later: `turn | summarize | memory | select`. It
is also what makes those three visible now.

`conversation` is already in scope at the write site and costs one line. It does not solve
task attribution — a task spans conversations and a conversation spans tasks — but it makes
a fork child costable immediately, which is the case an estimate cares about most.

**Success criteria**
- Every `messages.create` outside `conformance.ts` and the CLI judge writes a usage row.
  Enforced by a test that greps the source, in the manner of the app-html id check — a new
  unrecorded call site fails the suite.
- `byKindSince` returns four kinds on a day with memory extraction in it.
- The cheap-profile total is separable from the turn-loop total.

**Status**: Complete. The guard needed two attempts and the first one is the interesting
part: it looked for a ledger write within N lines of the call, and a deliberately unmetered
call added next to a metered one passed, because the neighbour's write was inside the
window. It now enumerates every call site by its enclosing declaration, and a site that is
not on the list fails whatever sits near it — verified by adding an unmetered call and
watching it fail.

---

## Stage 3: the reader

**Goal**: the questions from 2026-08-26 answerable by a command instead of a throwaway
script. Fifteen or so one-offs were written that day, none re-runnable, several wrong on
the first attempt precisely because they were improvised.

- a day: total, by agent, by kind, by principal, in tokens and in money
- one `workId`: its turns, its rounds, its conversations, its cost
- a task: the same, via the work that touched it

**Design note.** A rate table is what turns tokens into a number a person can act on;
`usage` already carries `provider` and `model`, so this is a lookup and a multiplication,
with the rate recorded alongside the total so an old report does not silently change when a
price does.

**Success criteria**
- `agentbox usage --day 2026-08-27` and `agentbox usage --work <id>` both work against real
  records.
- Every number the report prints can be re-derived from `usage.jsonl` by hand.
- 48-hour retention is stated in the output, not discovered later — a total over a
  compacted file is a lower bound and has to say so.

**Status**: Not Started

---

## Stage 4: the admin view

**Goal**: the daily dashboard with drill-down, as a surface rather than a command.

Deliberately last. The reader is where the definitions get settled, and building a page on
top of definitions that are still moving is how the throwaway scripts happened in the first
place.

**Success criteria**
- A day, drillable to a task, showing execution, artifacts, rounds and cost.
- Verified against the running page with `scripts/ui-shot.mjs` before it is committed, per
  [docs/17](docs/17-two-agents.md).

**Status**: Not Started

---

## What this plan does not do

It does not build the completion gate, the obligation ledger, or anything that decides when
an agent may finish. Those need a dispatch record and a separation of attempt outcome from
obligation resolution, both of which go to hostile review first — see the ordering in
docs/16. This plan builds the field all of them turned out to need, and the reporting that
was waiting on it and no longer is.
