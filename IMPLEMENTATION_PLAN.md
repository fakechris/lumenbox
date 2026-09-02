# Implementation plan — after the Grok Bot 0.30 delta and the 2026-09-01 audits

Source of items: docs/28 (twelve ranked), docs/reviews/2026-09-01-runtime-audit.md (#4,
#6 open; #2's real fix), docs/26 (DingTalk sweep), docs/27 (adapter contract). Ordered by
measured pain × dependency; each stage ships green on its own.

## Stage 1: Prompt-layer conduct (cheap, high impact, no architecture risk)
**Goal**: the agent replies first, delivers last, never invents data, asks decisions as
natural questions, and proposes routines for repeatable asks — as stable prompt text.
**Success Criteria**: new stable section `conduct` present in `sectionsPresent`; AskUser
description carries the phrasing rule; skills section carries the routine mandate; prompt
floor logged once per turn; tests pass; a Feishu turn visibly opens with a one-line reply.
**Status**: Complete (2026-09-02) — with a measured caveat: on three console probes (7s, 9s,
50s turns) MiniMax M3 opened tool-first every time despite the rule; the Feishu Typing
reaction is the receipt a person actually sees, so presence is covered by the wire, not the
model. Adherence is now a `[conduct]` line per person-opened turn in the web log; revisit
the rule's wording once a week of production numbers exists. Bob's prompt floor: system +
31 tools ≈ 25.6k tokens, whole request ≈ 55k.

## Stage 2: Memory as files the agent can read, frozen across compaction
**Goal**: project the live memory view into the box (`~/work/memory/<agent>/profile.md` +
`log/YYYY-MM.md`, read-only), snapshot the rendered memory block per compaction epoch so
the prefix stays byte-stable (also closes audit #6), cap the skill index (audit #4).
**Success Criteria**: files appear after a RememberFact; continuation reuses the frozen
block (test); a 300k-char skill description is truncated with the cut named in the log.
**Status**: Complete (2026-09-02). Mirror verified live for all six agents on box connect;
selection carried across continuation (test proves the old code lost it); description cap
400 chars + index cap 12k chars with the unlisted named.

## Stage 3: Auto-review classifier, shadow mode
**Goal**: a per-call LLM review for outbound/binding actions (RunOnHost, SendToChat-class
pushes, file writes outside the work dir, Delegate) with the explicit-intent primitive and
the untrusted-origin rule; verdicts logged, nothing enforced.
**Success Criteria**: every reviewed call has a verdict line in the usage/audit log; a
fixture of ten trajectories (five ALLOW, five BLOCK) classifies as expected against the
fake model; zero behaviour change for the agent.
**Status**: Complete (2026-09-02). `src/host/auto-review.ts`; reviewed class = RunOnHost,
Delegate, Create/UpdateAgent, SendToAgent, browser_act/upload, writes outside ~/work, and
shell commands matching an outbound/destructive prefilter. Verdicts go to
`~/.agentbox/auto-review.jsonl` and `[auto-review]` web-log lines; `AGENTBOX_AUTO_REVIEW`
= off|shadow|enforce (default shadow; enforce hands BLOCK back to the model as the tool
result). Live eval against MiniMax-M3: 9/10 on the fixture, ~2.5s per review; the one miss
was a verdict lost to quotes inside the JSON reason, now parsed loosely. Fails open when
the reviewer does not answer, recorded as such.

## Stage 4: Provenance for skills, then event-triggered routines
**Goal**: the host records which agent wrote a skill file (tool-path attribution), the
scheduler honours `agent:` only when provenance permits; then a Feishu/DingTalk
message-match listener as a routine trigger.
**Success Criteria**: a skill written by Bob naming Ada is refused with the writer named;
the live weekly-retro still runs; a "when someone says X in this chat" routine fires once
per matching message and never on its own output.
**Status**: Complete (2026-09-02). Provenance: `src/host/skill-provenance.ts`, ledger
`~/.agentbox/skill-provenance.jsonl`, attributed from write_file/edit_file and from bash
commands naming a skill path with a write-shaped operator; scheduler rule = writer or
default agent. Listeners: `trigger: message` + `match:` (+ `chat:`) in frontmatter,
`Scheduler.heard()` fired from the channel manager after admission, delivered to the
thread the message was in, once per message id. Live-verified: unit tests only — a real
Feishu message from a person is needed to see one fire end to end.

## Stage 5: Desktop owner tokens, read-only shell classifier, hooks
**Goal**: forked desktops bound to an unguessable owner token checked in boxd routing;
tree-sitter-bash read-only classification surfaced in approvals; Claude Code-dialect hook
events (`PreToolUse`/`Stop`/`PreCompact`) as the R36 extension seam.
**Success Criteria**: a reused display index refuses the previous owner's token; an
approval card says "read-only" for `ls`/`cat`/`git status`; a Claude Code hook file runs
unchanged.
**Status**: Complete (2026-09-02). Owner tokens already existed in boxd (hashed lapsing
leases, per-agent token from the registry); the recycled-index case is now a test.
`src/host/shell-readonly.ts` tags approvals `[read-only]` when every segment is a known
reader (chain split + safe list, no parser yet; tree-sitter-bash earns its dependency
once a misclassification is measured). `src/host/hooks.ts` reads `~/.agentbox/hooks.json`
(a Claude Code settings.json or the bare hooks object) and runs PreToolUse / PostToolUse /
Stop / PreCompact commands with Claude Code's stdin payload and exit-2 / JSON decisions;
Stop may send the model back once (`stop_hook_active`).

## Stage 6: Bot templates — the bot packs itself, the new bot installs itself (docs/29)
**Goal**: a template is one JSON document (profile, curated memory facts, skill directories,
routines with `{placeholders}`, connector names); export is a conversation ending in one
`PackTemplate` call; import creates the agent from the profile and hands the recipe to its
first turn, with host rails (forced `paused: true`, template-origin stamps, untrusted cue,
reconcile + ledger).
**Success Criteria**: a fixture recipe imported through the orchestrator with the fake model
produces the skills, memories with `source: template:<id>`, routines paused — written by the
model's tool calls, not the host; a routine written unpaused in that turn gets the line; the
new bot is the provenance writer; a credential or an `about` record refuses the export with
the place named; a routine's chat key, agent and timezone come back as placeholders with a
fill-in list; reconcile names what did not land.
**Status**: Complete (2026-09-02) — all four stages of docs/29: the format and rails
(`src/host/template.ts`), the setup turn with its tool allowlist, `PackTemplate` and the served
`export-template` skill, the chat share card, the catalog through the same import, the
`AGENTBOX_TEMPLATES` switch, and share links on the control plane (`src/control/templates.ts`,
`template`/`template_version` tables, `GET /t/<id>`, box-token routes, `--public-url`). Left by
choice: a cheaper model for the setup turn, a gallery.

## Stage 7: Many boxes, one host (docs/30 A+B)
**Goal**: one installation drives several boxes; an agent is created into a box and never
moves; its desktop, skills, memory mirror and scheduled runs are that box's; the Grok VM is
box `grok` beside the Docker box, not a second installation.
**Success Criteria**: `boxes.json` migrates from `box.json` keeping the id; per-box desktop
floors; a two-box orchestrator test where writes, skills, desktops and memory follow the
agent's box and a routine on the attached box runs as its agent; detach refused with residents;
`/desktop/b/<boxId>/<index>` reaches the attached box; the dialog chooses a box once.
**Status**: Complete (2026-09-02) on `feat/multi-box` — `src/box/boxes.ts`, registry and
orchestrator per-box wiring, `/api/boxes`, CLI `box attach|detach|list`, UI box field,
`attach-grok.sh` registering the VM; the UI groups agents by box, labels the chat and desktop
with the box, and Settings has a Boxes block (attach/detach). Live on main since 2026-09-02
night: `agentbox-box` (6 agents) + `grok` (Kai, desktop :10 on Grok Bot's VM). Stage D shipped
the same night (control-plane `box.role`, collector mirror, `/api/admin/boxes*`). Open: docs/30
Stage C (cross-box file transfer).

## Stage 8: The seven small ones from the 2026-09-03 triage (docs/11)
**Goal**: close the entries whose next step was a morning's work each, so the list that
remains is only designs and data: R8's two riders, R24's stamp, R39's security entry, R28's
notes ablation, R36's MCP reload, R26's skill roots, and R25 settled by facts.
**Success Criteria**: steering waits while a Stop hook's send-back runs and a fork join wakes
on an instruction (tests); the turn ledger says model/build/promptHash; `hooks.json` with loose
permissions is refused and docs/10 S-9 exists; `AGENTBOX_ABLATE=notes` and `golden
--memory-from` give the style tier a real ablation run; `mcp reload` applies a config edit
without a restart; `skillRoots` is an ordered search path with collisions reported.
**Status**: Complete (2026-09-02) on `feat/triage-seven`. R25 closed without code: p2p on one
key is a recorded decision, the "unreachable" file is the live 1:1, the record exists. Suite
1056, floor 1056.

