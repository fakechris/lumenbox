# Implementation plan — Delegate as a session, step two (INV-1234)

Branch `feat/inv-1234-delegate-acp-session`, worktree `agentbox-quick`. The decision is
docs/81 §2; this plan is its §3 in stages. Each stage ships green on its own.

## Stage 1: boxd — an ACP session service
**Goal**: boxd keeps one `mcode acp` child per session (cwd, env, data dir), speaks ndjson
JSON-RPC on its stdio, and exposes it over HTTP: open (spawn + initialize + session/new or
session/load), request (await the engine's response), notify, events (updates and the engine's
own requests since a sequence number), reply (answer an engine request), close. Session records
persist on the work volume so a restarted boxd can `session/load` the same id in the same cwd.
**Success Criteria**: boxd unit test with a fake ACP engine script: open → prompt → updates
streamed → engine request answered → close; a crashed child reports a definite failure.
**Status**: Complete

## Stage 2: host — session-mode Delegate
**Goal**: `Delegate` for a preset with an ACP form opens a session instead of a one-shot job;
`steer` and `cancel` reach it; the engine's `session/request_permission` becomes a policy-gate
approval answered `allow-once` or `deny` (never `allow-always`), an approval timeout ends with
`session/cancel`; the outcome is the engine's stopReason (cancelled → aborted); the pending
delegation records engine sessionId + cwd; after a host/boxd restart the session is loaded
with both or fails definitely. Metering untouched (relay rows).
**Success Criteria**: scenario tests with the fake ACP engine: open, steer accepted /
duplicate / refused idle, cancel → aborted, permission → gate → allow-once / deny, unanswered
→ timeout → cancel, restart → load same cwd ok / other cwd definite failure.
**Status**: Complete

## Stage 3: the real box
**Goal**: the box image with mcode; one delegation in session mode, one steer mid-turn, one
cancel; profile has `permissionMode: default` and `goal.verification: subagent`; the data
directory is removed at close.
**Success Criteria**: evidence in the PR (job log, approval shown and answered, stub/relay
requests), `npm run release:check`.
**Status**: Complete against the built boxd + real mcode acp with the stub model (stage3-run.txt); the live box is not recreated

---

# Implementation plan — the outside supervisor (docs/90, INV-1506..1510)

A supervisor above the team is a principal on the MCP door, never a hand in the box. Stages
wait for each candidate's commit; each ships green on its own.

## Stage 1: structured task_status (INV-1506)
**Goal**: `task_status` returns `structuredContent` (outcome, stage, mandate, history, pursuit summary) beside the unchanged text.
**Success Criteria**: plain task, goal task and list each carry every field, equal to the board; text byte-identical; `structured: true` capability.
**Status**: Not Started (candidate)

## Stage 2: goals through the door (INV-1507)
**Goal**: `goal_start` and `goal_control` over the same `goalCommand`; resume only what the principal itself paused.
**Success Criteria**: key replay makes no second goal; no key refused; another's goal refused; system pause not resumable; drafting turn runs without closing the pursuit.
**Status**: Not Started (candidate)

## Stage 3: watch (INV-1508)
**Goal**: a long-poll change feed from `TaskBoard.onChange`, bounded ring, cursor with reset.
**Success Criteria**: change wakes a waiter; timeout returns empty; stale cursor resets; `mine` scoped; no listener leak.
**Status**: Not Started (candidate)

## Stage 4: the watchdog (INV-1509)
**Goal**: `agentbox watchdog` as a separate process with its own token; deterministic rules; `raise_attention`; `--on-down`.
**Success Criteria**: each rule fires and stays quiet when it should; cooldown; on-down runs when the door is gone; a stalled task shows the note in "needs you".
**Status**: Not Started (candidate)

## Stage 5: compatibility spike (INV-1510)
**Goal**: an outside supervisor drives the team through the contract alone, in a throwaway container.
**Success Criteria**: a report with a gap table, or a recorded reason the runtime was unavailable.
**Status**: Not Started (candidate)
