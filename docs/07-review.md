# Review against the specification

Reviewed against [01-requirements.md](01-requirements.md) through
[06-deployment.md](06-deployment.md). Every finding below was verified against the running
system or the source, not inferred from the documents.

**Verdict: it does not meet a product-grade standard yet.** Nine findings, three of them
blocking. R-01, R-02 and R-07 are fixed and R-03 is half fixed — measured but not bounded; the rest
stand. What it does meet is a higher standard than that summary suggests in one specific
respect — the failure behaviour is genuinely engineered and tested — and a lower one in another:
there is no cost control at all.

## Requirement coverage

| | Requirement | State | Evidence |
| --- | --- | --- | --- |
| F1.1–1.4 | Desktop, input, unicode, capture | met | 38 smoke checks |
| F1.5 | Windows: list, activate, per-window capture, click | met | covered window driven by its own coordinates |
| F1.6–1.8 | Shell sessions, files, clipboard | met | round-trips asserted |
| F2.1–2.6 | Agents, messaging, priority, serialisation, desktops | met | unit + smoke |
| F3.1–3.3 | Watch, take over, readable conversation | met | verified in the box's own browser |
| F3.4 | Activity survives restart | met | on disk with timestamps |
| F3.5 | Recording | met | decoded with ffprobe |
| F3.6 | Self-diagnosis | met | 15 checks, fails dirty |
| F4.1–4.3 | Provenance | met | real blocks, screenshots noted |
| F5.1–5.2 | Create, restart | met | stale-lock sweep |
| F5.3 | Upgrade preserves work | met | R-01 fixed |
| F5.4 | Provisioner replaceable | met | full suite with no Docker on PATH |
| N1.1–1.2 | Capture latency | met | 185ms idle, 189ms saturated |
| N1.3 | Live view within a second | **unverified** | R-06 |
| N2.1–2.3 | Crash isolation, abandonment, crash records | met | measured by killing things |
| N2.4 | Work loss needs an explicit act | met | R-01 fixed |
| N3.1–3.4 | Isolation | met as scoped | limits stated, not overstated |
| N4.1–4.3 | Honest failure | met | three no-op tests found and fixed |
| N5.1–5.4 | Operability | **partial** | R-05 |

Not in the requirements and it should be: a long-lived agent's history has to stay sendable. Added
as the fix for R-07 and worth promoting to a requirement of its own.

## Blocking findings

### R-01 — An agent's work outside `/home/box/work` is destroyed by an upgrade — **fixed**

`grep '/home/box/work' src/host/prompt.ts` → 0. Nothing tells an agent where to put things that
must survive. `/home/box/work` and `/home/box/.config` are volumes; everything else, including
`/home/box` itself, is the container layer, which `--recreate` discards — and `--recreate` is
what upgrading means.

An agent asked to "write the report" will reasonably write `~/report.md` and lose it on the next
upgrade, with nothing to indicate that happened. This violates N2.4 and F5.3, and it is the
failure mode this system is otherwise built to avoid: silent.

Fixed: the prompt now says where work that must survive goes and why, and `box-doctor` warns when
files sit directly in `/home/box`, naming them. Both directions are in the smoke test.

### R-02 — In the self-contained topology, a dead UI reports a healthy container — **fixed**

`HEALTHCHECK` runs `curl -fsS http://127.0.0.1:1337/health`, which is boxd only. With
`--with-host`, the orchestrator is the product — the only thing outside the container is a
browser — and it can be crash-looping while the container reports healthy and the restart policy
stays quiet.

Fixed: `box-healthcheck` covers boxd and, when the orchestrator is enabled, its UI — treating 401
as healthy, since a UI refusing correctly is serving. Verified by holding the orchestrator down:
the check fails during, and passes once it is allowed back. Two of my own bugs on the way, both
in the test rather than the product: an error message that printed the status twice, and a `pkill`
whose pattern matched the shell running it, so the kill loop killed itself — the fourth time that
trap has bitten in this project.

### R-03 — No cost control of any kind — **partly fixed: measured, not yet bounded**

A turn may run 400 rounds. An agent may message teammates, each of which takes its own turn, and
those may create more agents. Nothing bounds spend per turn, per agent, per box, or per hour;
nothing reports what a turn cost; nothing stops a loop between two agents that keep waking each
other.

This is not a hypothetical: fire-and-forget messaging with priority interrupts is exactly the
shape that produces a loop, and the only thing stopping one today is that the models happen to
stop. For a product that spends the owner's money per token, this is a blocking gap.

What makes this worse than a missing feature: the data is already there and thrown away. Every
round emits a `usage` event carrying input, output, cache-read and cache-write tokens — and
`grep 'type === "usage"'` finds no consumer anywhere. Nothing displays it, aggregates it, or
writes it down. The transcripts contain the word only inside tool output.

Done: the event is consumed. Every round appends a record — agent, provider, model, round, and all
four token counts — to `usage.jsonl` beside the transcripts, and the UI shows a running total while
a turn is spending rather than after. `GET /api/usage?since=<seq>` is shaped for the collector in
[08-control-plane.md](08-control-plane.md) §8: monotonic sequence numbers that survive a restart and
a torn line, so a reader remembers an offset instead of a timestamp and catches up rather than
double-counting.

Deliberately not done: prices, budgets, and a wake-rate limit. A record says tokens; what a token
costs belongs to whoever bills. **Nothing yet stops a runaway**, so the finding stays open — but it
is now open on enforcement rather than on visibility, and the format the control plane will meter
from is fixed.

## Non-blocking findings

### R-04 — The UI token stays in the address bar

The auth design says the page replaces the URL after bootstrapping the cookie. It does not —
`grep replaceState` → nothing. So the token remains in history, in the tab title bar, and in any
referrer. Low severity because the cookie means it need only appear once, and it is a
single-owner secret; still wrong, and the design doc claimed otherwise until this review.

### R-05 — Nothing is shipped anywhere, and nothing is backed up

`/health` and the crash log are pull-only, `activity.jsonl` is local, and backup is a documented
`cp`. One box with an owner watching is fine. Two boxes, or an owner who is not watching, is not:
a crash-looping component reports itself only to whoever asks.

### R-06 — Live-view latency is asserted, not measured

N1.3 claims the view updates within a second. `vnc-probe` proves frames still arrive under a
compositor; it does not measure the delay from a screen change to a frame. The number in the
requirement is currently a hope.

### R-07 — Transcripts grow without bound — **fixed**

180KB after a day of heavy use, no rotation, no compaction, no summarisation. A long-lived agent
eventually exceeds the model's context and the turn fails on a request that cannot be made smaller
— at the worst possible moment, mid-task, with nothing the user can do. The design mentioned
compaction as a thing that did not exist.

Fixed by summarising what is *sent* and never touching what is *stored*. Past a token trigger the
history before a cut point is replaced, in the request, by one summary entry; the transcript keeps
every original entry, because the tool blocks are what make an agent's claims checkable and
summarising over them would destroy the thing they exist for. The summary is appended to the
transcript too, so the next turn pays nothing and assembly starts from the newest one.

Two things had to be right. The cut may not land between a `blocks` entry and its `results` — that
is one exchange to the API and splitting it produces a request it rejects; the cut walks back to a
pair boundary, with a test that fails if it stops walking. And a failed summarisation may not fail
the turn: it falls back to dropping the oldest entries and *saying so in the history*, telling the
model to treat what it cannot see as unknown rather than as not done.

Measured on this box's real transcripts, not synthetic ones. Bob's 166-entry, 37,250-token history
cut at entry 127 on a genuine pair boundary; the 26,473 tokens before it summarised to 1,672 — 16×
— in one 30-second call. The summary named the files it wrote with paths, listed the decisions
locked with its teammate, recorded its next concrete action, and flagged the two facts it had *not*
independently verified. That last part is the reason for the "do not invent progress" line in the
prompt: a summary that reads well and quietly upgrades an attempt into an achievement is worse than
no summary, because the agent will believe it.

### R-08 — Secrets an agent reads land in the transcript in clear

Tool results are persisted verbatim. An agent that runs `printenv`, reads a config file, or
receives a credential in a page is writing it to `conversation.jsonl`, which is mode 644 (the
directory is 700 only in the self-contained topology). Nothing redacts, and nothing warns.

### R-09 — A running turn cannot be stopped from the UI

There is a priority-interrupt path for agents, and `TurnAborted` exists, but no control surfaces
it. A reviewer watching an agent do the wrong thing can only wait or kill the process. For a
product whose central promise is "watch and take over", that is a missing half.

## What holds up well

Worth recording, because a review that only lists faults misrepresents the system.

- **Failure behaviour is engineered, not asserted.** Supervision, abandonment, crash visibility
  and self-diagnosis were each built after measuring the failure, and each has a test that fails
  when the mechanism is removed.
- **The provenance decision is sound.** Storing the model's own tool blocks, after two worse
  attempts, is the difference between a record and a claim.
- **Isolation is described accurately.** The desktop boundary is structural; the ownership and
  environment boundaries are called accident prevention, with the reason. Nothing is oversold.
- **The seam work paid off.** The provisioner separation is proven by running everything with no
  Docker present, which is the only kind of proof that counts for a seam.
- **Measurements exist where they matter.** Capture latency under load, the cost of polling
  capture, the effect of the priority split — all numbers, not adjectives.

## Recommended order

1. R-01 (prompt + doctor check) — smallest fix, silent data loss.
2. R-02 (health check covers the topology's promise) — small.
3. R-03 (usage in the transcript, then budgets) — largest, and the one with money attached.
4. R-09 (stop a turn) — completes the product's central promise.
5. R-04, R-06, R-08, R-05. (R-07 done.)
