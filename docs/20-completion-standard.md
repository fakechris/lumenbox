# The standard of completion, written before the work

Status: **design awaiting adversarial review** (docs/13 triggers 3, 4 and 5: it changes
what arbitrates in the audit prompt, what a test asserts is correct about "done", and it
crosses the channel/board/audit boundary). Not built until the review has run. This is the
**third** attempt at a completion gate; §2 is the history, because a reviewer given only
this proposal will re-propose what already died.

## 1. The finding this rests on

Factory measured the following, and the shape is worth stating before any of our own
design: the same model, on the same task, wrote 17,000 lines and reproduced 36% of a
reference program's behaviour **and then stopped — not out of time or budget, but because
by its own assessment it was done**. Given an independent standard of completion, authored
before implementation by the same model at the same reasoning level, it wrote 115,000
lines and reached 90%. Across 24 tasks: 7-Zip 54→95, DuckDB 34→80.

Their diagnosis, in their words: *the standard of completion must not quietly collapse
around whatever has already been built.* An agent that decides both what to build and what
evidence counts derives its evidence from the scope of what it thought of. It can be
locally correct at every step and stop with most of the outcome unrepresented — not
because it could not do the rest, but because **it never established a complete account of
what remained**.

The second mechanism is a wall, and it is separate: the implementer never authors, runs or
sees the cases. *"Once a sparse sample becomes visible, it becomes the target, and passing
it establishes those cases, not the space they were meant to represent."*

## 2. Why the first two attempts died, and what is different

**Attempt 1 (obligation ledger, killed by review twice).** It proposed tracking what the
agent owed and checking it off. Killed on two grounds: the doc contained ten claims about
the code that were not true when read, and — the substantive one — deciding whether a
delivery *covered* an obligation needs a definition of "cover" that is not a model's
opinion. That is the trap: a gate whose judgement comes from the same faculty as the work
is the worker signing its own certificate.

**Attempt 2 (three-state completion, deferred).** Softer: let `review` mean "the agent
thinks so" and let acceptance mean "the person says so". The acceptance half shipped and
works — `done` is the requester's word, an assignee cannot self-accept, and the verbs
("可以", "收到") are live. The gate half was deferred for the same reason as attempt 1.

**What is different now.** Neither attempt questioned the *timing*. Both put the judgement
after the work, where the only available standard is the one that grew alongside it.
Factory's result says the judgement does not have to be made after the work at all: **the
standard is authored first, from the request, before implementation narrows attention**,
and then the question at the end is not "does this look done" (opinion) but "does the work
satisfy these named checks" (comparison). The trap is avoided by moving the standard, not
by finding a better judge.

**What has not changed and must not:** `done` remains the requester's word. This design
produces a *standard*, not a verdict. It makes the human acceptance safer and better
informed; it does not replace it.

## 3. What already exists to build on

Not a greenfield — three of the four pieces are shipped and one is subtly backwards:

- **The request is on the task.** As of 2026-08-27 `board.open` stores the person's whole
  message as `Task.description`; the title is a rewritten short name. So the raw request —
  the only honest source for a standard — is available at task-open time.
- **A reviewer is named at task creation** when the installation has one, and the review
  gate is the single enforced rule in `tasks.ts`.
- **The audit agent exists** and already tries the right thing: *"Re-derive the acceptance
  constraints from the original request, independently, and check the work against those —
  not against the assignee's summary of them."*
- **And its ordering is backwards.** The same prompt says, first: *"Read their work with
  ReadHistory."* The reviewer reads the work, then derives the standard it will judge the
  work by. That is precisely the collapse Factory names, in our own prompt, today. The
  sentence asking for independence cannot deliver independence after the evidence is in
  context.

## 4. The design

**A standard is authored at task open, by the reviewer, from the request alone.**

When a task is opened with a reviewer and a description, one call on the *reviewer's own*
profile — not the cheap one; this is the artifact everything else is judged against —
produces a short list of checks:

```
t42 standard of completion
1. Output is a single .xlsx at a path stated in the reply, openable, not a described plan.
2. Every one of the three source folders is represented; a count per folder appears.
3. Rows the source could not parse are listed by name, not silently dropped.
4. The Q3 filter is applied on the date column, not on the filename.
```

Properties, each because its absence is a known failure:

- **Derived from the request, and from nothing else.** No transcript, no plan, no
  intermediate work — none of it exists yet, which is the point.
- **Checkable by inspection of the artifact**, not by asking how it felt. "A count per
  folder appears" is checkable; "the data is correct" is not.
- **It may be added to, never weakened.** Learning that the request implied a fourth check
  is fine. Deleting check 3 because the work dropped rows is the collapse.
- **Stored on the task, versioned, and visible to the person** who asked. They are the one
  who accepts; a standard they cannot see is a standard they cannot correct.

### The wall, in our shape

Factory's wall hides the *cases* because their cases are a sparse sample of an unbounded
behaviour space, and a visible sample becomes the target. Our checks are not a sample —
they are the requirements themselves, and hiding requirements from the implementer would
be perverse: an agent that does not know what "done" means will not do it.

**So we invert their wall and keep its purpose.** The implementer *is* shown the standard.
What it must not do is author or edit it — the standard is written by the reviewer, and the
assignee's Tasks tool refuses to modify it, the same enforcement shape as the review gate.
The property being protected is the same one: *the standard must not collapse around what
got built*. Their threat was a leaked sample; ours is an author with a stake.

Open question for review, and I do not think this is settled: whether the reviewer's
*verification procedure* (what it will actually run) should be hidden even though the
checks are visible. Factory's evidence says a visible procedure becomes the target.

### At the end

The audit prompt's ordering is corrected: the standard is already in hand and was written
before any of the work existed, so the reviewer checks the artifact against a named list
rather than re-deriving constraints from a context now full of the assignee's account. The
reply carries a per-check verdict instead of a global adjective, and the task still lands
in `review`, not `done`, because done is still the requester's word — but the person now
accepts against a list, which is what makes their acceptance mean something.

## 5. Cost, and where this must not go

Factory's system spent **14× the credits and 13× the wall time** of the single agent. That
is the right trade for reproducing GDAL and a product-killer for a person converting three
hundred reports.

So, explicitly: **the campaign is not being adopted; the ordering is.** One extra call at
task open, on tasks that have a reviewer. No implementer/validator/orchestrator triad, no
instrument of hundreds of weighted cases, no differential-testing loop. If someone later
wants the campaign for a genuinely large task, it is a separate decision with a separate
budget, and this document is not permission for it.

Second limit, and it is the one most likely to be underestimated: **our tasks usually have
no oracle.** ProgramBench hands the model a reference program it may execute without limit;
"整理 Q3 报表" hands it a folder. Checks derived from a request are weaker evidence than
cases derived from a reference, and this design must not be described — internally or to a
customer — as if it produced the latter.

## 6. What review should try to break

- **The standard is authored by a model from a one-line request.** "把这些表合并一下"
  yields what? Four vacuous checks that everything passes, or a refusal? Which is worse,
  and does the design admit a task having *no* standard?
- **Who pays when the standard is wrong?** A missing check is invisible; a *wrong* check
  sends the assignee to do work nobody wanted, and the person cannot tell whether the
  friction is diligence or a bad check. Is the person's ability to edit the standard
  enough, given they will not read it until the work comes back?
- **Enumerate what happens when the task has no reviewer** (most installations, most
  tasks). Is the standard skipped, self-authored, or does the shape quietly become
  mandatory?
- **The append-only rule is enforced by what?** "May be added to, never weakened" is a
  sentence until something refuses the write. The review gate is the precedent; is the
  same mechanism available where the standard is stored?
- **The visible-standard inversion (§4).** Is the argument right that hiding requirements
  is perverse in our setting, or does the same targeting effect apply to requirements too
  — an agent that satisfies four checks and stops?
- **Interaction with steering.** A person redirects the work mid-task ("只要 Q3"). The
  standard was authored from the original request. What updates it, who, and does an
  amended standard preserve the append-only property or quietly reset it?
