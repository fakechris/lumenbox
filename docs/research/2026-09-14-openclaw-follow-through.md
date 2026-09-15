# OpenClaw: how unanswered questions, pending work and future commitments are handled

Surveyed 2026-09-14 from `~/sdcard/source/openclaw` (read-only), for the follow-through
design (docs/51). Citations are file:line in that tree.

## 1. Unanswered questions

`ask_user`, main session only (`src/agents/openclaw-tools.registration.ts:115`; stripped in
swarm runs). Hard expiry with a proceed-anyway default: 900 s, clamped 30–3600 s
(`src/agents/tools/ask-user-tool-normalization.ts:5-7`); the gateway timer `expire()`s
(`src/gateway/question-manager.ts:119, 304-310`) and the result is
`{status: "no_answer"}` — *"No answer arrived; proceed with best judgment."*
(`ask-user-tool.ts:401-408`; tool contract `tool-description-presets.ts:166`). Skip is a
cancel, rendered "Skipped" (`ui/.../chat-pane-render.ts:327`). **Typing anything else is
consumed as the answer**, not treated as moving on (`attempt-queue-message.ts:402-418`,
`resolvedBy: "plain-text"`). One pending question per session
(`harness/gateway-question.ts:164`); 1–3 questions × 2–4 options per call; the only budget
is prompt guidance ("Prefer one question… never ask whether to proceed", `:162-164`).
Approvals: exec 1 800 000 ms, plugin 120 s/600 s; on timeout `askFallback` **denies**
(`docs/tools/exec-approvals.md:194-200,242`).

## 2. Pending work

Two registries, both ageing by last-update, **no due dates, no human-facing reminder loop**.
*Background tasks* (`src/cron`, `openclaw tasks`): a 60 s sweeper reconciles/repairs/prunes;
runtime gone > 5 min → `lost`; terminal records pruned after 7 d, `lost` after 24 h; ageing
findings (`stale_queued` > 10 min, `stale_running` > 30 min, `stale_blocked`…) are shown by
`openclaw tasks audit` / the Tasks page, **not pushed**. Completion is pushed (channel or a
system event that wakes a heartbeat); blocked deliveries retry 30 min then need
`tasks retry|dismiss`. *Workboard cards* (`extensions/workboard`): schema has only
`createdAt/updatedAt` (`packages/workboard-contract/src/index.ts:369-380`); staleness
thresholds `READY_STRANDED_MS` 1 h, `RUNNING_HEARTBEAT_STALE_MS` 20 min,
`BLOCKED_TOO_LONG_MS` 24 h are passive diagnostics ("Blocked card needs attention",
`store-card-helpers.ts:432-485`); claims expire (30 min) and a dispatch pass blocks them;
nothing auto-archives; the only nudge is card→automation, not →human
(`automation-nudge.ts`). *Suggestions* the model makes (`suggest_task`) are process-local,
capped 100 / 2 MiB, lost on restart, never age. "Stale task > 24 h → remind owner" exists
only as a documented pattern (`docs/automation/standing-orders.md`).

## 3. Commitments about the future

Two durable, explicit mechanisms; neither is created from prose. (a) **Automations**
(`automations`/`cron` tool, `src/agents/tools/cron-tool.ts:180-213`): *"reminders, delayed
self-wakeups, loops, recurring work… Never exec sleep/poll as timer"*; the system prompt
adds *"Reminder text must read as reminder when fired"*; `at` jobs auto-delete after a
success; recent chat lines can be embedded. (b) **Standing intents** (event-conditioned
prospective memory, `extensions/memory-core/src/standing-intents.ts`): keyword-triggered,
cooldown 24 h, max 3 fires, expiry 90 d, deterministic FTS prefilter, lifecycle
pending→armed→fired→done. Heartbeat scratch is explicitly *not* a scheduler
(`src/auto-reply/heartbeat.ts:8-12`). Verification afterwards is about jobs, not promises:
run history 7 d/2000 rows, failure alerts after 2 consecutive failures (1 h cooldown),
auto-disable after 10 failures with an owner notice (`src/cron/service/auto-disable.ts`).
**No mechanism checks that a verbal promise produced a job.**

## 4. Proposing to close; silence

Narrow: `dismiss_task` withdraws only a pending suggestion the agent itself made
(`task-suggestion-tools.ts:120-127`); workboard `complete`/`block`/`move` on a card it holds
a claim for, never archive/delete; "Manual review states win" (`docs/plugins/workboard.md:341`);
standing intents: *"Cancellation is always explicit… never inferred from ordinary
conversation."* **Silence is never consent to close.** Where silence closes anything it is a
machine-state timeout: question → `no_answer`, approval → deny, task `lost`, auto-disable,
claim TTL.

## Heartbeat / cron

Jobs via CLI, the `automations` tool, RPC, `/loop`, or declarative config; schedules
`at | every | cron(+tz) | on-exit | stream`; payloads `agentTurn | systemEvent | command |
script`; persisted in `~/.openclaw/state/openclaw.sqlite` with run receipts; a single
next-wake timer re-armed after every mutation, restart catch-up, top-of-hour stagger;
delivery `announce | webhook | none` with idempotency keys; pause per job, `autoDisabled`,
global `cron.enabled`, runtime `schedulingPaused`. The heartbeat is one system-owned job per
agent (default every 30 min), `HEARTBEAT_OK` short replies dropped, per-monitor scratch
(≤256 KiB) is the only durable checklist and an empty one skips the run.
