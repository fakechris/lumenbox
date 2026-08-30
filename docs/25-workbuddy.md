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

**E2 — Delegate end-to-end, with interruption.** Seed a small repo with failing
tests in the box; have Bob `Delegate` "make the tests pass"; watch via `Jobs`
and the desktop; then the two probes that matter: 「停」 mid-run (does the job
die cleanly, does the board say so), and a steering message mid-run (is it
queued, dropped, or delivered — measure, don't assume). Collect artifacts and
verify the acceptance-task idea against this run.

**E3 — ACP probe.** Run opencode (and pi, which is on the host with its jiti
extension system) in whatever server/ACP mode each offers; drive one edit
session programmatically; compare against E2's CLI-run on interruption
granularity, streaming visibility, and steering. The question: does ACP buy
enough control to justify a second integration face, or is
`bash background + Jobs` already the right altitude?

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
