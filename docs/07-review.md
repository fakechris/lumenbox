# Review against the specification

Reviewed against [01-requirements.md](01-requirements.md) through
[06-deployment.md](06-deployment.md). Every finding below was verified against the running
system or the source, not inferred from the documents.

**Verdict: closer, and the blocking findings are closed.** Nine findings, three of them blocking.
R-01, R-02, R-03, R-07 and R-09 are fixed. R-04, R-05, R-06 and R-08 stand. What it does meet is a higher standard than that summary suggests in one specific
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

**Now fixed.** Budgets and a wake-rate limit exist, in one place rather than four
(`src/host/policy.ts`). `AGENTBOX_BUDGET_TOKENS` refuses the model call — before the request, since a
budget that only reports afterwards is not a budget — and `AGENTBOX_WAKES_PER_WINDOW` refuses an
agent that has woken teammates too often, which is the specific shape that produces a runaway: two
agents taking turns to set each other going, spending at the speed of the API with nothing else in
the system to stop it.

Still deliberately not done: prices. A record says tokens; what a token costs belongs to whoever
bills, and would be wrong in a file nobody remembers to update.

No default budget, which is a decision and not an omission: a number invented here would surprise
whoever hit it, and the failure mode of a too-low ceiling is an agent that stops mid-task. The
mechanism ships; the policy is the operator's.

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

### R-09 — A running turn cannot be stopped from the UI — **fixed**

There is a priority-interrupt path for agents, and `TurnAborted` exists, but no control surfaced
it. A reviewer watching an agent do the wrong thing could only wait or kill the process. For a
product whose central promise is "watch and take over", that was a missing half.

`POST /api/stop` now stops one agent, and the same decision point refuses its tool calls as well as
its next model call — a person who pressed stop meant all of it, not just whichever came next.

Two decisions inside it are worth stating:

**It stops at a round boundary, not mid-request.** Aborting a request in flight leaves a tool call
with no result, which is a shape the next turn cannot replay. So the turn ends where the transcript
is consistent, and the transcript says why it ended rather than simply stopping.

**A stop belongs to the turn that was running.** It is cleared when the next turn starts, because
leaving it set would silently refuse the person's *next* instruction — which reads as the agent
having broken rather than having been stopped.

Verified on a real box: a turn told to run forty sequential commands, stopped six seconds in,
refused its remaining tool calls and then its next model call — so the stop cost no further spend —
and ended with the reason in its transcript. Honest about the noise: that round had ten parallel
tool calls and each got its own refusal, so the transcript carries eleven refusals where one would
read better. Tidying that up would risk leaving a call without a result, so it stands.

### R-10 — A transient failure ended a long turn — **fixed**

Found while looking for what actually breaks a long task, rather than in the original review.

A round's stream failure was rethrown for anything that was not an abort or a context overflow. The
SDK's own retries cover *establishing* a request; a stream that breaks after content has arrived is
not resumable, and that is precisely the failure a long turn is most exposed to because it holds a
connection open the longest. So one blip ended the turn and the work with it.

Three things make the retry correct rather than hopeful:

**Only what a retry could fix.** A rejected request, a bad credential, or an overflow that cannot be
shed further fails identically forever; retrying those spends money and hides the real error behind a
delay. Four kinds — transient, capacity, permanent, unknown — and only the first two are retried.
Unknown is deliberately *not* retried: an unrecognised error retried in a loop is how a bug becomes a
bill.

**Looking through the wrapping.** Node buries the interesting error — a failed `fetch` is a generic
`TypeError` whose `cause` holds the `ECONNRESET`, and a multi-address failure is an `AggregateError`
whose `errors` hold several. Every signal in the chain is collected and then decided between, with
**permanent winning**, because the two mistakes are not symmetrical: calling a transient failure
permanent loses one turn, while calling a permanent failure transient pays for the same impossible
request four times. My first version returned the outermost signal, so a permanent error wrapped in
something saying "connection closed" would have been retried — caught by the test written for exactly
that case.

**A silent stream is a failure.** A stream can open and deliver nothing, which is not a slow answer
— a slow answer produces tokens — and waiting on it is indistinguishable from a hang. There is now a
deadline on the *first* token, separate from any limit on the whole response, and it is reported as
what it is rather than as an abort.

Backoff uses equal jitter, half fixed and half random, so retries neither pile up at one instant nor
line up in lockstep across agents. A provider's `retry-after` is a floor rather than a suggestion,
capped at 30s so a bad header cannot stall a turn for an hour.

One honest limitation: a partial answer already streamed to a watcher will be produced again by the
retry. Nothing is written to the transcript until a round completes, so stored history cannot be
duplicated and no tool can re-run — but the screen can show the text twice. The retry event carries
`discardPartial` so a UI can drop the first, and until a UI reads it, that duplicate is visible. Worth
it: a duplicated paragraph is recoverable and a lost turn is not.

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

1. ~~R-01~~ done — smallest fix, silent data loss.
2. ~~R-02~~ done — health check covers the topology's promise.
3. ~~R-03~~ done — usage written down, then budgets and a wake limit.
4. ~~R-09~~ done — a turn can be stopped, which completes the product's central promise.
5. R-08 (secrets in the transcript), R-04, R-06, R-05.

R-03 and R-09 were done together rather than separately, and that was the right call: written as two
patches they would have been two `if`s in two files with two ideas of what a refusal looks like.
Written as one decision point they are the same mechanism asked different questions — and the same
mechanism yielded a capability that was not on this list at all: requiring a person's consent before
a named action. That one exists because the shape allowed it, not because it was planned.
