# Adversarial review: docs/24 context/memory analysis (2026-08-29)

Two reviewers commissioned; this file records findings and dispositions.
**Codex round: complete** (job `review-mtez8ei8-kkbohq`, 7 high 1 medium).
**Grok round 1: complete** (in-session, 2026-08-29). Independent fact-check of
§1 against `compaction.ts` / `turn.ts` / `memory.ts` / `history.ts` /
`remember.ts` / `prompt.ts`; adversarial pass on the §4 table and the §5
ranking. Hermes/OpenClaw cells were spot-checked, not line-reverified.
**Grok round 2: complete** (in-session, 2026-08-29). Re-review of *v2*
(the ranking Codex + Grok-1 absorbed) against the same four host files plus
`remember.ts`; fact-check, attack the corrected ranking, find what Codex
never saw because it reviewed v1.

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

---

## Grok round

Independent of the Codex job; then the overlap. Citations are to the tree as
read, not to the analysis's memory of it.

### §1, claim by claim

Assembly, the 400-entry backstop, `activeWindow`, pair repair, the 60k /
`window × 0.65` trigger, the 320 entry backstop, `keepTailTokens`, the 60%
entry cap, pair-boundary snap, the 75% background pass, `covers`,
append-only summaries, `pruneOldImages` at 1,600 tokens/image, the 400-round
cap, five memory kinds with decay/weight/dedupe, 4k / 1.5k budgets, the
Rememberer (batch / pitfall / episode), and memory-file compact at 1,000
lines are **true**.

False, stale, or overclaimed:

1. **HIGH — box class is in the stable half, not the volatile half.**
   `STABLE_SECTIONS` is base / box / profile (`prompt.ts:555-558`). The
   shared/private paragraph is `boxClassParagraph` inside `boxSection`.
   Volatile is plan, tasks, chat-files, memory, skills, the history-is-still-
   there block, shared-memory, team, critical recap (`prompt.ts:649-697`).
   The analysis listed "box class" with roster/memory and omitted plan,
   chat-files, the history block, and the recap.
2. **HIGH — "compaction cannot lose the plan" is only true of a persisted
   plan.** `turn.ts:1213` re-reads durable state on *continuation after the
   400-round cap*, not every round. `buildExtractionPrompt` tells the
   Rememberer not to keep plans (`memory.ts:382-383`). An unwritten plan
   lives only in the history the summary replaces — Codex #7, confirmed.
3. **HIGH — "produced on the cheaper profile" overstates the wiring.**
   `resolveSummaryProvider` can return a different provider;
   `summarise` (`turn.ts:623-628`) only swaps `model` on the agent's
   `client`. Same-vendor cheaper model works; `AGENTBOX_SUMMARY_PROVIDER`
   pointing at another company does not. Codex #2, confirmed.
4. **MEDIUM — overflow relief is misstated.** Oldest tool results are cut
   to **500** characters until about **20,000 characters have been
   reclaimed** (`turn.ts:234-268`). The analysis's "sheds oldest
   tool-result text >20k chars" reads as a per-result size gate that does
   not exist.
5. **MEDIUM — the four-section "contract" is a prompt, not a check.**
   `summarise` accepts any nonempty text. `buildSummaryPrompt` clips every
   tool call and result to 400 characters *before* the summariser sees
   them (`compaction.ts:357-375`), so artifact paths past that cut cannot
   appear under **Artifacts** no matter how strictly the model follows the
   headings. Codex #4, confirmed, and this is the live T5000-class hole.
6. **LOW — default `keepTailTokens` is 20k, not "30% of trigger".** 30%
   applies only to `policyForModel` once a window is known
   (`compaction.ts:129`). An explicit `AGENTBOX_COMPACT_AT_TOKENS` freezes
   the 60k/20k/320 constants and ignores the real window
   (`compaction.ts:123`).
7. **LOW — `chooseRelevant` is omitted.** When the 4k budget drops
   memories, a model may pick which ones survive (`memory.ts:608-655`).
   Continuations do not re-run it: `turn.ts:1213` uses scored `recall()`.

### §4, attacked

The table is a comparison of *feature names*. Several cells about us are
wrong, and two of the "structurally behind" morals are attached to the
wrong failure.

1. **FATAL to gap #6 — recovery is not "no agent tool".** `ReadHistory`
   is a real tool (`tools.ts:800`, `history.ts:151`). After a summary,
   the volatile prompt already names it: "The originals were not
   deleted. Use `ReadHistory` to search or read them"
   (`history.ts:215-232`). It also reads a teammate's transcript in the
   same conversation (`tools.ts:2329-2357`). P1 item 8 was proposing to
   build what shipped. Codex #1, confirmed and slightly stronger: the
   prompt already advertises the tool, so the remaining work is an audit
   of scope/bounds, not a build.
2. **"Deterministic prune before LLM: images only" is stale.** Stored
   results are already capped at `DURABLE_RESULT_CHARS` (2,000) with spill
   pointers carried (`turn.ts:516-572`). Overflow recovery further cuts
   to 500 chars. Dedup of identical results and JSON argument-leaf
   trimming are the pieces that are actually missing. Codex #8,
   confirmed.
3. **"No anti-thrash → compact every turn forever" is the wrong
   failure.** `compactionUrgency` estimates *history entries only*
   (`compaction.ts:659-671`). System prompt and tool schemas are never in
   that number, so an incompressible floor produces **rejected requests
   that never compact**, not chronic compaction. Hermes #14695 was
   compact-every-turn *because they count the floor*. Copying their
   ineffective-pass counter onto our history-only trigger cannot observe
   the failure we would actually hit. Codex #5, confirmed.
4. **CJK direction is backwards.** `CHARS_PER_TOKEN = 2.5` means
   `tokens ≈ chars/2.5`. CJK is ~1 token/char, so this *under*-counts CJK
   (late compaction) and *over*-counts English/JSON (early). The analysis
   called 2.5 "over-counting → premature, the same failure Hermes
   patched". Hermes's CJK bug was the other way. The comment in
   `compaction.ts:32-36` already states the intent: 2.5 is supposed to
   compact early. Whether it does depends on the mix, which is why a
   real-usage projection is the fix, not a smaller constant.
5. **"Plans survive *and* stay current inside a turn" overclaims the
   refresh.** The volatile rebuild is on continuation after 400 rounds,
   not per round. Hermes freezing MEMORY.md for the prefix cache is a
   real opposite trade; we do not actually take the "refresh every
   continuation of a normal turn" side of it.
6. **"Speculative background summary — unique" holds if scoped to an
   off-thread LLM summary started at 75% of trigger.** Hermes's
   "speculative" is a display-token preflight seed
   (`context_compressor.py` around the preflight snapshot), and
   `background_review` is a memory/skill fork, not a history summary.
   OpenClaw preflight is synchronous. Keep the uniqueness; do not
   describe it as "nobody else hides the pause" in a way that erases
   those neighbouring mechanisms.
7. **Cut anchoring "pair-safe only" is true and is the docs/23
   remaining hole**, but the table's contrast undersells what our tail
   *looks* like. `keepTailTokens` is a token budget. A handful of 1,600-
   token screenshots fill 20k; `pruneOldImages` then drops all but the
   newest, so the "protected" tail of recent `computer` call/result pairs
   — the thing MiniMax was imitating — is not actually protected as
   schema exemplars. Pair-safety and exemplar-survival are different
   guarantees. Hermes's last-20 / last-user-and-assistant-verbatim is
   the latter.

Hermes trigger (50%, 75% floor under 512k, tool schemas in the pressure
estimate) and OpenClaw's pre-compaction memory flush are real in the
trees as described; I did not re-walk every cited line of §2–§3.

### §5 ranking, attacked

The list is ranked by *named absences against the other two systems*.
Expected damage, given **this** tree and **the incident that commissioned
the document**, is a different order.

docs/23's chain, from the log: entry trigger at 5–12k tokens → summary
of the live task's own recent `computer` calls → MiniMax-M3 lost the
schema. Entry triggers are already a backstop. What that chain still
needs is **cut anchoring + recent successful tool-pair retention**.
Deterministic demotion of *old text results* would not have saved the
format: stored results are already 2k, and the summarised material was
recent CUA pairs inside the would-be tail.

So:

| Analysis rank | Why it does not survive |
| --- | --- |
| 1. No deterministic text-result pruning | Residual gap is dupes and argument leaves, not "we summarise bulky text first". Not the docs/23 vehicle. |
| 2. No anti-thrash | Wrong failure (see §4.3). Becomes meaningful *after* the pressure estimate includes system+tools and we observe real `input_tokens`. |
| 3. No real-usage calibration | Real, but the CJK story is backwards; counting system+tools is the larger half of this item. |
| 4. No cut anchoring | **This is the remaining docs/23 hole**, ranked too low. |
| 5. No summary quality guard | Real; the 400-char clip is the live mechanism, not just "no heading check". |
| 6. No recovery tool | False; already shipped. |
| 7. No pre-compaction save nudge | Real and small. The proposed P2 fires *after* the history is summarised, which is the wrong time (Codex #7). |

P0 as written (#2 demote old text, #3 ineffective-pass on history-only
trigger, #4 estimator-only) should not be this week's work in that
shape.

### What the analysis missed (Grok-only, on top of Codex 2/3/6)

- Mid-turn `compactHistory` after 400 rounds (`turn.ts:1192-1213`) is a
  second compaction site. A long CUA turn is compacted *during* the
  work, which is exactly when schema exemplars are most load-bearing —
  and the analysis treats compaction as between turns.
- `pendingIsUsable` never weighs the uncovered tail in tokens (Codex
  #3). One enormous steering message after a background summary and the
  adopted window is still unsendable.
- Rememberer clears the pending batch before `await extract`
  (`remember.ts:164-166`). Two overlapping batches can append out of
  chronological order; scored recall then prefers the later timestamp
  of an older extraction (Codex #6).
- Window cache is keyed by bare model name (`windowByModel` in
  `compaction.ts:96`). Two providers sharing `MiniMax-M3` share a
  window they may not share.

### Corrected P0 (Grok + Codex, reflected in docs/24 §5)

1. Summary client and profile resolved together; never adopt a
   dropped-entry marker because the cheaper-vendor call went to the
   wrong host.
2. Complete-request preflight: system + tools + history in the
   pressure estimate, calibrated from real `input_tokens` per
   provider/base-URL; detect the incompressible floor before dispatch.
3. Stop clipping summariser inputs at 400 chars; append mechanical
   anchors (paths, ids, spill pointers) outside the LLM; validate
   headings/size; feed the previous summary as an explicit update.
4. Token-validate a pending summary before adopting it.
5. Cut anchoring + keep the most recent successful call/result pair
   per active tool out of the summarised range (the MiniMax lesson).

Then, after there is something to observe: anti-thrash, Rememberer
serialization, measurement-driven prune of residual dupes/args,
ReadHistory audit (scopes, teammate reads, bounds), and a *pre*-summary
durable-state checkpoint if anything still only lives in the history.

### Disposition of this round

Accepted into docs/24 in place: §1 facts, §4 table cells about us, the
ahead/behind list, and the §5 ranking. Hermes/OpenClaw prose in §2–§3
left standing (spot-checked, not re-cited).

---

## Grok round 2 — attacking the corrected ranking

v2 of docs/24 absorbed Codex + Grok-1. This round does not re-litigate
v1's stale claims (`ReadHistory` exists, box class is stable, CJK
under-counts, overflow is 500/20k, `chooseRelevant` is turn-start only).
Those remain true. The job is: is the *corrected* ranking the damage
order, and what did Codex never see because it reviewed v1?

Citations are to `agentbox/` at the tree this session read.

### §1 of v2, still true

Assembly split, 400-entry backstop, pair repair, 60k / `window × (1−0.35)`
/ 20k tail (30% only after a known window; `AGENTBOX_COMPACT_AT_TOKENS`
freezes 60k/20k/320), 320-entry backstop, 75% background pass, 400-char
input clip, cheaper-profile client swap, `ReadHistory` advertised,
overflow 500 until ~20k chars reclaimed, durable re-read only after the
400-round cap, `chooseRelevant` at turn start and `recall()` on
continuation. All still match the code.

One omission, not a falsehood: `compactionUrgency` also fires background
at 75% of `maxEntries`, not only 75% of the token trigger
(`compaction.ts:669-670`).

### The ranking as absorbed, attacked

v2 P0 (docs/24 §5): (2) summary-provider routing → (3) complete-request
preflight → (4) token-validate pending → (5) mechanical anchors →
(6) cut anchoring + schema insurance, "after image prune", "prefer the
newest plain user message as the cut".

That order is named-absence plus one Grok-1 story that does not survive
the tree. Expected damage on *this* deployment (MiniMax-M3, docs/23) is
different, and item 6's *prescription* recreates the incident.

#### 1. FATAL to v2 behind #3 / P0 #6 — layer conflation (Grok-1 introduced; Codex never saw it)

Compaction, `chooseCutPoint`, and `keepTailTokens` operate on the
**transcript**. `storableResult` (`turn.ts:526-572`) already drops
images before anything is appended: a CUA result becomes ≤2,000
characters of text plus `N screenshot(s) were attached and shown at the
time`. Screenshots cannot fill the 20k tail. `pruneOldImages`
(`compaction.ts:490`, called from `turn.ts:1298` and overflow
`shedForRetry`) rewrites the **in-flight** `messages` array of the
current turn; it never walks JSONL.

v2 §4 behind #3 says a handful of 1,600-token screenshots fill 20k and
`pruneOldImages` then drops all but the newest, so recent `computer`
pairs are not protected as exemplars. That story is false. The 20k tail
of a CUA history is ~15–25 durable 2k-char results (2.5 chars/token),
not a handful of pictures. "Keep tool pairs *after image prune*" is the
wrong layer; schema insurance belongs in `chooseCutPoint` / window
assembly, not after prune.

What remains of the docs/23 hole, stated without the screenshot math:
pair-safety is still the only cut rule; a 400-round continuation
(`turn.ts:1192-1213`) re-compacts *during* the live task; token-budget
tails of fat text results can still crowd out the most recent
well-formed `computer` pair; the summary itself is a `role: "user"`
entry (`compaction.ts:412-428`) sitting where MiniMax looks for
examples.

#### 2. FATAL to P0 #6's prescription — it recreates docs/23

"Prefer the newest plain user message as the cut" is not Hermes's
"last user survives verbatim". It *summarises everything before that
user message*.

Compaction at ordinary turn start runs **before** the current
`turnText` is appended (`turn.ts:1043` then `1055-1060`), so "last
user" is not the live request. Worse: the 400-round continuation
appends `outcome.continueWith` as a user entry *then* calls
`compactHistory` (`turn.ts:1177-1192`). Under v2's rule the newest
plain user *is* that continuation prompt, and the cut summarises the
preceding four hundred rounds of `computer` calls — exactly the
docs/23 chain.

The item also mashes three Hermes guarantees into one sentence:
protected **head** (original task), protected **tail** (last user /
last assistant verbatim), and tool-exemplar retention (recent
successful call/result per active tool). They are not interchangeable.
A cut-at-last-user rule sacrifices the head and, on continuation, the
exemplars.

#### 3. P0 #2 is over-ranked for the production path; Codex named one of three sites

`CHEAPER_MODEL_FOR` is only `anthropic → claude-haiku-4-5`
(`provider.ts:536-541`). Live MiniMax has no cheaper-model entry; the
default summariser *is* the agent's own model. Wrong-host only happens
when `AGENTBOX_SUMMARY_PROVIDER` names another vendor. Real bug,
latent on this box, not this week's docs/23 vehicle.

Same client+model split in two other call sites Codex did not name:

- Rememberer is constructed with `client: this.client` (the agent
  client) and `provider: resolveSummaryProvider(this.provider)`
  (`orchestrator.ts:463-468`); `Rememberer.ask` then does
  `this.deps.client.messages.create({ model: this.deps.provider.model
  })` (`remember.ts:234-236`).
- `askCheaply` does the same (`orchestrator.ts:767-770`).

Fix the routing once, for all three, or the "cheaper profile" is still
a MiniMax request with an Anthropic model string the day someone sets
the env.

#### 4. P0 #3's observation point is wrong

`compactionUrgency` runs inside `compactHistory`, before the current
user message exists and before tools are attached (`turn.ts:1043`
then `1055`). Real `input_tokens` arrive after the stream
(`turn.ts:1488-1503`), and `noteContextWindow` stores only the window
size, keyed by bare model name — never last `prompt_tokens` for a
Hermes-style projection. Putting complete-request accounting only
inside `compactHistory` still cannot see this request's incompressible
floor. The preflight belongs at `runRounds` dispatch.

Codex correctly said there is no observation point for anti-thrash.
It then ranked a preflight that sits at the same too-early site.

#### 5. P0 #4 is real and incomplete — background summary never refreshes

`if (!pendingSummaries.has(summaryKey))` (`turn.ts:694`) keeps the
first 75%-band cut for the whole background window. `pendingIsUsable`
(`compaction.ts:675-690`) only rejects if the window *shrank* or
`activeLength - covers > DEFAULT_POLICY.maxEntries`. It does not
weigh the uncovered tail in tokens, and it does not require
`covers` to match the current `cut.index`. The module comment
(`compaction.ts:629-631`) claims a pending summary "is discarded if
the history has moved on"; the code does not.

Codex found the entry-count validation. It missed the freeze: tail
tokens can grow through the entire 75→100% band and still be adopted.

#### 6. Rememberer is stronger than Codex #6

Codex: overlapping batches can reverse chronology in the prompt.
The actual write path:

- Callers fire-and-forget (`void this.rememberer.record`,
  `orchestrator.ts:342, 640, 859`).
- `pending` is cleared *before* `await extract` (`remember.ts:164-166`).
- `parseExtraction` stamps `at` at parse time (`memory.ts:455`), i.e.
  when the slow call returns, not when the exchange happened.
- `dedupe` is file order: `byKey.set` later-in-file wins
  (`memory.ts:174-191`).

A slow stale extraction can **replace** a faster correction of the
same fact, not merely reorder it. `scoreOf` then treats the stale
line as younger. The episode path is the same shape: `extractions`
cleared before `condense` (`remember.ts:209-211`). Serialize *and*
stamp sequence before the model call.

### What Codex missed (v1 review, so these were invisible)

| Miss | Why Codex didn't see it |
| --- | --- |
| Screenshot-fills-`keepTail` / "after image prune" | Introduced by Grok-1 into v2; Codex reviewed v1 |
| P0 #6 cut-at-last-user recreates docs/23 on 400-round continuation | Same; v1 ranked cut anchoring 4th with a prune-text story |
| Rememberer + `askCheaply` share the summarise client bug | Codex named `summarise` (`turn.ts:623`) only |
| Preflight observation point is `runRounds` dispatch, not `compactHistory` | Named the missing observation, parked the fix at the same early site |
| Background summary never refreshed (`pendingSummaries.has`) | Named entry-count `pendingIsUsable`, not the freeze |
| Stale extraction *replaces* via `dedupe` later-wins + parse-time `at` | Named chronology in the prompt |
| `pendingIsUsable` vs its own comment (discard-on-move vs discard-on-shrink) | Not in v1's comparison frame |
| Summary `role: "user"` format contamination next to MiniMax imitation | Adjacent to docs/23, never named |
| `rebuildVolatile` cited at `turn.ts:906` does not exist | Low; leftover comment |

Hermes/OpenClaw §2–§3 still spot-checked only.

### Corrected P0 (round 2, by expected damage on this tree + docs/23)

1. ~~Entry triggers demoted to backstops~~ (shipped).
2. **Cut anchoring + schema insurance, specified at the transcript
   layer.** Keep recent successful call/result pairs for active tools
   in the window `chooseCutPoint` names. Do not cut at the newest
   plain user message — on continuation that *is* the schema-amnesia
   vehicle. Keep last user/assistant verbatim as a tail guarantee,
   separately from a protected head if we want one. Do not couple
   this to `pruneOldImages`. Treat summary-as-user-message format
   as part of the same MiniMax imitation surface.
3. **Mechanical summary anchors + stop clipping at 400 chars.** The
   live T5000-class hole; heading/size validation; previous summary
   as an explicit update.
4. **Token-validate *and refresh* pending summaries.**
   `estimateTokens([summary, …tail])` against current policy;
   coverage must match the current cut; drop the `has` freeze so a
   75% cut cannot be adopted at 99%.
5. **Complete-request preflight at `runRounds` dispatch.** System +
   tools + history + the message about to be sent; calibrate from
   real `input_tokens` per provider/base-URL; detect the
   incompressible floor before the request, not inside
   `compactHistory`.
6. **Summary-provider routing at all three call sites** (`summarise`,
   `Rememberer.ask`, `askCheaply`): resolve client and profile
   together, validate at startup. Latent on default MiniMax; P0 the
   day `AGENTBOX_SUMMARY_PROVIDER` points elsewhere.

P1: serialize Rememberer *and* sequence-stamp before the model call
(stale can replace, not just reorder); anti-thrash once dispatch
accounting exists; ReadHistory audit.

P2: measure post-`DURABLE_RESULT_CHARS` composition (dupes, argument
leaves — not screenshots); pre-compaction checkpoint; prefix-cache
audit; delete the `rebuildVolatile` comment.

### Disposition of round 2

Accepted into docs/24 in place: §4 behind #3 (drop the screenshot
story), the ahead/behind list, and the §5 ranking/prescriptions.
§1 left standing. Hermes/OpenClaw §2–§3 still not re-cited.
