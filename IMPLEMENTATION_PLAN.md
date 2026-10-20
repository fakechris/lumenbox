# Implementation plan — hot-swap the default model (INV-1268)

Branch `feat/inv-1268-provider`, worktree `agentbox-quick`. The previous plan (ShowUI, INV-1269)
is complete; its record is in docs/79 and the INV. Each stage ships green on its own
(`npm run check`, `npm test`).

## Stage 1: Orchestrator — a swappable default runtime
**Goal**: `orchestrator.setDefaultProvider(profile)` replaces provider, client and the
Rememberer's summary pair together; a running turn keeps the pair it started with.
**Success Criteria**: unit test — swap mid-turn, the turn's later rounds and its usage rows still
name the old model, the next turn names the new one; askCheaply/askBounded/relay/Rememberer read
the new one; a `switch` row lands in usage.jsonl.
**Status**: In Progress

## Stage 2: Config — re-apply after a save, shell wins
**Goal**: `reapplyConfigEnv(config)` sets the variables the file speaks for, removes the ones it
dropped, never touches a shell-exported one, and reports those as `locked`.
**Success Criteria**: config.test.ts — config-applied key follows the file; shell key stays and is
listed; dropped key is removed.
**Status**: In Progress

## Stage 3: Server — save applies, no restart for model fields
**Goal**: `POST /api/config` saves, re-applies env, resolves the provider, swaps it; on a resolve
failure it keeps the old runtime and answers 400. Accepts `vision` (auto/on/off) and
`summaryModel`. `GET /api/config` and `/api/state` report the live provider plus `locked`.
`restartNeeded` only when hostExec/startupItem/boxImage changed.
**Success Criteria**: server test — save a new model, `/api/state` shows it without restart, pid
unchanged; invalid provider → 400 and state unchanged.
**Status**: Not Started

## Stage 4: Settings page
**Goal**: model input (suggestions incl. MiniMax-M3.1-Flash-Preview), vision three-way, summary
model, "now running" line with locked notes; Save applies, Save & restart only when needed.
**Success Criteria**: app-html static checks for the new ids; the save path reads `restartNeeded`.
**Status**: Not Started

## Stage 5: Release check and the live switch
**Goal**: `npm run release:check`; switch the model in the desktop app on this Mac; evidence in the
PR — server pid before/after, channel log without a reconnect, usage.jsonl model before/after.
**Status**: Not Started
