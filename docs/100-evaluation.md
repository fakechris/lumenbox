<!-- doc: 100-evaluation
     title: The evaluation report: one corpus, k attempts, four numbers
     family: guide
     status: current
     updated: 2026-11-19
-->
# 100 — The evaluation report: one corpus, k attempts, four numbers

How to measure whether the product got better or worse, and how to read the answer. One gold
corpus, one runner, one page (INV-1772; the trend and the "too small to say" verdict come from
INV-821).

Before this, evaluation lived in pieces that each printed their own table: the starter skills'
cases, the teach fixtures, the auto-review and steward agreement scripts, the live scenarios. None
gave a rate with an interval, none compared two runs task by task, and none said how small a
change it could have seen. A number without those three reads as more than it is.

## What is where

| piece | file | what it owns |
|---|---|---|
| corpus | `evals/corpus/dev.jsonl`, `evals/corpus/test.jsonl` | the tasks, one a line |
| loader | `src/evals/corpus.ts` | the task schema, versions, and the checks that keep dev and test apart |
| derivation | `src/evals/corpus-build.ts` | turning the repository's own cases into tasks, and each task's side |
| graders | `src/evals/graders.ts` | labels, required facts, forbidden words, format, end state, the teach scorer |
| subjects | `src/evals/subjects.ts` | how a task is put to the product: `episode`, `auto-review`, `steward`, `teach` — and each one's stand-in |
| cache | `src/evals/cache.ts` | model calls keyed by request, task version and recipe |
| runner | `src/evals/runner.ts` | every task k times; the record of each attempt |
| statistics | `src/evals/stats.ts` | intervals, pass^k, McNemar, the detectable difference, kappa |
| summary | `src/evals/summary.ts` | from a record to the numbers; when two runs may be compared |
| page | `src/evals/report.ts` | the report and the trend lines |
| command | `scripts/eval-report.mjs` (`npm run eval`) | the provider, the clock and the disk |

Each piece takes the others as arguments. A new way to run a task is one more subject; a new
comparison is a function over two records.

## The corpus

A task is a line of JSON:

```json
{"id":"steward.done-and-thanked","subject":"steward",
 "source":{"kind":"steward-tail","ref":"src/host/fixtures/steward-tails.json#done-and-thanked"},
 "failureType":"missed-stopping-point",
 "input":{"condensed":0,"view":"…"},
 "gold":{"labels":{"all":["switch"]}}}
```

`subject` says how it is run, `gold` what a right result is, `source` where it came from, and
`failureType` the one failure it exists to catch — the report groups by it. `gold` may hold
`labels` (`all` / `none`), `facts`, `forbidden` (plain text, or `re:` for a pattern), `format`
(`json`, `nonempty`), `state` (bounds on `answered`, `engaged`, `questions`, `toolCalls`,
`modelCalls`, `agents`), a named `scorer`, and a reference `answer`. A task nothing grades is
refused.

**Dev and test are separate files.** Dev is what a prompt may be tuned against. Test is what a
report is read from and is never tuned against. Loading refuses a corpus in which an id, an input
or a `group` appears on both sides. One request is often two tasks — the line that must open one
skill is the line that must not open its neighbour — so tasks sharing a group or an input are
dealt to one side together. A task's side is decided once and kept when the corpus is rebuilt.

**What is in it** (92 tasks: 17 dev, 75 test), all derived from files in the repository:

| source | tasks | subject | graded by |
|---|---|---|---|
| the starter skills' own cases (`starter-skills.ts`) | 50 | `episode` | which SKILL.md the turn opened |
| the steward's labelled endings (`steward-tails.json`) | 22 | `steward` | the decision |
| the auto-review trajectories (`auto-review-trajectories.json`) | 12 | `auto-review` | the verdict |
| the teach fixtures (`teach-evals.ts`) | 6 | `teach` | the teach scorer's checks |
| the live scenarios `team` and `vague` (`scenario-live.mjs`) | 2 | `episode` | the state the run ends in |

`npm run eval -- build-corpus` rewrites the two files from those sources; the suite fails when a
case was edited at its source and not here.

**What is not in it.** Two sources the corpus is meant to hold are a person's own data and are in
no file of the repository, so their slices are empty:

- replies the answer review judged and a person corrected (`~/.agentbox/evals/<agent>/*.md`, the
  *Expected* section);
- tasks a live run already scored (`npm run scenario -- --material <dir>`).

Nothing here reads either. A person adds one by appending a line to `evals/corpus/dev.jsonl` or
`test.jsonl` with `source.kind` `review-ledger` or `learning-material`, `source.ref` naming the
message or the material task, `subject: "episode"`, `input.says` holding the request, and a
`gold` of `facts` the right answer must contain and `forbidden` text it must not. Hand-added
lines are carried through a rebuild untouched. The third live scenario, `heavy`, walks a real
file tree with a real shell and stays with `npm run scenario`.

## A run

```
npm run eval -- plan      # what it will cost in calls; makes none
npm run eval -- run       # the test split, 3 attempts a task, on the configured provider
```

`run` is the one command that spends money. On the test split as it stands it makes **at most 672
model calls**: 75 tasks × 3 attempts × the most calls an attempt can make.

| subject | tasks | calls per attempt | at most | model |
|---|---|---|---|---|
| `episode` | 47 | up to 4 (one task up to 12) | 588 | the agent's own |
| `steward` | 15 | 1 | 45 | the cheap side-call model |
| `auto-review` | 9 | 1 | 27 | the cheap side-call model |
| `teach` | 4 | 1 | 12 | the agent's own |

An episode stops at its cap and usually ends sooner. No judge is called: every grader is code.
Each `episode` call carries the full system prompt and tool list, about thirty thousand input
tokens.

Where the numbers land:

- the record of every attempt: `~/.agentbox/scorecards/eval-test-<time>-<commit>.json`;
- the page: `docs/evals/REPORT-<date>.md`, to be committed;
- the cache: `~/.agentbox/eval-cache/`. The same command run again makes no call.
  `--offline` refuses to make one.

The next run compares itself with the latest record for the same split. `npm run eval -- trend`
prints one line per past run. Episodes run over an in-memory box in a scratch home that is
removed afterwards; the installation's agents, ledgers and box are not touched.

## Reading the page

- **Pass rate, with a 95% interval.** The mean of the tasks' pass rates. The interval resamples
  tasks: three attempts at one task are three looks at the same question, not three questions.
- **pass^k beside pass@k.** pass@k: a task passed at least once in k. pass^k: it passed every
  time. The gap is the unreliability a single run hides. With it, the most the share of
  unreliable tasks could be — thirty clean tasks still allow about one in ten.
- **Against the previous run.** Task by task, a task passing when every attempt did. `worse` and
  `better` are counted; McNemar's exact test says whether the imbalance is more than noise.
  **REVIEW** only when it is. A drop the sample cannot tell from noise is **INCOMPLETE** and says
  how many tasks would settle it. Two runs are compared only when the same models answered with
  the same k on the same split; a task edited since is not paired.
- **Smallest detectable difference.** The change in pass rate two runs of this size would catch
  four times in five. A gate tighter than this number fires on noise.

A harness failure — the model unreachable, an episode that never got an answer — is marked apart,
is never a pass, and stays in the denominator. Cost is what each call reported, priced with
`rates` from `config.json` by the usage ledger's own pricing, per attempt that passed.

## The stand-in

`npm run eval -- run --fake` answers every task from a deterministic stand-in: the gold reply, or
(for a fixed share of attempts) the wrong one. It is how the runner, graders, cache and page are
tested without a provider. Its numbers measure nothing. The page says so in its header and its
title, nothing is written unless a path is given, and `docs-lint` refuses a report in
`docs/evals/` whose header does not say `measured: yes`.

## Not a gate, and what is not here yet

CI does not run this and nothing gates on it. A gate comes after a measured run, sized against the
detectable difference that run reports.

Every page says **judge not calibrated — may not gate**: there are no judges yet. Still to come
under the same item: binary judge questions, one per failure type, that must quote their evidence;
calibration of each judge against at least thirty outputs a person has labelled, with kappa and
catch rate, and "may not gate" below 0.6; the release scorecard's `model` entry filled from a
record instead of `skipped`; and the golden tasks' results kept as a trend beside these.
