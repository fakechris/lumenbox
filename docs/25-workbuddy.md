<!-- doc: 25-workbuddy
     title: Workbuddy: skills, presets, delegated engines — the hands-on program
     family: decision
     status: current
     updated: 2026-10-20
-->
# Workbuddy: skills, presets, delegated engines — the hands-on program

Status: **charter + recon, 2026-08-29 end of session.** The owner's directive:
stop designing and start *operating* — prove the agent/box built-in skill, ACP
and coding-delegation capabilities against real work, then package them: the
workbuddy preset suite (skills bundled into deliverable domain capability) and
the doubaowork companion crew (agents with built-in skills and personas).

## Recon: what already exists (verified against the tree and the box)

- **The Delegate/Preset architecture is built and empty.** `src/host/presets.ts`
  defines the five-faced preset unit (packaging, one-tool interface, skills
  projection, relay metering seam, acceptance tasks — and since 2026-09-03 the MCP face,
  docs/33: `Delegate` with `tools` lends the engine named host MCP tools through a
  per-job route) with `opencode` and
  `claude` rows; the `Delegate` tool exists; runs travel as
  `bash background: true` + `Jobs`, which makes a delegated engine visible,
  interruptible and loggable like any other job. **Neither engine is installed
  in the box** (`/usr/local/bin` holds only box tools), and the relay variables
  are unset, so `delegateEnv` is `{}` and startup says so.
- **Prior design**: `research/CODING-AGENT-PRODUCT-PLAN.md` (+v3, +Grok review),
  `research/CODING-AGENT-BRIDGE-REPORT.md`, `research/AGENT-RUNTIME-PLAN.md` —
  read before re-deciding anything they decided.
- **Skills**: `SkillCache`, the box skills directory, and `skillsMount`
  projection per preset — the write-once-run-anywhere half is designed.
- **No ACP anywhere in src.** Whether opencode/pi speak ACP usefully is an
  experiment, not a fact.
- **Persona/roster primitives**: agents already carry `tools` allowlists,
  `scopeId`, per-agent `provider/model`, titles and descriptions — a companion
  crew is data we can ship, not machinery we must build.

## The experiments, in order

**E1 — an engine actually in the box. DONE 2026-08-30**, run log with all
measurements in `research/workbuddy/E1-engine-in-box.md`. opencode 1.18.25 is
pinned in the image (`OPENCODE_VERSION=1.18.25 agentbox box build`), the probe
passes, and a delegated-shape run wrote and executed real code against
MiniMax-M3. Three bugs stood in the way (build arg dropped, volume shadowing
the skills symlink, root-owned `~/.local`) — all fixed at the source of truth.
Two findings changed the preset: opencode ignores `*_BASE_URL` env (a true
relay needs its config-file face), and headless runs need `--auto` or every
tool call is silently rejected. New `AGENTBOX_RELAY_MODEL` names the engine's
model. The key-in-box shortcut is live and on the pre-launch security list.

**E2 — Delegate end-to-end, with interruption. DONE 2026-08-30**, four probes
measured in `research/workbuddy/E2-delegate-interruption.md`. The happy path
works through the real seam (Bob → Delegate → Jobs → independent re-verify,
4/4 tests). Measured semantics: 停 stops the *turn* at the next round
boundary and never the job; interruption granularity is min(job exit, wait
timeout — 60s default chunks); `Jobs kill` is the explicit job-level act and
the log survives as forensics; a steering message queues and lands between
wait chunks, and the one-shot engine cannot be steered mid-flight — the
supervising agent compensates post-hoc. That last gap is E3's question.

**E3 — ACP probe. DONE 2026-08-30**, measurements in
`research/workbuddy/E3-acp-probe.md`. The pinned opencode ships both `acp`
and `serve`; probed the HTTP face. Session mode buys real control, measured:
token-level SSE streaming, mid-flight steering that landed in the code,
abort in 33ms (vs 60s wait chunks), and a session that survives abort with
full context. Verdict: `bash background + Jobs` stays right for
fire-and-forget; supervised delegation is worth the session face — one flag
away in the same pinned binary, `run` changes and nothing else. Deferred
behind E4/E5 and the docs/13 rule; pi was not probed (host-side, different
game).

**E4 + E5 — the researcher bundle and the crew. DONE 2026-08-30** (merged:
the bundle format is the crew's row format), run log in
`research/workbuddy/E4-E5-crew.md`, manifests beside it. Three buddies as
pure data — Iris 研究员, Mia 秘书, Enzo 工程师 — installed via
`POST /api/agents` (the installer already existed), each passed its golden
task from one sentence, in parallel, with externally verified artifacts
(sourced ACP brief with reachable links; a morning note reflecting real
work-dir changes; a code fix where the persona's delegate-or-DIY judgment
showed). 飞书办公 was measured too thin for a bundle today (ReadFeishuDoc is
docx/wiki read-only) — blocked on write-side Feishu tools or an in-box
credential decision, recorded. The week-of-use measurement is the owner's;
the settings-page "add this buddy" productization waits on the docs/13 rule.

## The productization landed (PR #14, 2026-08-30)

The settings-page half that E4/E5 deferred shipped the same day from the other
side of the two-agent split: **the built-in catalog** (`src/host/catalog.ts` +
`catalog-data/`). A crew is several experts; an expert is a standing persona
(`catalog-data/experts/*.md`, rewritten — no identity theatre, no frozen tool
names) plus vendored skill-hub packages (`catalog-data/skills/`, copied as-is,
provenance in `SOURCE.md`, seeded globally into the box by starter-skills'
marker mechanism). Seven experts (Lin 工程师, Heng 审查, Mo 产品, Jian 主笔,
He 种草, Jing 编剧, Xi 分析师), two crews (`ship`, `media-desk`), three tool
tiers (DESK/WEB/CODE) with `intersectTools` clamping a new agent to what its
creator holds. Install paths: New-agent chips on the web page, `CreateAgent
from: <slug>`, `GET /api/catalog`. Fresh installs seed a starter four
(Ada/Rex/Ops/Vera in `orchestrator.ts`); existing rosters are untouched.

How the two halves relate: E4/E5's manifests were the measured prototype
(one-sentence golden tasks, externally verified; the live Iris/Mia/Enzo crew
stays installed for the week-of-use verdict); the catalog is the shipped
mechanism. New bundles should go into the catalog, and a catalog row's golden
tasks — the acceptance face the preset charter promised — are still to be
attached: the manifests here show the shape.

## Measured: what the engines say when a run fails (INV-908, 2026-10-01)

The host used to settle a delegation from the job's exit code. The pinned engines were run
against a stub model server that answered ok, 400, 401 or 500, with no credentials and no real
model. The fixtures in `src/host/fixtures/engine-report/` are their actual output.

| engine, mode | ok | 400 | 401 | 500 |
|---|---|---|---|---|
| claude 2.1.250, `--output-format stream-json --verbose` | exit 0; `result` frame, subtype success | exit 1; `result` subtype **success** with `is_error: true` | exit 1 after 10 `api_retry` frames; then the same | exit 1 after 10 retries; the same |
| pi 0.85.1, text (the preset until now) | exit 0, the answer | **exit 0, no output at all** | exit 1 | exit 1 |
| pi 0.85.1, `--mode json` | exit 0; `agent_end`, last assistant `stopReason: "stop"` | **exit 0**; `stopReason: "error"` with `errorMessage` | **exit 0**, the same | **exit 0**, the same |
| opencode 1.18.25, `--format json` | exit 0; last `step_finish` has `reason: "stop"` | exit 1; `{"type":"error"}` events | exit 1; the same | exit 1; the same |

Claude asked to resume a thread it does not have answers with a `result` frame:
`subtype: "error_during_execution"`, `num_turns: 0`, and
`errors: ["No conversation found with session ID: …"]`, exit 1.

So an exit code says nothing either way. pi's json mode exits 0 on every failure, and its text
mode answers a 400 with silence and exit 0. Since INV-908 every preset runs in its
machine-readable mode, and the host reads the engine's last report from the log
(`engine-report.ts`). The outcome is `done` only when the engine said it completed, `failed`
or `aborted` when it said so, and `unknown` when it said nothing. The exit code is kept as
evidence and decides only a failure the report does not contradict. A resume Claude refuses
drops the thread capsule; the next run starts fresh and says why.

## Measured: MiniMax Code as the fourth preset (INV-1233, 2026-10-20)

mcode 0.6.12 (`@minimax-ai/code`, read at minimax-code 9a93560) in the box image, run with the
preset's exact command against a stub Anthropic-messages server on an `--internal` docker
network — no route to anything else, so a call to MiniMax's cloud would have failed loudly.
The fixtures `src/host/fixtures/engine-report/mcode-ok.jsonl` and `mcode-refused.jsonl` are its
output as written.

| run | exit | last line | what the stub saw |
|---|---|---|---|
| stub answers | 0 | `exec.completed`, `result.status: "succeeded"`, `output` the answer, `usage.{inputTokens,outputTokens}` | `POST /v1/messages/count_tokens` ×2 (answered 404, tolerated), `POST /v1/messages` with `stream: true`; auth as `x-api-key`; nothing else |
| relay refuses the connection | 4 | `turn.failed` then `exec.completed` `status: "failed"`, `error.message` "BYOK provider … upstream error: Connection error.", `usageSource: "unavailable"` | — |

What the preset does and why, each read in the engine's source and then watched here:

- **`--permission full`, on the command line.** `exec`'s default is `smart`, which sends every
  tool input the local rules cannot decide to `agent.minimax.{cn,io}/mavis/api/v1/permission/check`
  — with a customer's own key as much as with MiniMax's, because the CLI marks itself a managed
  runtime. `full` keeps the deterministic denies and asks nobody. `ask` is refused headless.
- **The profile is per run and gone afterwards.** mcode reads its provider from `config.yaml`
  in its data directory and expands no variables, so the credential has to be in that file.
  The run makes a `mktemp -d`, points `MINIMAX_DATA_DIR` at it, writes the file from
  `$LUMENBOX_RELAY_TOKEN` and removes the directory on `EXIT`. After both runs: no `/tmp/mcode.*`
  left, and `grep -rl <token> /home/box /tmp` found nothing.
- **`goal.verification: subagent`** in the profile. A custom provider defaults to `none`, where
  the worker's own claim closes the goal.
- **Telemetry off twice** (`MCODE_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`); it is opt-in anyway.
  The update check is wired only into the interactive TUI.
- **Node 22.19+**: 0.6.x refuses older with exit 1, so the image's Node moved 22.18 → 22.20.
  The install needs scripts (better-sqlite3's prebuilt), unlike pi's.
- **Not measured:** a run with tool calls against a real model, `--max-steps` reached
  (`limit_exceeded`, exit 7, read as aborted), and a MiniMax endpoint's answer to
  `count_tokens` through the real relay (the stub's 404 was tolerated).

## The engine's own report, checked at the gate (INV-1261, 2026-10-20)

A completion event says finished or failed; it does not say what was done or why that counts.
Every brief now ends with delivery instructions, and settling reads the report before the event:

- **Shape** (`delegate-report.ts`): `done[{what, evidence}]` where evidence is a command with
  its output, a path, or a diff summary — the engine's own sentence is not evidence;
  `not_done[{what, why}]`; `problems[]`; `verdict` done / partial / failed. `unknown` is the
  host's word, never the engine's. Bounded (32 items, 2k chars a string, 64 KB) and redacted.
- **Two ways in.** Engines with an MCP client (claude, opencode) get the face's
  `delegate_submit`: checked while the run is on, refused with every reason, called again until
  accepted, kept by job id past the route's end. Engines without one (pi; mcode's one-shot form,
  which loads no MCP servers; the session form) write `/home/box/work/.lumenbox/reports/<job>.json`
  before they exit; the host reads and checks it when the run settles, and a malformed file is no
  report. `preset.report` says which.
- **Settling** (`judgeWithReport`): the report's verdict decides when the event agrees or has
  nothing to say; a **contradiction is `unknown` with both named**; a **done event with no report
  is `unknown`** — a completion claim with nothing behind it — while a failure or a stop stands on
  the event alone. The note to the agent carries the report's summary beside the outcome and the
  working tree (INV-1258).

Not yet run against a real model on each engine; the delivery text and the file path are what
the engine sees, and the fixtures above are what it says back.

Not measured: a long run with tool calls on each engine against a real model. The parsers
read only the final events, and an opencode run cut off after a tool-calls step has no
completion report, so it is `unknown`.

## Rules of the program

- Measured over believed: every experiment ends with what actually happened,
  in a run log under `research/workbuddy/`.
- The docs/13 rule applies to E4/E5 designs before they ship as product.
- Engines are pinned; upgrades are explicit acts with acceptance runs.
- The key-in-box shortcut of E1 is quarantined to the test tenancy and listed
  on the pre-launch security list the day it is taken.
