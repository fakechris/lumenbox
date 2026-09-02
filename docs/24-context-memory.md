# Context, memory and compaction: ours, against Hermes and OpenClaw

Status: **third version — ranking re-attacked after absorbing Codex + Grok-1**
(`docs/reviews/2026-08-29-context-memory.md`; Codex, Grok round 1, Grok round
2). v1 was factually stale about our own code; v2 absorbed those corrections
and then introduced a layer conflation (screenshots filling `keepTailTokens`)
that Grok-2 reverted. Corrections are marked where they change conclusions.
Commissioned after the chronic-compaction incident (docs/23).
Sources: our tree at `81a0428`; Hermes at `~/sdcard/source/hermes-agent`
(`context_compressor.py` ~8,400 lines); OpenClaw at `~/sdcard/source/openclaw`
(HEAD 2026-08-25). Both compared systems were read by subagents with file:line
citations; claims about them below carry those citations' confidence, not
first-hand re-verification of every line.

## 1. Our implementation, honestly described

**Assembly.** Per turn: a two-block system prompt — a *stable* half (identity,
box including its class, invariants) and a *volatile* half (plan/todos, tasks,
chat-files, memory recall, skills, the "earlier history is still there" block,
shared memory, roster, critical recap). Box class is stable, not volatile
(`prompt.ts` `STABLE_SECTIONS` / `VOLATILE_SECTIONS`). Each half gets an
`ephemeral` cache breakpoint when the provider supports caching
(`turn.ts:957-962`). History is an append-only JSONL transcript per
conversation; the request reconstructs `activeWindow()` — the newest summary
chain over the file — then slices to a 400-entry backstop (was 60; docs/23),
keeping a leading summary if the slice would drop it. Leading orphan results
are dropped; missing tool results are invented as explicit "outcome unknown"
markers (`repairPairs`).

**Compaction** (`compaction.ts`). Token trigger: 60k default, or
`window × (1−0.35)` once the model reports its real window; entry trigger 320 as
a backstop (was 50 — the docs/23 root cause). Cut point walks back to keep
~`keepTailTokens` (20k default; 30% of trigger only once a real window is
known — an explicit `AGENTBOX_COMPACT_AT_TOKENS` freezes 60k/20k/320 and
ignores the window), capped at 60% of `maxEntries` entries, then snaps to a
pair boundary. A **background speculative pass** starts summarising at 75% of
the trigger (and at 75% of `maxEntries`) so the pause is usually already paid
when the threshold arrives — off-thread LLM summary before the trigger; the
first cut in that band is frozen until adopted or the window shrinks
(`pendingSummaries.has`, review round 2). Hermes's "speculative" is a
display-token preflight seed, OpenClaw preflight is synchronous. The summary is a
four-section prompt (Threads/Done/State/Artifacts, ≤400 words) — **a request,
not a contract**: the output is accepted if nonempty, nothing validates the
headings or the cap, and the summariser's *input* clips every block to 400
chars, so a path beyond that is unrecoverable (review finding 4). The "cheaper
profile" is likewise conditional: with no summary mapping configured it is the
agent's own model (`CHEAPER_MODEL_FOR` lists only `anthropic`), and a
configured different *provider* is silently called through the primary client
at three sites — `summarise`, `Rememberer.ask`, `askCheaply` — wrong endpoint,
wrong credential (Codex finding 2, widened in Grok round 2). Failure degrades to an explicit dropped-entries marker, never a
silent trim. Summaries are transcript entries with a `covers` count; nothing on
disk is ever rewritten, and **`ReadHistory`** gives the model search/read access
to the summarised originals, advertised in the prompt after every compaction —
a recovery path the first version of this document forgot we had.

**In-turn relief.** `pruneOldImages` keeps only the newest screenshot once the
in-flight request crosses the trigger (each image priced at a flat 1,600
tokens). It rewrites the live `messages` array; it does not walk JSONL. On
provider overflow, oldest tool-result text is cut to 500 characters until about
20k characters have been reclaimed — not a per-result 20k gate. Replayed tool
results were **already** truncated to `DURABLE_RESULT_CHARS` (2,000) with
spill-pointer files, and **images stripped** (`turn.ts:526-572`), so screenshots
never reach the summariser or the `keepTailTokens` budget. Rounds are capped at 400; hitting that
cap re-compacts from disk and rebuilds the volatile prompt before continuing
(`turn.ts:1192-1213`) — a second compaction site, mid-task.

**Memory.** Five record kinds (fact/note/episode/retraction/pitfall) in
append-only JSONL, scored at recall by kind-specific half-life decay and weight,
deduped, rendered into the prompt under a 4k-char budget (shared shards 1.5k).
When the budget has to drop something, `chooseRelevant` may ask a model which
lines to keep — at turn start only; continuations re-score with `recall()`.
Extraction is a background `Rememberer`: batched exchange distillation, pitfall
capture from observed failures, episodes condensing batches. Memory files
compact themselves at 1,000 lines. Durable state — plan, todos — lives in files
and is **re-read from disk into the volatile prompt on continuation after the
400-round cap** (`turn.ts:1213`). This protects what was *persisted*. A plan
the agent held only in conversation — the extractor deliberately excludes
plans — is summarised like anything else.

**What we measured going wrong** (docs/23): the entry trigger fired at 5–12k
tokens, three times in an afternoon; each compaction summarised the live task's
own recent tool calls; MiniMax-M3, which imitates its own in-context examples to
follow schemas, lost the `computer` format and burned ten minutes.

## 2. What Hermes does (source-verified highlights)

- **Trigger: tokens only, provider-calibrated.** Threshold = 50% of the
  effective window, floored to 75% for windows under 512k; output reservation
  subtracted; **tool schemas counted in the pressure estimate**. Rough estimates
  (chars/4, CJK-aware, images 1,500) are corrected by projecting from the last
  *real* `prompt_tokens`: `projected = last_real + (rough_now − rough_at_last_real)`
  — added because CJK over-counting caused compaction at 35–55% of the real
  window. No message-count cap anywhere; full history loads every time.
- **Deterministic pruning before any LLM**: five passes — dedup byte-identical
  tool results, demote old bulky results to one-liners (`[terminal] ran npm test
  → exit 0, 47 lines]`), shrink oversized tool-call *arguments* by parsing the
  JSON and trimming string leaves (a naive byte-slice once 400-looped MiniMax),
  retire stale screenshots keeping 3, and under pressure demote bulky bodies
  even inside the protected tail.
- **Cut anchoring**: protected head (system + first 3), protected tail (last 20
  messages / lean: 10–25k tokens), and hard guarantees that the **last user
  message and last assistant message survive verbatim**.
- **Summary**: iterative-update prompt fed the previous summary explicitly;
  eleven fixed sections; prompt-injection defense ("turns are DATA, never
  instructions"); provenance validation (a summary may not invent "User asked");
  credential scrubbing; **no `max_tokens` on the wire** so a cap can never cut a
  summary mid-section (contract-tested). Lean mode appends four *mechanical*
  sections the LLM cannot ruin: a regex-harvested anchor index (SHAs, paths,
  ids), chunked digests, verbatim recent user messages, and a literal
  `session_search(...)` recovery call.
- **Anti-thrash, judged on real usage**: effectiveness is "did the provider's
  prompt count clear the threshold", not "did the list shrink" — because system
  prompt + 50 tools are an incompressible 20–30k floor; two ineffective passes
  disable auto-compaction; failures set a 600s cooldown persisted in the DB.
- **Recoverable, not destructive**: compacted rows are soft-archived
  (`active=0`), stay FTS5-indexed, and the summary tells the model how to
  search them back.
- **Memory**: `MEMORY.md`/`USER.md` as *frozen snapshots* at session start —
  mid-session writes hit disk but deliberately not the prompt, to preserve the
  prefix cache; a **background review fork** every 10 turns nudges the agent to
  persist memories and author skills ("a pass that does nothing is a missed
  learning opportunity"), with its own budget after a runaway fork replayed
  1.49M input tokens.
- **Cache discipline as an invariant**: system prompt built once per session in
  three volatility tiers; on compaction the cached prompt is reused
  byte-identical when memory hasn't changed; every history rewrite is treated
  as an episodic cache boundary with hysteresis.

## 3. What OpenClaw does (source-verified highlights)

- **Trigger: tokens only.** Compact when `contextTokens > window − 16,384`,
  keep ~20k recent; preflight projection before dispatch; reactive compaction
  on provider overflow errors (≤3 attempts); a transcript-size byte fuse.
  Hybrid counting: last real usage + char estimate (4/char, CJK-aware, images
  2,000) for the uncounted tail.
- **Staged summarization with a quality guard**: chunked map-reduce (40% of
  window per chunk) with explicit merge instructions; messages over half the
  window are dropped from the summary *with a note*; `safeguard` mode validates
  that required headings, pending asks and **exact identifiers** survived the
  capped (16k chars) summary, with bounded corrective retries. File-read/modify
  lists are extracted mechanically and carried across compactions.
- **Pre-compaction memory flush, on by default**: when compaction approaches,
  the agent runs one bounded turn against the prompt "store durable memories in
  `memory/YYYY-MM-DD.md` … if nothing to store, reply [SILENT]", at most once
  per cycle; after compaction, designated AGENTS.md sections ("Session Startup",
  "Red Lines") are re-injected. Memory = curated `MEMORY.md` + append-only
  daily notes, promoted by a separate process.
- **Tool-result pruning is TTL-gated for cache stability**: only after the
  provider cache's TTL has expired, only above 30% usage; soft-trim keeps
  first/last 1,500 chars, hard-clear above 50% usage; the last three assistant
  turns are never touched; batch eviction (not sliding-window) keeps prefixes
  stable; up to 4 `cache_control` breakpoints placed to anchor on stable turns.
- Turn-prefix summaries when a cut lands mid-turn; pair integrity always;
  server-side compaction delegated to providers that own it.

## 4. The comparison, dimension by dimension

| Dimension | Ours | Hermes | OpenClaw |
| --- | --- | --- | --- |
| Trigger | tokens (est.) + entry backstop | tokens, real-usage-calibrated | tokens, real+est hybrid |
| Counts system+tools in pressure | **no** | yes | partially (usage covers it) |
| Real `prompt_tokens` feedback | window size only | authoritative, projected | authoritative + tail estimate |
| Deterministic prune before LLM | replayed results cut to `DURABLE_RESULT_CHARS` + image prune; **no dedup, no argument trimming** | 5 passes incl. dedup, args | TTL soft-trim/hard-clear |
| Cut anchoring | pair-safe only | pair-safe + last user/assistant verbatim + protected head/tail | pair-safe + turn-prefix summary |
| Summary quality guard | 4-section *prompt* (unvalidated); inputs clipped to 400 chars/block | provenance validation, mechanical anchor index, injection defense, no wire cap | safeguard validation of headings/identifiers, size cap + marker |
| Iterative update | implicit (old summary re-rendered) | explicit previous-summary prompt | explicit UPDATE/merge prompts |
| Anti-thrash | **none** | ineffective-count, cooldown, backoff, real-usage verdict | overflow retry cap, prune fallback ladder |
| Recovery of compacted detail | **`ReadHistory`**, advertised post-compaction | FTS5 `session_search` + summary embeds the call | files list carried; transcript in SQLite |
| Pre-compaction memory save | persisted plan/todos re-read on 400-round continuation (passive; unwritten plans die) | 10-turn background review fork | **flush turn before compaction** (active) |
| Speculative background summary | **yes — unique as off-thread LLM summary** | display-token preflight seed, not a summary; gates synchronous | preflight is synchronous |
| Prefix-cache discipline | 2 breakpoints; volatile half rebuilt on 400-round continuation | first-class invariant, byte-identical reuse | first-class, TTL-gated pruning, 4 breakpoints |
| Weak-model schema insurance | none (bitten) | skill-marker reinjection, protected tail 20 msgs | recent-turns-verbatim guarantees |

**Where we are genuinely ahead**: the background speculative LLM summary
(Hermes/OpenClaw do not hide a summariser pause this way); typed memory with
decay-scored recall and pitfall capture (richer than either's file-based
memory); invented unknown-outcome results for crash recovery; `ReadHistory` as
a first-class tool advertised after compaction. Persisted plan/todos re-read
on a 400-round continuation is a real opposite of Hermes's frozen MEMORY.md —
not "every round", and not a defence of unwritten plans.

**Where we are structurally behind**, re-ranked after Grok round 2 attacked
the v2 order (v1's #6 was false — `ReadHistory` exists; v2's behind #3
screenshot story was also false — images never reach the transcript):

1. **No cut anchoring, and the tail is not a schema tail.** Pair-safety is the
   only cut rule. The live task's opening user message can be summarised away.
   A 400-round continuation (`turn.ts:1192-1213`) re-compacts *during* the
   work. `keepTailTokens` is a token budget over **text** — `storableResult`
   already strips images, so a handful of 1,600-token screenshots cannot fill
   20k; ~15–25 durable 2k-char results can, and those may not be `computer`
   pairs. v2 claimed prune-after-screenshot was the MiniMax hole; prune
   rewrites in-flight `messages` only. **This is the remaining docs/23 hole.**
   Cutting at the newest plain user message would *recreate* it: continuation
   appends a user prompt and then compactHistory, so that rule summarises the
   preceding CUA rounds. Hermes keeps last-user / last-assistant *verbatim in
   the tail*, which is a different guarantee from "cut here".
2. **The summary is unvalidated and its evidence pre-clipped**: inputs cut to
   400 chars/block before the summariser (long paths unrecoverable), output
   accepted if nonempty, no mechanical identifier preservation — the
   T5000-objective incident is a child of this. Schema-amnesia is a child of
   (1), not of heading validation. The summary is also a `role: "user"`
   entry, so MiniMax's imitation surface includes a structured user block
   where recent tool pairs used to be.
3. **A speculative summary is frozen at the first 75% cut and adopted on
   entry count alone.** `pendingSummaries.has` never refreshes; `pendingIsUsable`
   does not weigh the uncovered tail in tokens and does not require `covers`
   to match the current cut (the module comment claims discard-if-moved-on;
   the code discards on shrink or entry overflow). One enormous steering
   message, or a band of CUA rounds, can ride in under a stale summary.
4. **Nothing accounts for the whole request, and the existing counter is
   too early to.** `compactionUrgency` weighs history only, before the current
   user message and tools exist. System prompt and tool schemas are invisible,
   so an incompressible floor produces *rejected requests without compaction
   ever firing* — a silent dead end, not a thrash loop. Real `input_tokens`
   arrive after the stream (`turn.ts:1488-1503`); `noteContextWindow` stores
   only window size, keyed by bare model name. 2.5 chars/token stands
   uncalibrated, and for CJK it **under**-counts (≈1 token/char) → *late*
   compaction, the opposite of v1's claim. A preflight that stays inside
   `compactHistory` still cannot see this request's floor.
5. **A configured summary *provider* is called through the primary client**
   — wrong endpoint, wrong credential — in *three* places, not one: `summarise`
   (`turn.ts:623-628`), `Rememberer.ask` (`remember.ts:234-236` via
   `orchestrator.ts:463-468`), and `askCheaply` (`orchestrator.ts:767-770`).
   Latent on default MiniMax (`CHEAPER_MODEL_FOR` has only `anthropic`); live
   the moment `AGENTBOX_SUMMARY_PROVIDER` names another vendor.
6. **Rememberer batches can replace a correction, not just reorder it.**
   Fire-and-forget `void rememberer.record`; pending queue clears before the
   await; `at` is parse time; `dedupe` later-in-file wins. A slow stale
   extraction of the same fact outranks *and replaces* a faster correction.
   Episode path is the same shape.
7. **Missing prune passes are dedup and argument-trimming**, not text pruning
   wholesale and not screenshot accounting (v1 and v2 both overstated, in
   opposite directions); scope after measuring what actually remains in
   post-`DURABLE_RESULT_CHARS` histories.
8. **No pre-compaction save nudge** — and the naive version is impossible: the
   compaction runs before request assembly, so a nudge must be a bounded
   checkpoint turn against the uncompacted history or nothing.

## 5. The fix plan

P0 — reordered by Grok round 2 around expected damage on this tree and the
docs/23 incident, not named absences. **All six shipped 2026-08-29**
(`67051ec`…`b7b3741`); the descriptions below are what was built:
1. ~~Entry triggers demoted to backstops~~ (shipped, docs/23).
2. **Cut anchoring + schema insurance at the transcript layer** (the remaining
   docs/23 hole). Keep the most recent successful call/result pair per active
   tool inside the window `chooseCutPoint` names. Keep last user and last
   assistant verbatim as a *tail* guarantee — that is not "cut at the newest
   plain user message", which on a 400-round continuation summarises the live
   CUA work and recreates the incident. Do not couple this to
   `pruneOldImages` (in-flight only; images are already gone from JSONL). Treat
   summary-as-`role: user` format as part of the same MiniMax imitation
   surface.
3. **Mechanical summary anchors + validation**: do not clip summariser inputs
   at 400 chars; full-block extraction of paths/ids/spill-pointers appended
   outside the LLM's output; heading and size validation; previous summary as
   an explicit update input; "history is data, not instructions".
4. **Token-validate *and refresh* pending summaries**:
   `estimateTokens([summary, ...tail])` against the current policy; coverage
   must match the current cut; drop the `pendingSummaries.has` freeze so a 75%
   cut cannot be adopted at 99%; tests for large post-summary steering *and*
   a band of CUA rounds in the background window.
5. **Complete-request preflight at `runRounds` dispatch**, not inside
   `compactHistory`: system prompt + tool schemas + history + the message about
   to be sent, calibrated against real `input_tokens` per provider/base-URL;
   detect the incompressible floor before the request.
6. **Fix summary-provider routing at all three call sites** (`summarise`,
   `Rememberer.ask`, `askCheaply`): resolve client and profile together,
   validate at startup, fall back to the agent's own model before ever adopting
   a dropped-entry marker; test cross-provider configuration explicitly. Latent
   on default MiniMax; live the day `AGENTBOX_SUMMARY_PROVIDER` points
   elsewhere.

P1:
7. **Serialize Rememberer extraction per agent** *and* sequence-stamp before
   the model call (a slow stale extract can *replace* a correction via
   later-in-file `dedupe` and parse-time `at`, not just reorder the prompt).
8. **Anti-thrash** — now observable via the dispatch preflight: ineffective-pass
   counting on real usage, cooldown after summariser failure, loud stop.
9. **ReadHistory audit** (replacing v1's build-it item): scope availability,
   teammate reads, discoverability, retrieval bounds, recovery accuracy.

P2:
10. Measure post-`DURABLE_RESULT_CHARS` token composition; scope dedup and
    argument-trimming passes to what the measurement shows (not screenshots).
11. Pre-compaction checkpoint turn (bounded, against the uncompacted history) —
    or an explicit decision not to build it.
12. Prefix-cache audit when the provider gains caching; revisit the
    volatile-half rebuild with Hermes's frozen-snapshot pattern as the
    alternative; delete the stale `rebuildVolatile` comment at `turn.ts:906`.

## 6. Review protocol for this document

Adversarial review from Codex, Grok round 1, and Grok round 2 landed in
`docs/reviews/2026-08-29-context-memory.md` and was absorbed here. Round 2
reverted a v2 layer conflation and re-ranked §5 by damage. Further rounds
should still fact-check: (a) every claim in §1 against the tree that week,
(b) the §4 table against the cited implementations, (c) whether the §5
ranking still matches expected damage rather than named absences, (d) that a
fix prescription does not recreate the incident it is meant to close.

## 7. Update, 2026-09-02

Three of the fixes above shipped, and one measured fact changed the plan:

- **Memory as files** (§5 item on grep-ability): the live view is mirrored into the box at
  `~/work/memory/<name>/profile.md` + `log/` on every change (docs/05 §8). The prompt's memory
  section names the path. Ada's "no persistent memory files" answer is now wrong in the right
  direction.
- **Selection survives continuation** (audit 2026-09-01 #6): a turn's model-chosen memory
  selection is carried into every continuation instead of being replaced by a plain score-based
  recall. The memory block is therefore byte-stable within a turn, which is what MiniMax's
  implicit prefix cache needs. The test proves the old code lost it.
- **Bounded index** (audit #4): descriptions are cut at 400 characters with the author told, and
  the skills index stops at 12k characters naming what it left out.
- **Measured**: Bob's system prompt plus 31 tool descriptions is ≈25.6k tokens; a whole request
  ≈55k. The next cut is the tool descriptions, not memory.
