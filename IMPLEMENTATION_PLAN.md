# Implementation plan — Delegate as a session (INV-1234)

Branch `feat/inv-1234-delegate-acp-job-steer-mcode-spike`, worktree `agentbox-quick`.
The previous plan (INV-1233, the mcode preset) is complete: PR #375, In Review.

## Stage 1: Spike — measure mcode's ACP in the box image
**Goal**: drive `mcode acp` with a minimal stdio JSON-RPC client against a stub model on an
internal network; measure initialize, session/new, prompt, steer (idle / running / duplicate),
cancel, request_permission (answered / unanswered), bypass, list, load (same cwd / other cwd /
unknown), SIGTERM. Raw logs in `research/2026-10-20-acp-spike/` (ignored).
**Success Criteria**: every row in docs/81 §1 is a measured value; the two dangerous defaults
confirmed on the wire.
**Status**: Complete

## Stage 2: Decision — what enters the host
**Goal**: docs/81 §2–3: session per delegation for ACP presets, permission → policy gate
(`allow-once` / `deny`, never `allow-always`), steer = engine steer with host idempotency key,
cancel = `session/cancel` then wait for `cancelled`, restart = `session/load` same id + cwd
or definite failure, metering stays with the relay. presets.ts comment points at docs/81.
**Status**: Complete

## Stage 3: Implementation (step two of INV-1234)
**Goal**: as docs/81 §3. Not started here; needs the person's go after reading the decision.
**Status**: Not Started
