<!-- doc: 84-preset-matrix
     title: The Delegate support matrix: presets × providers × scenarios
     family: guide
     status: current
     updated: 2026-10-26
-->
# The Delegate support matrix: presets × providers × scenarios

`scripts/preset-matrix.mjs` runs every Delegate preset against every provider this machine has
a key for, through five scenarios, and writes a dated table. It exists so "does Delegate to pi
still work on this provider" is answered before a release, not by a user after it (INV-1359,
after HarnessRouter's harness × model × scenario table, research 2026-10-25).

## What a cell measures

The coordinator is a scripted model (`fakeModel`): it issues the Delegate call deterministically,
so a cell measures the engine on the provider, not a model's choice of preset. The engine itself
runs for real inside the dedicated box, through the host's model relay with the provider's key,
submitting its report through the MCP face — the harness serves both routes the way the web
server does. Each cell gets a scratch `AGENTBOX_HOME` and its own directory under
`/home/box/work/preset-matrix/`.

| scenario | brief | pass means |
|---|---|---|
| first | write one file with one line | the engine's own report says done and the file is as asked |
| followup | a second brief, naming no file, with `session: true` | the engine resumed its thread and extended the file |
| switch | a different model mid-session | **n/a everywhere**: Delegate carries no per-brief model; the engine uses the installation's provider model. Recorded, not run, so the gap stays visible |
| artifact | a file with exact three-line content | the file matches byte for byte |
| recycle | the host is replaced (a fresh Orchestrator over the same home) before the follow-up | the follow-up still resumes the engine's thread from the persisted capsule |

A preset with no session form (opencode, pi: one-shot `run`) gets n/a for followup and recycle
with that reason. A missing engine is a FAIL naming the pinned package; `--install` runs
Delegate's own install job and waits for it, reporting the job's exit and log tail when it fails.

```
node --experimental-transform-types scripts/preset-matrix.mjs --dry-run
node --experimental-transform-types scripts/preset-matrix.mjs [--box create|keep|use <name>] [--image build] \
    --install --json research/matrix/<date>.json --md research/matrix/<date>.md [--only pi] [--providers minimax,kimi]
node --experimental-transform-types scripts/preset-matrix.mjs --from research/matrix/<date>.json   # re-render
```

`--dry-run` calls no model and touches no box. It is never part of `npm test`.

**The box** (INV-1370, `scripts/lib/eval-box.mjs`): by default the script creates its own
`lumenbox-eval-<run>` box and removes it when the run ends — success, failure or Ctrl-C — after
printing what it removes (container, its three volumes, network, token file, and any image
`--image build` made). It removes only names under `lumenbox-eval-` that this run created.
`--box keep` leaves the created box running; `--box use <name>` (or `AGENTBOX_CONTAINER`)
attaches to an existing box and removes nothing; `--image build` first builds the current
Dockerfile as `lumenbox-eval:<version>` with every engine pinned; `--live-box` means the default
box, on purpose.

## The table after the fixes, 2026-10-26, build c360b5f + INV-1363

Box: `lumenbox-dev:0.3.7`, built from the current Dockerfile (node v22.20.0; image contract:
opencode 1.18.25, claude 2.1.250, pi 0.85.1, mcode 0.6.12, built 2026-10-26). The opencode preset
carries the INV-1363 fix (relay as a config-file provider).

### Provider: minimax (MiniMax (China), MiniMax-M3.1-Flash)

| preset | first | followup | switch | artifact | recycle | notes |
|---|---|---|---|---|---|---|
| opencode | pass (17s) | n/a | n/a | pass (13s) | n/a | followup/recycle: no session form · switch: no per-brief model |
| claude | pass (10s) | pass (29s) | n/a | pass (10s) | pass (33s) | switch: no per-brief model |
| pi | pass (25s) | n/a | n/a | pass (12s) | n/a | followup/recycle: no session form · switch: no per-brief model |
| mcode | pass (27s) | pass (41s) | n/a | pass (23s) | pass (65s) | switch: no per-brief model |

Every applicable cell passes. mcode's session form (ACP) resumes across the recycle like claude's.
In the run between the two tables (0.3.7 image, opencode fixed) one opencode `artifact` cell
and, earlier, one claude `recycle` cell were judged `unknown` because the engine exited 0 without
calling `delegate_submit` — the model skipping the report step, seen twice in five runs across
two engines; the verdict machinery is right to refuse the claim.

## The first table, 2026-10-26, build b456ce8 (before the fixes)

Box: `fakechris/lumenbox:0.3.7` (node v22.18.0; image contract: opencode 1.18.25, claude 2.1.250,
pi 0.85.1, built 2026-10-07). Only one provider is configured on this machine.

### Provider: minimax (MiniMax (China), MiniMax-M3.1-Flash)

| preset | first | followup | switch | artifact | recycle | notes |
|---|---|---|---|---|---|---|
| opencode | **FAIL** | n/a | n/a | **FAIL** | n/a | first/artifact: opencode exits 1 with "Unexpected server error" and delivers no report (see finding 1) · followup/recycle: no session form · switch: no per-brief model |
| claude | pass (14s) | pass (39s) | n/a | pass (13s) | **FAIL** | recycle: the engine exited 0 but delivered no report, so Delegate refused the completion claim (finding 2); the same cell passed in 41s on the run before · switch: no per-brief model |
| pi | pass (12s) | n/a | n/a | pass (31s) | n/a | followup/recycle: no session form · switch: no per-brief model |
| mcode | **FAIL** | **FAIL** | n/a | **FAIL** | **FAIL** | install job exits 1: "[MCode] Unsupported Node.js", 0.6.12 needs Node 22.19+ and the 0.3.7 image carries 22.18.0 (finding 3) · switch: no per-brief model |

The verbatim per-cell reasons are in `research/matrix/2026-10-26.json` (gitignored research
output; the table above is the record).

## What the first run found

1. **opencode cannot use the relay on MiniMax.** The preset comment already says it: opencode
   1.18.25 ignores `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`, routes by its provider catalogue, and
   the model arrives as a bare `-m MiniMax-M3.1-Flash` where opencode wants `provider/model`.
   The engine dies before its first model call. A probe in the box with a bogus key reaches
   MiniMax directly and gets its 401, which confirms the traffic never touches the relay.
   **Fixed as INV-1363**: the environment carries only `LUMENBOX_RELAY_URL`/`_TOKEN` (no vendor
   variable, so no catalogue provider lights up), the preset writes opencode's global config
   declaring a `lumenbox` provider whose `baseURL`/`apiKey` are `{env:}` references (same bytes
   for every job, so concurrent jobs cannot cross routes), and a bare model id runs as
   `lumenbox/<id>`. After the fix opencode's own log shows only `providerID=lumenbox`.
2. **Claude on MiniMax-M3.1-Flash sometimes skips `delegate_submit`.** One cell in two runs:
   the engine wrote the file, printed "Done", exited 0, and never called the report tool; the
   Delegate verdict machinery (INV-1261) correctly refused the claim. This is the model, not the
   plumbing — the same brief submitted in the other three claude cells of the same run. Worth
   watching across runs before deciding whether the brief's delivery instructions need to be
   louder for this model.
3. **The 0.3.7 image cannot install mcode at runtime.** Two causes, found in order:
   - `/home/box/.npm` is **root-owned in the image** (the engine installs run as root with
     `HOME=/home/box`), so every `Delegate install: true` as the box user died with EACCES on
     npm's cache. Fixed in this change: the Dockerfile hands the cache to `box:box` after the
     last engine block, and `release-check` asserts the line stays there.
   - With the cache writable, mcode 0.6.12's `verify-native-install` refuses Node 22.18.0. The
     Dockerfile already pins 22.20.0 (#194); on an image built from it mcode passes all four
     applicable cells (table above). The published 0.3.7 image cannot run mcode at all.
4. **The follow-up brief must be unambiguous for a small model.** The first wording ("append
   the single line AGAIN") was read by MiniMax-M3.1-Flash as "append the line again", producing
   `PONG\nPONG` and a false "did not resume" verdict. The job logs showed the same Claude session
   id across both briefs, including across the recycle. The brief now says "the new line's text
   is exactly: SECOND"; both claude cells then passed.

## What this does not measure

A single provider, on one machine. The model-switch column is structural, not measured. A pass
is the engine's own report plus the file; the harness does not grade how the engine got there.
Timings are wall-clock for the cell including the scripted coordinator's turns.
