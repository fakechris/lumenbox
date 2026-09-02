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
**Status**: In Progress

## Stage 2: Memory as files the agent can read, frozen across compaction
**Goal**: project the live memory view into the box (`~/work/memory/<agent>/profile.md` +
`log/YYYY-MM.md`, read-only), snapshot the rendered memory block per compaction epoch so
the prefix stays byte-stable (also closes audit #6), cap the skill index (audit #4).
**Success Criteria**: files appear after a RememberFact; continuation reuses the frozen
block (test); a 300k-char skill description is truncated with the cut named in the log.
**Status**: Not Started

## Stage 3: Auto-review classifier, shadow mode
**Goal**: a per-call LLM review for outbound/binding actions (RunOnHost, SendToChat-class
pushes, file writes outside the work dir, Delegate) with the explicit-intent primitive and
the untrusted-origin rule; verdicts logged, nothing enforced.
**Success Criteria**: every reviewed call has a verdict line in the usage/audit log; a
fixture of ten trajectories (five ALLOW, five BLOCK) classifies as expected against the
fake model; zero behaviour change for the agent.
**Status**: Not Started

## Stage 4: Provenance for skills, then event-triggered routines
**Goal**: the host records which agent wrote a skill file (tool-path attribution), the
scheduler honours `agent:` only when provenance permits; then a Feishu/DingTalk
message-match listener as a routine trigger.
**Success Criteria**: a skill written by Bob naming Ada is refused with the writer named;
the live weekly-retro still runs; a "when someone says X in this chat" routine fires once
per matching message and never on its own output.
**Status**: Not Started

## Stage 5: Desktop owner tokens, read-only shell classifier, hooks
**Goal**: forked desktops bound to an unguessable owner token checked in boxd routing;
tree-sitter-bash read-only classification surfaced in approvals; Claude Code-dialect hook
events (`PreToolUse`/`Stop`/`PreCompact`) as the R36 extension seam.
**Success Criteria**: a reused display index refuses the previous owner's token; an
approval card says "read-only" for `ls`/`cat`/`git status`; a Claude Code hook file runs
unchanged.
**Status**: Not Started
