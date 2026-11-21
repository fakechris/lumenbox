<!-- doc: 100-evaluation
     title: The evaluation report: one corpus, k attempts, four numbers
     family: guide
     status: current
     updated: 2026-11-20
-->
# 100 — The evaluation report: one corpus, k attempts, four numbers

How to measure whether the product got better or worse, and how to read the answer. One gold
corpus, one runner, one page (INV-1772; the trend and the "too small to say" verdict come from
INV-821), and the same runner over two versions of the prompt and tools (INV-1862).

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
| judges | `src/evals/judges.ts` | one yes-or-no question per failure type, the quote check, the judge's model and question version on the record |
| calibration | `src/evals/calibration.ts` | the label file, the sheet a person fills in, kappa and catch rate per question, "may not gate" |
| statistics | `src/evals/stats.ts` | intervals, pass^k, McNemar, the detectable difference, kappa |
| summary | `src/evals/summary.ts` | from a record to the numbers; when two runs may be compared |
| page | `src/evals/report.ts` | the report, the comparison page and the trend lines |
| surface | `src/evals/surface.ts` | the system prompt and tool schema an agent is sent, read off a real turn's first request |
| frozen | `src/evals/frozen.ts` | a commit's product in a scratch tree, driven by this checkout's subjects |
| compare | `src/evals/compare.ts` | two versions on the same tasks: what they share, the difference, the gate |
| golden trend | `src/evals/golden-trend.ts` | `agentbox golden` runs kept and read back |
| command | `scripts/eval-report.mjs` (`npm run eval`) | the provider, the clock and the disk |
| candidates | `src/host/eval-candidates.ts` (`agentbox eval candidates`) | replies the answer review judged not PASS, as cases a person may confirm into the corpus |
| product judges | `src/host/judge-record.ts` | who judged a live verdict and what it read: the provenance every product judge writes |
| product calibration | `src/host/judge-calibration.ts` | the product's labels, each judge's standing, and what that standing lets it decide |
| labelling sheet | `src/host/judge-sheet.ts`, `src/web/calibration-routes.ts`, `src/web/next-calibration-ui.ts` | Settings → Supervision → calibration: what may be shown, and the yes or no |

Each piece takes the others as arguments. A new way to run a task is one more subject; a new
comparison is a function over two records. The judges run over a record, not inside the runner,
so a record can be judged later, by another judge, or beside the record it is compared with.

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

Nothing in the corpus, its loader or the runner reads either. A person adds one by appending a
line to `evals/corpus/dev.jsonl` or `test.jsonl` with `source.kind` `review-ledger` or
`learning-material`, `source.ref` naming the message or the material task, `subject: "episode"`,
`input.says` holding the request, and a `gold` of `facts` the right answer must contain and
`forbidden` text it must not. Hand-added lines are carried through a rebuild untouched. The third
live scenario, `heavy`, walks a real file tree with a real shell and stays with `npm run scenario`.

## Candidates from real replies

The first of those two slices does not have to be typed out from memory (INV-820):

```
agentbox eval candidates --from 2026-11-01T00:00:00Z --to 2026-11-20T00:00:00Z [--box <id|name>] [--out <file>]
```

It reads `answer-review.jsonl` for the range (the last 30 days when none is given), and for every
verdict that is not PASS walks back by the message id to the turn that message opened — in any
context version of the conversation, so a conversation that has since been switched still has its
words — and takes what the person asked and the last thing the agent said in that turn. Both, and
the review's reason, go through the audit export's scrubbing: every value the config and the vault
hold, and every credential-shaped string. It makes no model call. The review ledger itself still
holds hashes only; the words are read on the operator's machine, when this command is run.

The file is JSON Lines, readable by its owner alone, at
`~/.agentbox/exports/eval-candidates-<from>-<to>.jsonl` unless `--out` says otherwise. A path
inside a git work tree is refused unless `--in-repo` is given. The command prints where it wrote,
how many records it left out and why:

| left out | why |
|---|---|
| judged PASS | nothing failed |
| the review could not decide, or the reviewer was unavailable | no failure was named, so there is nothing for a task to catch |
| judged twice | one message, one case |
| opened by the host | a routine's prompt, an audit or a cue is not something a person asked (`request-provenance.ts`) |
| no door or heard record | the turn is stamped as a person's and nothing shows a person sent it |
| no longer in a transcript | named one by one, with the reason: no turn cites the message, the turn has no reply, the agent is gone |

A line is a corpus task with its `gold` empty and a `candidate` block beside it:

```json
{"id":"review.ada.2026-11-10.m-1","subject":"episode",
 "source":{"kind":"review-ledger","ref":"answer-review.jsonl#m-1"},
 "failureType":"non-answer",
 "input":{"says":"…what the person asked…"},
 "gold":{},
 "candidate":{"actual":"…what the agent said…",
   "review":{"category":"NON_ANSWER","confidence":0.9,"reason":"…","at":"…","mode":"shadow"},
   "agent":"Ada","agentId":"…","conversation":"main","epoch":0,"messageId":"m-1","turnId":"…",
   "build":{"version":"…","commit":"…"},"model":"…","evidence":"door",
   "sameAsReviewed":{"input":true,"actual":true}}}
```

`sameAsReviewed` says whether the words found hash to what the review recorded; `false` means the
text differs from what was judged (a reply the channel trimmed, a value redacted when the
transcript was written) and the case wants a closer look.

**Nothing is added to the corpus, the golden tasks or the scenarios.** The loader refuses a
candidate as it stands — `gold needs at least one of …` — and for no other reason. To confirm one:

1. Read `input.says` and `candidate.actual`. The scrubbing removes held values and credential
   shapes, not names, addresses or anything else that identifies somebody: the corpus is committed,
   so rewrite the request until it could be shown to anyone and still asks the same thing.
2. Write `gold`: the `facts` a right answer must contain, the `forbidden` text it must not (often a
   phrase from `candidate.actual`), or a `state` bound. This is the one field that must be filled.
3. Check `failureType` — it is the review's category in lower case — and reword it if the failure
   has a better name; set `group` when two cases must stay on one side of the split.
4. Delete the `candidate` block, and append the line to `evals/corpus/dev.jsonl` (may be tuned
   against) or `evals/corpus/test.jsonl` (never tuned against).
5. `npm run eval -- plan` loads the corpus through the same check and refuses a line that is not a
   task, or an input that is now on both sides.

The golden tasks (`agentbox golden`) are written in code and scored by the state a box ends in; a
case that needs a real box is written there by hand, with the candidate as its brief.

## A run

```
npm run eval -- plan      # what it will cost in calls; makes none
npm run eval -- run       # the test split, 3 attempts a task, on the configured provider
```

`run` is the one command that spends money. On the test split as it stands it makes **at most 672
model calls**, 75 tasks × 3 attempts × the most calls an attempt can make, **and then 87 judge
calls**.

| subject | tasks | calls per attempt | at most | model |
|---|---|---|---|---|
| `episode` | 47 | up to 4 (one task up to 12) | 588 | the agent's own |
| `steward` | 15 | 1 | 45 | the cheap side-call model |
| `auto-review` | 9 | 1 | 27 | the cheap side-call model |
| `teach` | 4 | 1 | 12 | the agent's own |
| judges | 29 | 1 | 87 | the cheap side-call model |

An episode stops at its cap and usually ends sooner. `--no-judges` leaves the last row out.
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

## Judges, and when one may be believed

Passing is decided by code graders. What code cannot decide — whether a reviewer's reason rests on
what the person said, whether a taught skill could be followed by someone who never saw the
demonstration — is asked of a judge, second and apart:

- **One yes-or-no question per failure type** (`JUDGE_QUESTIONS`): is this failure present in this
  output. Never a score. A failure type that code decides completely, such as which skill was
  opened, has no question.
- **A verdict must quote the output.** Code looks for the quote in the text the judge was shown; a
  verdict whose quote is not there is `invalid`, counted apart, neither yes nor no.
- **The judge is on the record**: its provider, model and the version of its questions. A
  reworded question is a different judge.
- **A verdict never changes the pass rate.** Verdicts are shown beside it.

A judge is a model's opinion until it has been held against a person. To calibrate:

```
npm run eval -- label-sheet ~/.agentbox/scorecards/eval-test-<time>-<commit>.json
```

writes `evals/labels/labels-<date>.jsonl`: thirty outputs of the test split, spread over the
questions and over the judge's two answers, each with the question, what the system was given and
what it answered — and without the judge's verdict. On each line a person sets `"label"` to
`"present"` or `"absent"` and `"by"` to their name, and commits the file. A line left unfilled is
not a label. A label is about an output, matched by its digest, so the same labels check any
judge that answered that question on that output.

From the labels, per question: Cohen's kappa, and the catch rate — of the outputs a person said
have the failure, the share the judge found. An `invalid` verdict counts against the judge. Two
people labelling one output differently leaves it out.

- Under **30** matched labels nothing is calibrated: every page and the scorecard say **judge not
  calibrated — may not gate**. There are no labels in the repository today, so that is what every
  page says.
- With 30 or more, a question **may gate** at kappa **0.6** or above on at least 10 of its own
  labels; otherwise it is marked **may not gate** with the reason.

## The judges in the product, and when one may be believed (INV-1773)

The same rule holds for the judges that run in the product, on live verdicts rather than corpus
outputs: the auto-review of binding tool calls, the answer review of replies, the memory judge of
candidate memories, and the decision model wherever its switch is on or in shadow.

**Every verdict names its judge where it is written.** `auto-review.jsonl`, `answer-review.jsonl`,
`memory-judge.jsonl` (new: one line a candidate and question) and `jev-shadow.jsonl` carry `judge`,
`judgeModel`, `judgeVersion` (a digest of the words the judge is asked with), `question` and
`evidence` — what it read, by name, and the digest of the judged output. Never the text: the
ledgers keep the hashes they kept before. Each question is put so that yes is the failure the judge
acts on (`auto-review:unauthorised`, `answer-review:not-answered`, `memory-judge:<question>`), and
the normalised answer is `judged`: `present`, `absent` or `invalid`.

**One label format, one kappa.** A person's labels are `HumanLabel`s, matched to verdicts by
question and output digest and held against them by `calibrate()`, exactly as above. They differ
from the corpus labels in two ways: they are kept in `~/.agentbox/judge-labels.jsonl`, written by
the labelling page and never committed, because their outputs are people's conversations; and their
question names the judge, because the product's questions are not the corpus's failure types.
Because a label is about an output, the label a person gives under the point's own judge also
checks the decision model's shadow answer on the same output. A judge's standing reads only the
verdicts of its current model and question version.

**What a standing changes.**

- **Not calibrated** — under 30 matched labels for the judge or 10 on the question, or one answer
  throughout: nothing. Every gate behaves exactly as it did before labels existed, which is every
  judge on a fresh installation.
- **Measured under 0.6** — the verdict is a hint, never a gate. An enforced auto-review BLOCK is
  not refused by the reviewer: the policy gate asks a person, with the reviewer's reason among why
  (no allow rule lifts it). A memory-judge verdict may still hold a candidate for a person, which is
  asking one, but may not act on its own: a duplicate it finds is held instead of dropped, a
  contradiction it is sure of is held instead of withdrawing the known line.
- **Measured under 0.8** — it may not release anything on its own in a routine nobody watches. No
  judge does today — the policy gate stands under every auto-review ALLOW — so this is the answer
  `releasesUnattended` gives the work that would let a reviewer approve in a person's place.

**The answer review measures satisfaction.** It reads the request and the reply and nothing the
agent did, so it says whether a reply looks like it serves the person, not whether the work was
done. Its records say `measures: "satisfaction"`, the page labels it so, and nothing that counts
completed work may count it. The auto-review, which reads the call and what authorised it, is not
that and stays as it is. A guest's answer is reviewed as before and leaves nothing outside the
guest's own record, not even a digest, so it is never labelled and never calibrated.

**The labelling page** (Settings → Supervision, an admin's) shows every judge's labels, kappa,
catch rate and false-kill rate — of what the person called fine, the share the judge would have
stopped — and what that lets it decide; then the latest unlabelled verdicts, spread over the
questions and the judge's two answers (`spreadForLabelling`, shared with the corpus sheet), each as
the judge's question with yes and no and without the judge's answer. It shows only text the
installation already keeps readable, and only when its digest is the verdict's: the message and
reply from the transcript and the door's ledger, found as `agentbox eval candidates` finds them; the
call from the transcript by its tool_use id, with the person's latest words before it; the memory
line from the agent's memory ledger. Everything shown is scrubbed of held values and credential
shapes. The failing replies INV-1474 keeps are not read. Whether a memory duplicates or contradicts
another needs the line it was compared with, which is not kept, so those two questions are recorded
and never put to a person: they stay not calibrated and decide as before.

## The release scorecard and the golden tasks

`npm run release:scorecard -- --eval <record> [--eval-baseline <earlier record>]` fills the
scorecard's `model` entry from a record instead of leaving it `skipped`: the pass rate and its
interval, pass^k, the comparison, the detectable difference, and the judges' standing. REVIEW
there is a drop beyond noise (accepted by a named person with `--accept "eval=<name>"`); a
comparison that settles nothing is INCOMPLETE. A stand-in's record, or one of the dev split,
leaves the entry `skipped` and says why.

`agentbox golden <provider>` now keeps each run as
`~/.agentbox/scorecards/golden-<model>-<time>.json`, and `agentbox golden --trend` prints, per
model, each task's last runs side by side and the latest run against the one before under the
same rule: one red row is INCOMPLETE, not a regression.

## Comparing two versions of the prompt and tools

A change to `src/host/prompt.ts` or to a tool's description changes behaviour with no diff a
reviewer can read the effect from. This puts the two versions on the same tasks:

```
npm run eval -- plan --compare origin/main HEAD    # what it will cost; makes no call
npm run eval -- --compare origin/main HEAD         # base, then candidate
```

**It costs twice a plain run** where the two versions send different requests: every task runs on
both. On the corpus as it stands that is at most 1,752 model calls (876 a version: dev and test,
3 attempts). `plan --compare` prints the figure; the run prints it again before a provider is read.

How the two are kept apart, and what they share:

- **Each version is that commit's product.** `freezeRef` (`frozen.ts`) exports the commit's tree
  into a scratch directory with `git archive` — nothing is registered in the repository, so no
  worktree can be left behind in a checkout other sessions use — lays this checkout's `src/evals/`
  over it, and imports the subjects from there. They reach the product by relative import, so
  they drive that commit's prompt, tools and parsers. The scratch tree is removed afterwards.
  Packages are this checkout's; a commit whose `package-lock.json` differs is refused.
- **The tasks and graders are the running checkout's, for both.** A commit's own corpus is never
  read: a task worded differently on each side is two questions. The page says when a commit's
  own corpus differs from the one used. Dev and test are both run and shown apart — dev is what
  the prompt may have been tuned against, so a gain that test does not show is the tuning.
- **One cache, keyed by the request.** Nothing in a key names a side. The system prompt and tool
  list are in every request an agent sends, so versions that differ there never share an entry.
  A request both send byte for byte alike — the steward's, when only the agent's prompt changed —
  is asked once and answered the same on both sides: asking twice would pay for noise the change
  did not cause. A commit compared with itself therefore costs one run and shows no difference.
- **`promptSurface`** (`surface.ts`) is what a version sends: the system prompt and the tool list
  of one agent configuration, read off the first request of a real turn. The page prints its size
  and digest for each side, and says so when the two are the same. It also gives the prompt's two
  halves — before and after the cache breakpoint — and their bytes, and can read a turn nobody is
  waiting on (`unattended`); the size ratchet (`scripts/prompt-ratchet.mjs`, `prompt-baseline.json`,
  run by `npm run arch`) holds those numbers for four configurations so they only shrink (INV-1857).

The page (`docs/evals/COMPARE-<date>-<base>-<candidate>.md`, to be committed; the record goes to
`~/.agentbox/scorecards/compare-…json`) gives both pass rates with their intervals; the
difference — the mean over tasks of the change in each task's own pass rate — with its interval;
McNemar over tasks that passed every attempt on one side and not on the other, with the same
REVIEW / INCOMPLETE reading as above; the tasks that got worse and better with what the graders
found; and the cost per passed attempt on each side.

**The gate is red** when either holds:

- the pass rate fell and the whole 95% interval of the difference is below zero;
- more than `--max-broken` tasks (default 0) went from passing every attempt to passing none.

The second catches a change that breaks some tasks outright while fixing others, which the first
averages away. It counts outright breaks rather than every task that got worse, because tasks
change sides by chance: at one failed attempt in ten, two runs of the very same version disagree
on about a fifth of the tasks, and a count of those would be red on noise. `--max-worse <n>` adds
that count for whoever wants it. A task the harness failed on either side is left out of the
pairing and named.

**The gate reads code graders only.** No judge is asked in a comparison: none is calibrated, so
none may gate. Not red is not safe — a fall smaller than the detectable difference passes unseen,
and the McNemar line says INCOMPLETE and how many tasks would settle it.

`--fake` runs the whole comparison on the stand-in. The stand-in opens a skill only when the
request it is sent still lists that skill and still carries `read_file`, so a version whose prompt
dropped either fails those tasks; otherwise it draws its wrong answers afresh for each distinct
prompt, as a model would. Its page is marked as no measurement and is refused in `docs/evals/`.

The pull request template asks a change to the prompt or to a tool's description for this page.
That is a request to the author; no check enforces it.

## Not a gate

CI does not run this and nothing in CI gates on it. The comparison's gate is read by a person on a
page. A gate on a single run comes after a measured run, sized against the detectable difference
that run reports, and on a judge's verdict only for a question marked "may gate".
