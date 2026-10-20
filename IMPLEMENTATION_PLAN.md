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
