# Workbuddy: skills, presets, delegated engines — the hands-on program

Status: **charter + recon, 2026-08-29 end of session.** The owner's directive:
stop designing and start *operating* — prove the agent/box built-in skill, ACP
and coding-delegation capabilities against real work, then package them: the
workbuddy preset suite (skills bundled into deliverable domain capability) and
the doubaowork companion crew (agents with built-in skills and personas).

## Recon: what already exists (verified against the tree and the box)

- **The Delegate/Preset architecture is built and empty.** `src/host/presets.ts`
  defines the five-faced preset unit (packaging, one-tool interface, skills
  projection, relay metering seam, acceptance tasks) with `opencode` and
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

**E4 — the first workbuddy preset.** Pick one domain the installation already
lives in (candidate: 飞书办公 — the lark-cli skills, document/meeting/table
verbs this repo already exercises daily). Bundle: skills + the engine (if E2
proves one) + golden acceptance tasks + a one-line install. Deliverable: a
person says one sentence and the buddy does the domain job end to end.

**E5 — the doubaowork companion crew.** Two or three persona agents as shipped
data: name, title, persona prompt, tool allowlist, scope, built-in skills —
e.g. 秘书 (calendar/mail/docs), 研究员 (search/read/summarise into documents),
工程师 (E2's delegated coder). Ship as a roster preset the settings page can
instantiate; measure a week of real use against "would the owner keep them".

## Rules of the program

- Measured over believed: every experiment ends with what actually happened,
  in a run log under `research/workbuddy/`.
- The docs/13 rule applies to E4/E5 designs before they ship as product.
- Engines are pinned; upgrades are explicit acts with acceptance runs.
- The key-in-box shortcut of E1 is quarantined to the test tenancy and listed
  on the pre-launch security list the day it is taken.
