# Review against the specification

Reviewed against [01-requirements.md](01-requirements.md) through
[06-deployment.md](06-deployment.md). Every finding below was verified against the running
system or the source, not inferred from the documents.

**Verdict: it does not meet a product-grade standard yet.** Nine findings, three of them
blocking. What it does meet is a higher standard than that summary suggests in one specific
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
| F5.3 | Upgrade preserves work | **partial** | R-01 |
| F5.4 | Provisioner replaceable | met | full suite with no Docker on PATH |
| N1.1–1.2 | Capture latency | met | 185ms idle, 189ms saturated |
| N1.3 | Live view within a second | **unverified** | R-06 |
| N2.1–2.3 | Crash isolation, abandonment, crash records | met | measured by killing things |
| N2.4 | Work loss needs an explicit act | **partial** | R-01 |
| N3.1–3.4 | Isolation | met as scoped | limits stated, not overstated |
| N4.1–4.3 | Honest failure | met | three no-op tests found and fixed |
| N5.1–5.4 | Operability | **partial** | R-02, R-05 |

## Blocking findings

### R-01 — An agent's work outside `/home/box/work` is destroyed by an upgrade

`grep '/home/box/work' src/host/prompt.ts` → 0. Nothing tells an agent where to put things that
must survive. `/home/box/work` and `/home/box/.config` are volumes; everything else, including
`/home/box` itself, is the container layer, which `--recreate` discards — and `--recreate` is
what upgrading means.

An agent asked to "write the report" will reasonably write `~/report.md` and lose it on the next
upgrade, with nothing to indicate that happened. This violates N2.4 and F5.3, and it is the
failure mode this system is otherwise built to avoid: silent.

Fix: say it in the prompt, and have `box-doctor` warn when files sit directly in `/home/box`.

### R-02 — In the self-contained topology, a dead UI reports a healthy container

`HEALTHCHECK` runs `curl -fsS http://127.0.0.1:1337/health`, which is boxd only. With
`--with-host`, the orchestrator is the product — the only thing outside the container is a
browser — and it can be crash-looping while the container reports healthy and the restart policy
stays quiet.

Fix: the health check should cover what that topology promises. The supervisor already knows;
the check does not ask it.

### R-03 — No cost control of any kind

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

Fix, in order of value: consume the event that already exists — show a running total per turn and
persist it with the turn; then a per-turn and per-box budget; then a wake-depth or wake-rate
limit on agent-to-agent messaging.

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

### R-07 — Transcripts grow without bound

180KB after a day of heavy use, no rotation, no compaction, no summarisation. A long-lived agent
eventually exceeds the model's context and the turn fails on a request that cannot be made
smaller. The design mentions compaction as a thing that does not exist.

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
5. R-04, R-06, R-07, R-08, R-05.
