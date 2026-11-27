<!-- doc: 105-terminal-benchmark
     title: LumenBox on a public terminal benchmark: the Harbor adapter, the eval toolset, and the first run
     family: guide
     status: current
     updated: 2026-11-27
-->
# 105 — LumenBox on a public terminal benchmark: the Harbor adapter, the eval toolset, and the first run

How to put LumenBox through a public, third-party agent benchmark, how to read the numbers, and
what the first run found. docs/100 measures LumenBox against its own corpus, a judgment of its
own conduct. This page is the opposite: someone else's tasks, someone else's verifier, scored
the way the benchmark scores every other harness.

The benchmark is **FrontierHarness Eval v1.1** (`github.com/frontier-harness-eval/eval`,
leaderboard at `frontierharness.org/leaderboard/v1.1/`): 62 command-line tasks in one
[Harbor](https://github.com/harbor-framework/harbor) dataset, each a Docker image with a
verifier. The leaderboard holds 22 harness configurations on five open models. Why this one
first, and not the other public boards: INV-2190.

## What is where

| | where | what it does |
|---|---|---|
| bundle | `scripts/harbor/build-bundle.sh` | builds the CLI and `boxd` from this checkout into one tarball, `lbx.tgz` |
| suite | `scripts/harbor/mini-suite.json` | a Harbor job config: 10 tasks × 2 attempts × three harnesses on one model |
| summary | `scripts/harbor/summarize.py` | pass rate with a bootstrap interval per harness, time, tokens, cost, a task × harness grid |

The suite runs in a clone of the benchmark's repository, which brings the `CommandAgent`
adapter (`adapters/command_agent.py`) that runs a harness from install and run scripts.

## How LumenBox runs in a task container

The task container is the computer: LumenBox runs inside it the way it runs inside a box.

1. **Install.** Node 24 (the container's architecture), then the bundle into `/opt/lumenbox`.
2. **The box daemon.** `boxd` starts on `127.0.0.1` with a random token and the task's working
   directory as its work dir. It runs **not headless**: headless `boxd` refuses every command
   without `bwrap`, and the container is already the wall, so no confinement is layered on it.
3. **A temporary home.** `AGENTBOX_HOME` is a fresh directory in the trial's state, never the
   operator's. The provider and model come from `AGENTBOX_PROVIDER` / `AGENTBOX_MODEL`, the key
   from the environment the job passes in (`${MINIMAX_CODE_CN_API_KEY}` in the suite, never a
   literal).
4. **The starter team.** One `chat </dev/null` creates it; then the eval toolset (below).
5. **The task.** `chat Ada "<instruction>"`, the instruction exactly as the benchmark gives it.
6. **Records.** The home is copied into the trial's logs every 60 s and on exit, so a trial the
   benchmark kills at its timeout still leaves its turns, tasks and policy decisions behind.

### The eval toolset

The benchmark does not forbid the web: every task here has `allow_internet = true`. What a task
container lacks is a display. An agent offered `computer` or `browser_*` in it reaches for the
desktop, the desktop cannot start, and the request waits for a tool that will never come
(found on dna-insert, below). So the run removes the desktop tools from every starter agent's
allow-list — `computer`, `browser_*`, `HandOverDesktop`, `WaitForControl` — the same setting
as switching them **off** in the agent's tool chips (`AgentProfile.tools`, host/tool-permissions.ts).
`WebFetch` and `WebSearch` stay: the network is allowed and they need no desktop. Nothing else
changes: the policy gate, the autonomy level, the consent rules are the product's.

## How to run it

```bash
git clone https://github.com/frontier-harness-eval/eval fhe && cd fhe && uv sync --locked
scripts/harbor/build-bundle.sh "$PWD"          # from the LumenBox checkout; prints the commit
cp <lumenbox>/scripts/harbor/mini-suite.json suites/   # set the lumenbox agent's version to that commit
MINIMAX_CODE_CN_API_KEY=… .venv/bin/harbor run -c suites/mini-suite.json -o jobs -y -q
python3 <lumenbox>/scripts/harbor/summarize.py jobs/lumenbox-minimax
```

Local Docker is enough for the mini suite (12 CPU / 16 GB ran 4 trials at a time). The key is
read from where it lives and passed on the command line; check a finished job directory for it
before keeping or sharing one (`grep -rlF "$KEY" jobs/` must print nothing).

## Reading the result

- **A trial is scored when the verifier graded it.** A timeout is graded, as upstream does: the
  verifier runs on whatever the agent left. A trial that never reached the agent (an image pull,
  an `apt-get`, the model endpoint unreachable) is an infrastructure error: it is rerun, not
  scored. `harbor jobs resume -p <job> -f NonZeroAgentExitCodeError -f NetworkConnectionError -f
  RuntimeError` removes exactly those and runs them again; back the job directory up first,
  because it deletes them. Read the error before filtering: a harness that exits non-zero on its
  own is a failure, not infrastructure.
- **The interval is over tasks.** Ten tasks make a wide one. When the intervals overlap, the run
  has not said which harness is better, whatever the point estimates say.
- **Not comparable to the leaderboard.** The leaderboard runs five models on Baseten at effort
  `max`, 4 attempts, a fresh Runta runtime per trial with a 32 GB disk, all 62 tasks. The mini
  suite runs one model, 2 attempts, 10 tasks, local Docker. It compares harnesses with each
  other on the same model; it does not place LumenBox on the board.

## The first run (2026-11-26/27)

MiniMax-M3.1-Flash for all three harnesses; the two reference harnesses are entries on the
leaderboard at its published versions (MiniMax Code 0.6.13, Pi 1.4.0), through the same
OpenAI-compatible endpoint. LumenBox at ed2b2667. Rates: $0.15 / $0.60 / $0.015 per million
input / output / cache-read tokens.

| harness | passed | 95% interval | median time | per trial |
|---|---|---|---|---|
| LumenBox | 13/20 = 65% | 40–85% | 184 s | $0.024 |
| MiniMax Code | 15/20 = 75% | 50–100% | 177 s | (reports no tokens) |
| Pi | 11/20 = 55% | 35–75% | 162 s | $0.037 |

The intervals overlap: twenty trials do not separate the three, consistent with the
leaderboard's own finding that the model explains most of the variance and the harness little.
LumenBox wrote 231k output tokens across its twenty trials against Pi's 608k.

Per task (✓ pass, · fail; two attempts each):

| task | LumenBox | MiniMax Code | Pi |
|---|---|---|---|
| chess-best-move | ·✓ | ✓✓ | ·✓ |
| code-from-image | ✓✓ | ✓✓ | ·✓ |
| constraints-scheduling | ✓✓ | ✓✓ | ✓✓ |
| dna-insert | ·· | ·· | ·· |
| fix-git | ✓· | ✓· | ✓· |
| gcode-to-text | ·✓ | ·· | ·· |
| log-summary-date-ranges | ·· | ✓✓ | ·✓ |
| openssl-selfsigned-cert | ✓✓ | ✓✓ | ✓✓ |
| regex-log | ✓✓ | ✓✓ | ✓✓ |
| sqlite-db-truncate | ✓✓ | ✓✓ | ·✓ |

At 15:35 the machine's network dropped for every container at once; the 36 trials it broke were
rerun as above, and the run ended with 60 of 60 scored.

### What LumenBox's seven failures were

- **Four were one product bug (INV-2192).** The autonomy level is inferred from the task's
  words; "analyze all logs … Write a CSV file /app/summary.csv" read as *analyse and propose*
  (L2), so the policy gate refused `bash` and `write_file` and Ada handed back a correct script
  instead of the file. log-summary-date-ranges and dna-insert both hit it, twice each. Fixed in
  #832: a task that names an output file or uses a verb that leaves something behind is the
  work itself. Run on the ten instructions, the old rule gave two of them L2 and the new one
  gives all ten L4. Rerun with the fix: log-summary-date-ranges 2/2.
- **Two timeouts** (chess-best-move, gcode-to-text, one attempt each). They left no records,
  which is why the home is now copied every minute.
- **One real miss** (fix-git: a file in the wrong state).

### What the fix's rerun found on dna-insert

At L4, with nothing refused, dna-insert still failed — as it did for both other harnesses. One
attempt designed primers whose melting temperatures were 8.2 °C apart (the verifier allows 5);
the other is the reason for the eval toolset: Ada opened the browser to read a vendor's primer
guidance, the desktop could not start, and the request then waited for the missing tool and
refused the `write_file` that would have delivered what it already had.

Rerun with the eval toolset (two attempts, the fix included): Ada was offered 21 tools and no
desktop one, worked in `bash`, and passed one attempt — the only pass on dna-insert by any of
the three harnesses in this run. The other timed out at 30 minutes with primers 5.7 °C apart.
Both ran long: $0.43 per trial against the first run's median of $0.024, most of it re-reading
a context that had grown to 25M cache-read tokens. It also looked for a browser through
`FindMcpTool` three times; the gate refused each (it needs a person), which is the right answer
and cost nothing but the turn.

## Limits

- Ten tasks and two attempts: a smoke test of the adapter and a source of bugs, not a ranking.
- One model. A harness comparison is only meaningful on the same model; a second model is a
  second table, not a column.
- The adapter runs Ada alone on the instruction. Delegation to an external coding engine is on
  the agent's tool list; a run that delegates measures that engine, and the record says so.
- A call that needs a person's approval has nobody to give it. In these runs the gate refused it
  at once ("This needs a person's approval before it can run") and the agent went on without
  it; nothing is approved on anyone's behalf.

## Next

- The full 62 tasks × 4 attempts on the leaderboard's own models is the comparable run (INV-2190
  has the cost estimate); it waits on a decision to spend it.
