# Implementation plan — mcode preset (INV-1233)

Branch `feat/inv-1233-delegate-minimax-code-mcode-preset-model`, worktree `agentbox-quick`.
The previous plan (INV-1268, hot-swapping the default model) is complete: PR #374, In Review.

## Stage 1: Preset, report parser, image layer
**Goal**: `mcode` in PRESETS (one-shot `exec`, `--permission full`, per-run `MINIMAX_DATA_DIR`
with the profile written from the environment and removed on exit, `goal.verification: subagent`);
`engine-report.ts` reads `exec.completed`; Dockerfile `MCODE_VERSION` layer and Node 22.20;
`build-image.mjs` lists unpinned engines and refuses a release build with one;
`release-check.mjs` reads the image contract.
**Success Criteria**: presets/engine-report tests; `npm run check` green.
**Status**: Complete

## Stage 2: Run it for real
**Goal**: build the box image with all four pins; run `mcode exec` through the preset's exact
command against the host relay (or a stub model on an internal docker network with no route to
the outside), with egress logged.
**Success Criteria**: the run completes with a report; the only outbound calls are the model
calls through the relay (no `/mavis/api/v1/permission/check`); the temporary data dir is gone
after the run and no file in the box contains the token; real output becomes the fixture in
`src/host/fixtures/engine-report/mcode-*.jsonl`.
**Status**: Complete (stub run, docs/25 §mcode; a real-model run is still open)

## Stage 3: Docs and pins
**Goal**: docs/25 gains the mcode row (measured facts), the release-engine-pins memory names
MCODE_VERSION; PR.
**Status**: Complete
