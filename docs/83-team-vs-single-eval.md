<!-- doc: 83-team-vs-single-eval
     title: Team versus one agent: the first measured comparison
     family: decision
     status: current
     updated: 2026-10-24
-->

# Team versus one agent: the first measured comparison

**INV-1340, 2026-10-24.** **Question:** is the default four-agent team (Ada coordinator, Rex
researcher, Ops operator, Vera reviewer) better than one agent holding the union of their
tools, on the daily tasks this installation actually sees? Anthropic's "Building agents"
(2026-10-22, INV-1339) reported that a single agent plus skills usually wins on quality,
latency and cost against a team split by problem type. Ours is split by problem type. Until
today "the team is better" was a belief.

**Status of this document:** a first run, one agent model, one judge model that answered
reliably. The numbers are enough to say something about *cost* with confidence and about
*quality* with care. Not enough to change the default on their own; see §6.

## 1. Method

- **Harness:** `scripts/team-vs-single-eval.mjs` + `scripts/team-vs-single-tasks.mjs`. A
  scratch `AGENTBOX_HOME` per episode; a dedicated box (`AGENTBOX_CONTAINER=lumenbox-eval-box`,
  the script refuses the live box unless told); each task in its own directory under
  `/home/box/work/eval-inv1340`, removed afterwards. Re-runnable; never part of `npm test`.
- **Tasks:** twelve, shaped after what the last 45 days of real turns were about (recounting
  reported numbers, verifying a claim against files, a brief from sources that disagree,
  reviewing a patch, making a script run, converting data, tidying a folder, a status card, a
  migration plan on the task board, a policy fact-check, writing and running tests), with
  synthetic data so no transcript text travels. Each has automatic checks (file exists, number
  right, tests pass, source untouched…) and a rubric for the judges.
- **Configurations:** **T** = `STARTER_TEAM` as shipped; **S** = one agent named Ada with Ada's
  tool list and a description that folds the three remits in and says to do the work herself.
- **Runs:** two per task per configuration; 48 episodes. Agent model MiniMax-M3.1-Flash (the
  installation's configured provider). Wall clock, model calls, tokens (input + output + cache),
  tool calls, `SendToAgent` count and the number of agents that ran are recorded per episode.
- **Judges:** blind pairs (team run *n* against single run *n*, order randomised, labels hidden),
  rubric plus automatic-check results plus each side's final message and delivered file.
  Intended panel: three MiniMax models. In practice **MiniMax-M3 answered 19 of 24 pairs**;
  MiniMax-M2 is no longer served (404 on every call); M3.1-Flash truncated its JSON at the
  600-token cap in 16 of 24 calls (cap raised to 1500 afterwards; the parser now takes the last
  JSON object). Quality columns below are therefore one judge's view.

## 2. Results

| task | kind | checks T/S | quality T/S | seconds T/S | tokens T/S | calls T/S | teammate msgs T | judges T:S:tie | flipped |
|---|---|---|---|---|---|---|---|---|---|
| recount | numbers | 0.5 / 1 | 3 / 5 | 410 / 417 | 605k / 775k | 20.5 / 20 | 1 | 0:1:1 | **yes** |
| largest | files | 1 / 0.8 | 4.5 / 4 | 13 / 36 | 123k / 170k | 5.5 / 7.5 | 0 | 1:1:0 | **yes** |
| brief | research | 1 / 1 | 4 / 4 | 209 / 209 | 665k / 628k | 23 / 23.5 | 0 | 0:1:1 | |
| review | review | **— / 1** | — / — | **never settled / 90** | — / 410k | — / 15.5 | — | 0:0:0 | **yes** (T failed both runs) |
| fixscript | operate | 1 / 1 | 2.5 / 3 | 1985 / 1072 | **30.5M / 18.5M** | 250 / 70 | 1.5 | 0:2:0 | |
| verify | review | 1 / 1 | 5 / 3.5 | 61 / 153 | 229k / 1.0M | 11 / 27 | 1 | 2:0:0 | |
| convert | operate | 1 / 1 | 5 / 5 | 11 / 16 | 96k / 119k | 5 / 6 | 0 | 1:0:2 | |
| tidy | ambiguous | — / — | — / — | — / — | — / — | — / — | — | 0:0:0 | both failed, §2.1 |
| card | person | 1 / 1 | 4 / 4.5 | 34 / 73 | 111k / 246k | 5.5 / 10 | 0 | 1:1:0 | |
| plan | coordinate | 1 / 1 | 4 / 5 | **2189 / 200** | **23.6M / 799k** | 181 / 24 | 1 | 0:1:0 | (T failed one run) |
| factcheck | research | 1 / 1 | 5 / 5 | 12 / 28 | 58k / 87k | 3 / 4.5 | 0 | 0:0:2 | |
| testit | operate | 1 / 1 | 4.5 / 4 | 1492 / 1179 | 11.3M / 15.6M | 108 / 160.5 | 1.5 | 1:1:0 | |
| **mean (11 tasks)** | | 0.9 / 1.0 | 4.2 / 4.3 | **641 / 316** | **6.7M / 3.5M** | **61 / 34** | 0.6 | 6:8:6 | 3 |

T = team, S = single. *checks* = share of automatic checks passed; *quality* = judge mean 1–5;
*flipped* = all checks passed under one configuration and not the other. Means are over the
eleven tasks with at least one completed run per side; "never settled" = the orchestrator's
600 s idle timeout, counted as a failure.

### 2.1 The tidy task: no result, twice, for two reasons

All four `tidy` episodes failed in the main run, and all four again in a rerun with the fixture
changed. The first reason was the harness: fake `.png` files that the agent read with
`read_file` went to the model as images. The second is the product's: with text-only files,
both configurations spent 60–90 tool calls reading and listing a six-file folder (the same
loop as §3.4), then called `computer`, and the screenshot was refused by MiniMax as
"invalid image content … unknown format"; the turn died on the request instead of retrying
without the image. Two things to take from the row: the ambiguous task is where the loop is
worst, and a model request that fails on an image attachment should not end the turn
(candidate for a bug, not filed from this document).

### 2.2 Per-episode numbers

Raw per-episode table (seconds, calls, tokens, tool calls, teammate messages, agents that ran,
checks) is in `research/2026-10-24-inv1340/eval.json`; the rows that carry the conclusion:

| episode | agents that ran | teammate msgs | calls | tokens | outcome |
|---|---|---|---|---|---|
| fixscript #1 T | 2 | 2 | 362 | 49.4M | passed, after 2016 s |
| fixscript #1 S | 1 | 0 | 100 | 35.2M | passed, 1894 s |
| fixscript #2 T | 2 | 1 | 138 | 11.5M | passed, 1954 s |
| fixscript #2 S | 1 | 0 | 39 | 1.7M | passed, 249 s |
| plan #1 T | — | — | — | — | never settled |
| plan #2 T | 2 | 1 | 181 | 23.6M | passed, 2189 s |
| plan #1/#2 S | 1 | 0 | 30 / 18 | 1.1M / 0.5M | passed, 224 / 176 s |
| review #1/#2 T | — | — | — | — | never settled (948 s, 2098 s) |
| review #1/#2 S | 1 | 0 | 20 / 11 | 560k / 261k | passed, 95 / 85 s |
| recount #1 T | 1 | 0 | 10 | 343k | **0/3 checks**: no file, asked instead |
| recount #2 T | 2 | 2 | 31 | 868k | passed |
| testit #1 S | 1 | 0 | 255 | 29.3M | passed, 1815 s — the single agent's own runaway |

## 3. What the numbers say

1. **When the coordinator worked alone, the two shapes were the same system.** In 8 of 11
   tasks every team run was Ada by herself (one agent ran, zero teammate messages). Those rows
   differ only by noise, and the team is slightly *cheaper* there because its coordinator prompt
   is shorter than the single agent's merged description.
2. **Every delegation cost three to ten times the calls and tokens, for no quality the judge
   could see.** The five episodes in which a second agent ran (fixscript ×2, plan #2, recount #2,
   testit ×2, verify #2) are the five most expensive team episodes; fixscript #1 T made 362
   model calls and 49 M tokens where S made 100 and 35 M (both too many — see 4). The judge
   preferred S in fixscript twice and plan once, T in verify twice.
3. **The team's failure mode is not a wrong answer but no answer.** Three team episodes never
   settled: both `review` runs and one `plan` run. `review` is the task whose shape most invites
   a handoff (Ada → Vera), and the handoff never came back within ten minutes. The single
   agent finished the same review in 85–95 s with 3/3 checks. `recount #1 T` is the other no-answer:
   Ada asked the person instead of writing the file. These are the three flips, and all three go
   against the team.
4. **Runaways are a model problem the team amplifies.** With MiniMax-M3.1-Flash both shapes
   fell into read/list/fetch loops on the three "operate" tasks (fixscript, testit, plan): 90–294
   `WebFetch` calls in single episodes, 247 `read_file` in one team episode. The single agent
   did it once (testit #1); the team did it in five episodes. The INV-1277 hop budget bounds
   messages, not an agent's own looping. This is the finding the harness was not built for and
   is the most actionable one.
5. **Quality was flat.** 4.2 vs 4.3 on the judge's scale, 6:8:6 in pairwise preference; the
   judge's one-line reasons are about verbosity, unnecessary questions and files written
   outside the directory — conduct, not correctness. Automatic checks agree: 0.9 vs 1.0, with
   the gap entirely from the three no-answer episodes.

## 4. What this does not show

- One agent model, and a weak one. A stronger model may delegate better and loop less; the
  *shape* of the result (delegation = cost, no-answer = the team's failure mode) is what to
  re-test, not the magnitudes.
- One judge that answered. The panel was meant to be three; the quality columns are one model's
  reading of final messages and files, not a human's.
- Twelve synthetic tasks, each run twice. Enough to see 10× cost differences; not enough to
  rank a 4.2 against a 4.3.
- No external services, no browser-heavy task, no long multi-day task — the places a team
  with distinct identities might earn its keep (memory per role, parallel work) were not
  exercised.

## 5. Recommendation

Do not change the default from this run alone, but the burden of proof has moved. The team
as shipped earns nothing on daily tasks: it is the same system when Ada does not delegate and
a worse one when she does. Three things, in order:

1. **Bound an agent's own loop** the way INV-1277 bounds hops: a per-turn ceiling on model calls
   and on repeated identical tool calls, with the ceiling reported to the person. Both shapes
   need it; the team needs it more. This is the cheapest win in the table.
2. **Re-run this eval with a stronger agent model and a real three-model panel** (keys for two
   more providers are needed; the script takes `--judges provider[:model],…`). If the team still
   fails to settle on review-shaped tasks, the handoff path has a bug, not a philosophy problem.
3. **Then decide the default**: single agent for new installations with the team as a catalog
   template, or team with Ada told never to delegate a task under a size threshold. The data so
   far favours the first.

## 6. Reproducing

```
node --experimental-transform-types scripts/team-vs-single-eval.mjs [--box create|keep|use <name>] [--image build] \
  --runs 2 --judges minimax,minimax:MiniMax-M3 --json out/eval.json --md out/eval.md
```

**The box** (INV-1370, `scripts/lib/eval-box.mjs`): by default the script creates its own
`lumenbox-eval-<run>` box and removes it when the run ends — success, failure or Ctrl-C — after
printing what it removes (container, its three volumes, network, token file, and any image
`--image build` made). It removes only names under `lumenbox-eval-` that this run created.
`--box keep` leaves the created box running; `--box use <name>` (or `AGENTBOX_CONTAINER`)
attaches to an existing box and removes nothing; `--image build` first builds the current
Dockerfile as `lumenbox-eval:<version>` with every engine pinned; `--live-box` means the default
box, on purpose.

`--dry-run` prints the plan without a model call; `--only <task> --config team|single` narrows;
`--keep-text` stores the agents' final messages in the JSON (never the turns).

## 7. Appendix: the runaway tasks after INV-1353 and INV-1354 (2026-10-25)

Same harness, same model, the two tasks that ran away in §2, one run each, with the image
refusal recovered (INV-1353) and the per-turn budget in place (INV-1354, defaults 60 calls /
3 repeats). `longest turn` is the most model calls any single turn in the episode made — what
the budget bounds; `calls` is the episode total across the main turn and its `Delegate` forks,
each of which has its own budget.

| episode | seconds | calls | longest turn | tokens | checks | before (§2.2) |
|---|---|---|---|---|---|---|
| fixscript T | 28 | 8 | — | 176k | 2/2 | 2016 s / 362 calls / 49.4M |
| fixscript S | 1010 | 81 | — | 5.9M | 2/2 | 1894 s / 100 calls / 35.2M |
| testit T | 122 | 31 | — | 769k | 3/3 | 1632 s / 99 calls / 13.0M |
| testit S | 544 | 107 | — | 4.4M | 3/3 | 1815 s / 255 calls / 29.3M |
| testit S (second run, metric added) | 540 | 88 | **54** | 4.2M | 3/3 | |

No turn reached the ceiling (no `turn_budget_hit` in any log; the measured longest turn was
54 of 60). The episode totals above 60 are three or four turns — the single agent delegated to
forks three times in the last run — each under its own budget. Two readings: the budget did
not fire, so it cost nothing here; and an agent that cannot loop past 60 calls in one turn can
still spend 88 across turns it spawns, which is INV-1277's territory. Tokens fell 5–10× against
§2.2 for the same tasks, but with one run each that is a direction, not a measurement; the
earlier runaways were themselves outliers. The 1010-second fixscript S episode is the number
to watch in a full re-run.
