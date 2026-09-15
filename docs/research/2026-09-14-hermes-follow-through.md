# Hermes: how unanswered questions, pending work and future commitments are handled

Surveyed 2026-09-14 from `~/sdcard/source/hermes-agent` (read-only), for the follow-through
design (docs/51). Citations are file:line in that tree.

## 1. Unanswered questions

Timeout with an explicit default, not a failure: `tools/clarify_tool.py:20-34` — per-call caps
(`MAX_CHOICES = 4`, `MAX_QUESTIONS = 5`) and the sentinel *"The user did not provide a response
within the time limit. Use your best judgement to make the choice and proceed."* Timeout
`agent.clarify_timeout` default 3600 s (`tools/clarify_gateway.py:531-572`,
`hermes_cli/config_defaults.py:278`). Skip and walk-away are distinguished: an empty
`user_response` plus a top-level `timed_out` flag (`clarify_tool.py:254-258`); a timeout in a
batch aborts the remaining questions rather than asking one by one (`:286-325`). No per-session
question budget; prompt guidance only (`agent/prompt_builder.py:575`), and an outright ban for
headless kanban workers (`:358-363`: the call would "sit silently in running"). Pending
questions are not persisted across a gateway restart.

## 2. Pending work

A SQLite kanban (`hermes_cli/kanban_db.py:102`: triage/todo/scheduled/ready/running/blocked/
review/done/archived). **No due dates.** Ageing exists only as lease reclamation for *running*
work (`claim_expires`, heartbeat stale after 3600 s, `tools/kanban_tools.py:377`). Staleness is
**diagnosed on demand, never swept**: `hermes_cli/kanban_diagnostics.py:831-879`
(`_rule_stuck_in_blocked`, 24 h) — "stateless and read-only… computed on demand (on /board
load…)". Escalation instead of auto-close: two block/unblock cycles for the same cause route
the task to `triage` (`kanban_db.py:134, 6365-6404`); a failure breaker moves it to `blocked`
with a `gave_up` event (`:9186-9230`). Nudges are one-shot pushes on events
(`gateway/kanban_watchers.py:242, 580-584`); nothing repeats for an item that stays blocked.
Archive is human/CLI only; the agent has no archive or delete tool.

## 3. Commitments about the future

A real scheduler the agent can write to: `cron/__init__.py:1-16` ("self-schedule reminders
and follow-up tasks", 60 s tick), tool `cronjob` (`tools/cronjob_tools.py:1729-1750`), one-shot
jobs from "30m"/"2h"/ISO (`cron/jobs.py:737-828`), persisted in `~/.hermes/cron/jobs.json`
with an executions ledger and a per-job notepad re-injected each run (`cron/notepad.py`).
The mechanism that makes promises happen is **in the turn, not later**: "Never end your turn
with a promise of future action — execute it now" (`agent/prompt_builder.py:~374-380`) and a
synthetic stop-nudge with a budget of 2 (`agent/kanban_stop.py:87-101`). Verification after
the fact exists for code edits (`agent/verification_stop.py`) and goal loops with a judge
(`hermes_cli/goals.py`, 20 turns, fail-open), not for promises. **Gap:** nothing turns "by
Friday" into a job, and nothing reconciles a job against the promise that motivated it; cron
runs warn the agent it is alone (`cronjob_tools.py:1746-1748`).

## 4. Proposing to close; silence

The agent can only *propose* by moving work into a human-facing lane: typed blocks
(`kanban_db.py:105-130` — `needs_input`, `capability` are "genuinely human-only"); "Block on
genuine ambiguity… and stop. Don't guess" (`agent/prompt_builder.py:281-285`). It cannot
self-close (`tools/kanban_tools.py:84-90`, DB guard `kanban_db.py:164-186`); `kanban_block` is
restricted so it cannot be an escape hatch (`kanban_tools.py:230, 845-866`). Suggested
automations are consent-first, capped at 5 pending, latched on refusal, and never expire
(`cron/suggestions.py:19-23, 57`). **Silence is uniformly "leave it pending"**: a question →
proceed on judgement; a work item → sits in blocked/triage until someone opens the board.

## Heartbeat and state

Two "heartbeats": a liveness one (60 s, observation-only, `agent/session_activity.py:22-30`)
and the gateway's 60 s tick that fires cron (with misfire catch-up, `gateway/run.py:30290-30310`),
housekeeping, kanban dispatch/notify, and a post-turn background review thread
(`agent/background_review.py`). State: `~/.hermes/cron/*.json|db`, `~/.hermes/kanban.db`,
SessionDB `state_meta`; alert-dedup flags on the job so an operator is pinged once per condition.
