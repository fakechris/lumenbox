# Adversarial review: docs/24 context/memory analysis (2026-08-29)

Two reviewers commissioned; this file records findings and dispositions.
**Codex round: complete** (job `review-mtez8ei8-kkbohq`, 7 high 1 medium).
**Grok round: pending** — appended here when it lands.

The headline: the analysis was **factually stale about our own code** in three
places, ranked its gaps on those stale facts, and the review found three real
implementation bugs the analysis missed entirely. Spot-verified before
accepting: `ReadHistory` at `tools.ts:800`/`history.ts:215`, the summarise
client at `turn.ts:623`, `REPLAYED_RESULT_LIMIT = DURABLE_RESULT_CHARS` at
`turn.ts:516`. All three confirmed.

## Codex findings, with dispositions

1. **HIGH — the "no recovery tool" gap is false.** `ReadHistory` exists, reads
   the conversation's own transcript, and is advertised to the model after
   compaction ("The originals were not deleted"). *Disposition: gap #6 and P1
   item 8 removed from docs/24; replaced by an audit item (scopes,
   discoverability, bounds).*
2. **HIGH — real bug: a configured summary provider is called through the
   primary client.** `resolveSummaryProvider` may pick another provider;
   `summarise` only swaps the model string — wrong endpoint, wrong credential
   when `AGENTBOX_SUMMARY_PROVIDER` points elsewhere; background failures are
   swallowed and eventually become dropped-history markers. *Disposition:
   accepted; promoted to P0 #1.*
3. **HIGH — real bug: speculative summaries validated by entry count, not
   token pressure.** `pendingIsUsable` never weighs the uncovered tail; one
   enormous steering message later, a stale summary is adopted and the request
   can still be unsendable. *Disposition: accepted; P0.*
4. **HIGH — the "summary contract" is not enforced and its evidence is
   clipped.** Inputs truncated to 400 chars before the summariser (paths and
   ids beyond that are unrecoverable); output accepted if nonempty — no heading
   or word-cap validation. *Disposition: accepted; mechanical anchors +
   validation promoted to P0.*
5. **HIGH — the anti-thrash proposal targeted the wrong failure.**
   `compactionUrgency` counts history only; system prompt and tools are never
   in the pressure estimate, so an incompressible floor produces *rejected
   requests without compaction*, not compaction-every-turn — and there is no
   real `prompt_tokens` observation point for the proposed check. Also: the
   doc's CJK claim was backwards for our estimator (a global 2.5 chars/token
   *under*-counts CJK → late compaction, not premature), and context windows
   are cached by bare model name across providers. *Disposition: accepted;
   P0 becomes complete-request preflight accounting first, anti-thrash after
   there is something to observe.*
6. **HIGH — real bug: overlapping Rememberer batches can reverse memory
   chronology.** The pending queue is cleared before awaiting extraction; a
   slow old batch appends after a newer correction and out-ranks it in
   chronological recall. *Disposition: accepted; serialize per agent (P1).*
7. **HIGH — durable-state survival was overclaimed.** Only *persisted* plans
   survive; the extractor excludes plans; the proposed nudge fires after the
   history is already summarised. *Disposition: §1 wording corrected; the
   P2 nudge redesigned as a bounded checkpoint against the uncompacted
   history, or dropped.*
8. **MEDIUM — "deterministic pruning: images only" was stale.** Replayed tool
   results are already cut to `DURABLE_RESULT_CHARS` with spill pointers, and
   overflow recovery trims old results to 500 chars. Deduplication and
   argument-trimming are the genuinely missing pieces. *Disposition: table
   corrected; the P0 scoped to measured residual bulk (duplicates, arguments),
   after composition measurement.*

## The corrected P0 (reflected in docs/24 §5)

1. Fix summary-provider routing (client+profile resolved together, validated
   at startup; fall back to the agent's own model before ever adopting a
   dropped-entry marker).
2. Complete-request preflight accounting: system + tools + history in the
   pressure estimate, calibrated per provider/base-URL; detect the
   incompressible floor before dispatch.
3. Mechanical summary anchors (full-block paths/ids/spill pointers extracted
   outside the LLM) + heading/size validation + explicit previous-summary
   update input.
4. Token-validate pending summaries before adoption.

Then: anti-thrash (now observable), Rememberer serialization, cut anchoring,
tool-exemplar retention, measurement-driven prune scoping.

## Lesson recorded

The analysis was written from a code map made days-to-hours earlier plus the
incident; two of its three named "structural gaps" were features that already
existed. The repo's own rule applies to analysis documents too: **verify the
artifact, not the memory of it** — every "we don't have X" claim in a
comparison doc needs a grep the same day it is written.
