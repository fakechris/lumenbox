<!-- doc: 43-scenarios
     title: Episodes as tests
     family: decision
     status: current
     updated: 2026-09-14
-->
# 43 · Episodes as tests

*2026-09-09. Why conduct regressions keep reaching the person first, and the two harnesses that
stop them. Companion to docs/42 (one front, invisible workers).*

## The problem

Every conduct fix in this system was paid for by a person watching a bad run: five questions for
an agent that did not exist, two agents apologising at each other for ten messages, three turns
polling for a file that never lands, a heavy task with no signal for minutes. None of these is a
bug in a function. Each is a **shape across a whole episode**, and no unit test can see a shape.

So the loop was: ship a rail, the next episode breaks a different way, the person tells us. The
person is the test suite. That is the thing to end.

## Two harnesses, because there are two questions

**Does the harness hold when a model misbehaves?** — deterministic, in `npm test`.
`src/host/scenario.ts` runs a whole episode on the real stack (registry, bus, `runTurn`, the real
tools and prompts) with two things faked: the model is a script, the box is a Map. It returns a
**scorecard** — questions asked, peer messages, calls before the first answer, agents created,
files landed, the refusals the rails produced — and the assertions are written against that, so a
failure reads like the complaint it came from. Each scenario in `scenario.test.ts` is a real
episode that went wrong, scripted to misbehave the way the real model did.

**Does the model behave?** — live, opt-in, `npm run scenario`. The same scenarios against the
real provider in a scratch `AGENTBOX_HOME`, N runs each, printing the same scorecard. Conduct
varies between runs, so one run tells you nothing and the report shows every run's column rather
than a total. A red cell is something to look at, never a failed build. It costs money and
minutes; it is not in `npm test` and should not be.

```
npm run scenario                     every scenario, 3 runs each
npm run scenario -- --only team      one
npm run scenario -- --runs 5 --json before.json
```

The JSON is for the comparison that matters: run it before a prompt change and after.

## The discipline

When a run goes wrong, the fix is not finished until the episode is a scenario. Reduce it to the
shape that made it bad, script the model to behave that way, and assert on the scorecard. Two
lines in `scenario.test.ts` are worth more than a paragraph in a prompt, because the paragraph is
not checked and the scenario is.

## The release scorecard (INV-130, 2026-09-13)

`npm run release:check` now ends by writing a scorecard (`src/host/scorecard.ts`,
`scripts/scorecard.mjs`) to `~/.agentbox/scorecards/<time>-<commit>.json`: commit and
dirty flag, node version, build time, and three sections kept apart — **deterministic**
(the hermetic suite), **artifact** (`release-check.mjs`), **model** (the live scenarios,
only from a `--scenario out.json` the operator produced under their own credentials;
never run here, never PASS when absent — SKIPPED, on the card and in the output).

Verdicts: **PASS** (all three ran clean against a comparable baseline), **FAIL** (a hard
gate: tests or artifact), **INCOMPLETE** (a section skipped, no baseline, or a baseline
from another provider/model/fixture version — refused and said), **REVIEW** (a check's
pass rate fell against a comparable baseline; a named person accepts it with
`--accept "scenario/check=name"` or the build waits). Exit codes 0/1/2/3;
`npm run release:scorecard` is the strict standalone gate, and under `release:check` an
INCOMPLETE card does not fail a developer machine's build. `--inject-failure` proves the
gate closes (A3) and is exercised by `scorecard.test.ts` through the real script. The
scenario runner's `--json` now records provider and model so two runs are comparable
or known not to be.

## The delivery journeys (INV-480, 2026-09-14)

`src/host/journeys.ts` freezes what one person asks for, in three classes — a report from
several materials, a read-only browser collection, a check of a routine's last result —
each in three shapes: as asked, with an authorization the rails refuse (no vault for a
secret fill, a private address the URL guard stops, a host command with no host runner),
and interrupted then resumed on "continue". Nine variants, each with named checks: the
artifact says where its numbers came from, nothing from a refused step reaches it, the
refusal is on record and the person is told, the partial is on disk and says what is
pending, and a resume never repeats a write. `journeys.test.ts` runs them on the scripted
model and the memory box (the harness gained `box` overrides and a `display`, so a
collection journey's browser answers with a fixed page) and prints the report: commit,
configuration, per-journey rounds / questions / refusals / artifacts, and the two things
this cannot verify — a real model's conduct (`npm run scenario`) and a person's acceptance
(no trial participants recruited) — as UNVERIFIED, not inferred.

## The migration trials (INV-481, 2026-09-14)

`src/host/migration-trials.ts` freezes five workflows — four taught by a skill, one by a
site learning, one of them reaching for a capability the receiver lacks — each with three
inputs never used to demonstrate it, and runs every input taught and untaught on the
scripted model (the harness now takes `skills`, and learnings are read from the episode's
own `AGENTBOX_LEARNINGS`). Each cell records calls, questions, refusals, the artifact, and
failures classified by stage: extraction (the skill reached the prompt), parameterisation
(the artifact carries this input's own value), capability-binding (the host command was
refused, not run, and the person told), environment (the learning was recalled on a page
it was not written on; the untaught control recalls nothing), execution, verification.
The report prints the 5×3 matrix taught|untaught with failures by stage, says that the
call delta is by construction of the scripted model, and lists as UNVERIFIED the same
matrix on a real model and the two non-author installs the contract asks for.

## What it is not

The scripted model is not a model. It cannot tell you whether a real one is sensible, only whether
the rails hold when it is not. And a passing live scorecard is evidence, not proof — three good
runs of a stochastic system is three good runs. Both are worth having and neither replaces reading
a real episode.

## First result

The 2026-09-09 episode — "build a five-agent content team from this post" — took the live team
thirteen minutes, four `sleep` polls for files that do not exist, ten messages of mutual
correction, one question to the person about a plugin from another product, and produced no
content. After the fixes in this round it runs in 34 seconds and 17 tool calls: six agents, no
questions, no polling.
