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
