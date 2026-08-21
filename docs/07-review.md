# Review against the specification

Reviewed against [01-requirements.md](01-requirements.md) through
[06-deployment.md](06-deployment.md). Every finding below was verified against the running
system or the source, not inferred from the documents.

**Verdict, at 20K lines of source and 415 tests: it meets a product-grade standard for a
single-tenant deployment, and does not yet for a multi-tenant one.** The gap is three items in
[10-security-backlog.md](10-security-backlog.md), not a shortfall in the functional requirements.

Thirteen findings so far. Ten are fixed, and the three that remain are all in the same family —
things the system does not *ship anywhere*: secrets it records, latency it asserts, telemetry it
exposes and nobody collects.

| | Finding | State |
| --- | --- | --- |
| R-01 | Work outside `/home/box/work` destroyed by upgrade | fixed |
| R-02 | Dead UI reported a healthy container | fixed |
| R-03 | No cost control | fixed |
| R-04 | UI token stays in the address bar | **open** |
| R-05 | Nothing shipped anywhere, nothing backed up | **open** |
| R-06 | Live-view latency asserted, not measured | **open** |
| R-07 | Transcripts grew without bound | fixed |
| R-08 | Secrets land in the transcript in clear | **open** (S-1) |
| R-09 | A running turn could not be stopped | fixed |
| R-10 | A transient failure ended a long turn | fixed |
| R-11 | The round limit was a guess and a dead end | fixed |
| R-12 | Compaction's claim was false for the agent | fixed |
| R-13 | A turn could end silently | fixed |
| R-14 | A command timeout was capped in silence | fixed |
| R-15 | Compaction dropped the tail it existed to preserve | fixed |
| R-16 | A viewer could drive the desktop | fixed |
| R-17 | Three governance controls failed open | fixed |
| R-18 | Long turns were never compacted after the first round | fixed |
| R-19 | Execution obligations died with the process | **partly fixed** |

### The adversarial round

An independent reviewer was pointed at four areas — architecture and long-task
stability, overall design gaps, the model-facing logic, and the box.
Fifty-two findings came back, all claimed CONFIRMED. Twenty-six survived checking and were
fixed; the rest were either already-documented trade-offs, or wrong.

Both halves of that matter. **Two of the findings I first judged false positives turned out
to be real** — image pruning keeping the screenshot from *before* the last action, and the
continuation loop never recompacting — and both were only settled by running a probe rather
than by reading the code again. The habit worth keeping is not "trust the reviewer" or
"trust yourself" but "the argument ends at a probe".

What it found, grouped by what it says about the system rather than by severity:

- **Two states sharing one representation, seven more times.** Compaction's cut point, the
  entry cap, a stop pressed during compaction, a truncated message, an unparsed setting, a
  malformed todo list, and — committed *while fixing the others* — `undefined` meaning both
  "default path" and "no file". This is the defect this codebase produces. It is worth
  treating any `undefined`, empty array or zero that answers two questions as a bug on sight.
- **Controls that failed open.** A budget window that never rolled, spend that read as zero
  when its accounting broke, and consent that was consumed but not recorded. Each was a
  control that stopped applying at exactly the moment it mattered.
- **Guarantees the box did not keep.** A view-only role that could type, an output cap that
  did not bound memory, a timeout that did not end the request, a desktop that changed hands
  across a restart, a recorder that outlived its daemon, an upload that wrote through a
  symlink.
- **Names that could collide.** Container names derived from tenant names, where the volumes
  carry the tenant's work.



### What this review keeps getting wrong

Worth recording, because it is the same mistake four times and naming it is cheaper than finding it
a fifth:

**Two states that mean opposite things, sharing one representation.** A skill loader returning an
empty list for both "no skills directory" and "the box did not answer". A cache treating `readAt = 0`
as "read at time zero" rather than "never read". A cron field parser returning `undefined` for both
"any value" and "unreadable". And, in a different shape, a turn ending with no text producing neither
a record nor an event — "nothing to say" and "nothing happened" reaching the person identically.

Each one worked under real conditions and failed the moment a test looked closely. Each is now a
tagged union or an explicit flag. The pattern to watch for: an `undefined` or an empty collection that
answers two different questions.

R-14 is the same shape one layer down: a request for a one-hour timeout was clamped to ten minutes
and the kill reported only "timed out", so the one reading it would reasonably conclude the command
had crashed. The value applied now comes back with the result and the ceiling is in the tool's
description — an environment fact the model cannot work out from outside, which is the test for what
belongs there.

**Claims about the record that were true for a person and false for the agent.** Compaction shipped
with "the transcript keeps every entry, which is what makes an agent's claims checkable" — true for
someone reading the file, and the agent could not read it at all. The reviewer agent shipped with a
description promising it reads a colleague's transcript, months before it could.

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
| F6.1–6.6 | Memory: bounded, budgeted, decaying, shared | met | verified across agents on a real box |
| F7.1–7.5 | Reuse: skills, index-not-bodies, schedules | met | an `@every 1m` skill fired twice unattended |
| F8.1–8.7 | Finishing: compaction, retry, plan, history, silence | met | each has a test that fails when the mechanism is removed |
| F9.1–9.6 | Tenancy, roles, admin, relay, metering | met | three people one box; no provider key in the container |
| N6.1–6.5 | Cost and consent | met | stop, budget, wake limit, fingerprinted approval |
| F10.1–10.7 | Coordination | **partial** | see below |

F10 is new and mostly open. It was written after noticing that every serious defect the adversarial
round found in the multi-agent parts was a textbook concurrency anomaly rather than anything to do
with agents: the allocation race is a write-write race, the desktop adopted after a restart is a
lease with no durability, the scheduler re-firing a window is non-idempotent replay, and a stop
cleared by the turn that followed it is a stale commit. Those four are fixed. What is not:

- **F10.1** — `SendToAgent` answers "Sent", which now honestly means "recorded and queued", but a
  sender still never learns what became of it. An acknowledgement that cannot distinguish queued
  from acted-on is where a team of agents starts holding conversations to simulate one.
- **F10.2** — there is no claim on a piece of work at all. Two agents told to do the same thing both
  do it.
- **F10.3** — every agent writes to one `/home/box/work` as one uid. Two agents editing one file is
  a lost update with nothing to detect it.
- **F10.5** — messages carry no sender-side ordering, so after a failure in a team there is no
  happens-before to reconstruct and no way to say which action came first.
- **F10.6** — a teammate's message arrives inside the wake prompt as text to act on. Nothing marks
  it as data rather than instruction, which in a fleet means one compromised agent can direct the
  others.
- **F10.7** — the subject of the next piece of work.

R-05 is what keeps N5 partial and it has not moved: health, crashes and usage are all *exposed* and a
person still has to go and look.

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

### R-11 — The round limit was a guess, and a dead end — **fixed**

A turn ran up to 400 rounds and then recorded "the agent is probably looping rather than making
progress". Two faults: the diagnosis was a guess written as a fact — a genuinely long task looks
identical from there — and there was no continuation, so work was abandoned at the limit with
whatever it had done left half-finished.

Both are answerable now that the agent keeps state saying what it is trying to do (§2.2a of
[05-data.md](05-data.md)).

**A loop is detected when it starts.** An agent repeating one call has wasted every round since the
second, so there is nothing to learn from letting it do three hundred more. Four consecutive rounds of
the same call *and* nothing else called alongside it *and* no change to the plan or todo list. All
three conditions are required, because each has a false positive on its own — and a detector that
stops a working agent is worse than none, since that failure is silent and looks like the agent giving
up. The report quotes the repeated call, which is worth more to a reader than any adjective.

**At the limit the two cases are separated.** A loop stops. Real progress means the turn hit a
*budget*, and it is continued in a fresh turn: the plan and todo list are in the system prompt and
unchanged, the history compacts on the way in, so the agent resumes rather than restarts. Bounded at
three continuations, and the continuation goes through the same policy gate as any other wake, since
an agent continuing itself is exactly the shape the wake-rate limit exists to catch.

Progress is judged generously — one todo moving in four hundred rounds counts — because the two
mistakes are not symmetrical: continuing something stuck wastes a budget, while abandoning something
working throws the work away. The narrow judgement is the loop detector's job.

Where it is genuinely unclear — nothing repeated often enough to call a loop, and nothing changed —
that is what the transcript says, rather than a diagnosis nobody checked.

The first run of this found an artificial loop in an existing test: six identical screenshot calls,
written as a fixture for the overflow test. The detector was right and the fixture was not, which is
the sort of thing a real definition of "looping" turns up.

### R-12 — Compaction's central claim was false for the agent — **fixed**

Compaction was shipped with a claim attached: the transcript keeps every entry, including the tool
blocks, which is what makes an agent's account of itself checkable. That is true for a *person*
reading the file. It was not true for the agent, and nobody checked — the transcript lives in the
orchestrator's state directory and the box's uid cannot read it:

```
$ docker exec --user box … ls /home/hostd/.agentbox/agents/
ls: Permission denied
```

So after "the first 127 entries were summarised", an agent needing a detail from entry 40 had no path
to it at all. The uid split is right and stays; what was missing was a route *through* the
orchestrator.

`ReadHistory` is that route. Two properties keep it from defeating the thing it completes:

- **Offered only when something was summarised.** A tool advertising access to a history that was
  never compacted invites a call returning what the agent can already see, which trains it to ignore
  the tool by the time it matters.
- **A reading, not a replay.** Re-emitting raw content blocks would pour back the context compaction
  removed. Entries are rendered compactly with their numbers, capped at 25, each clamped — and a
  truncated answer says how many it did not show.

It also reads a *teammate's* history, deliberately. Everyone in a tenant already shares a box and a
filesystem, `private` is documented as accident prevention rather than a boundary, and the reviewer
agent's whole job — promised in the description it ships with — is checking what someone did rather
than what they said they did. Until now that promise was unkeepable.

Verified on a real box: Ops wrote a file; Vera was asked to check it, called `ReadHistory` on Ops,
recovered the exact `write_file` call with its arguments and timestamp, then read the file herself and
reported both.

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

## What is left, in order

1. **R-08 / S-1 — secrets in the transcript.** The heaviest remaining item, and the relay did *not*
   fix it: that stopped the provider key entering a box, and does nothing about a credential the
   agent reads while working. Awkward rather than lazy — the transcript's value is that it stores
   the model's own blocks unedited, so a redactor is editing the evidence. Detection plus a marker
   is probably the shape.
2. **R-06 — measure the live view.** The one requirement in this document whose number is a hope.
   Small, and it is embarrassing that N4.3 exists while N1.3 is unmeasured.
3. **R-05 — ship health somewhere.** The collector pulls it into a store and nothing alerts. One box
   with an owner watching is fine; the moment there are two, a crash-looping component reports itself
   only to whoever asks.
4. **R-04 — the token in the URL.** Low severity and still wrong.

**What was left undone, deliberately.** Per-step checkpoint and resume is the one large gap
still open: a turn interrupted at round 300 leaves its record but does not resume. Everything
else in the persistence family is closed — admission, schedules, ownership — and this one is
last because it is the only one that has to answer "what happens to a side effect whose
result was never written down", and that answer decides whether replay is safe at all.

Two capabilities are absent rather than broken, and both bear on how long a task can run:

- **Work that outlives a turn.** An exec holds a request open, so ten minutes is the ceiling and a
  longer job has to be started detached and polled. The agent can do that unaided; what does not
  exist is anything that *re-attaches* to it after the orchestrator restarts, so a four-hour build
  survives only if nothing bounces. The shape is a watch registry that reads back a known output
  file, with a give-up rule for the file never appearing.
- **A snapshot of durable state.** R-05's other half. The shape worth copying: snapshot at turn end
  while nothing is writing, checkpoint the WAL into the main file first, debounce so a busy agent
  does not upload continuously, and refuse above a size rather than uploading a huge one slowly.
  Our own encryption test was vacuous for exactly the WAL reason, which is a hint that anything
  reading these files without checkpointing them is reading a partial truth.

Then the four large pieces that are each their own project, listed with what makes each hard rather
than as a backlog: **verifying an action's effect** (the criteria have to be designed, and a check
that cannot say why it passed is worse than none), **teach-recording** (needs the criteria above to
be worth anything), **an accessibility-tree executor** (far more deterministic, in a much smaller
world), and **cross-tenant sharing** (a durable queue the box pulls from, with everything
at-least-once delivery implies).

The one process observation worth keeping: R-03 and R-09 were done together rather than as two
patches, and that turned two `if`s into one decision point — which then yielded a capability nobody
had planned, requiring a person's consent for a named action. Grouping by *mechanism* rather than by
finding is what made that possible, and the same grouping is why F8 reads as one thing rather than
six.
