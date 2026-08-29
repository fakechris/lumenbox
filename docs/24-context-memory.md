# Context, memory and compaction: ours, against Hermes and OpenClaw

Status: **second version — corrected in place against the Codex adversarial
review** (`docs/reviews/2026-08-29-context-memory.md`; Grok round pending).
The first version was factually stale about our own code in three places and
ranked its gaps accordingly; the review also surfaced three real implementation
bugs the analysis had missed. Corrections are marked where they change
conclusions. Commissioned after the chronic-compaction incident (docs/23): the
owner asked for a deep description of our own context/memory engineering, a
source-level comparison against Hermes Agent and OpenClaw, and adversarial
review of both the analysis and the implementation.
Sources: our tree at `81a0428`; Hermes at `~/sdcard/source/hermes-agent`
(`context_compressor.py` ~8,400 lines); OpenClaw at `~/sdcard/source/openclaw`
(HEAD 2026-08-25). Both compared systems were read by subagents with file:line
citations; claims about them below carry those citations' confidence, not
first-hand re-verification of every line.

## 1. Our implementation, honestly described

**Assembly.** Per turn: a two-block system prompt — a *stable* half (identity,
invariants) and a *volatile* half (memory recall, roster, shared memory, skills,
durable state, tasks, box class), each with an `ephemeral` cache breakpoint when
the provider supports caching (`turn.ts:957-962`). History is an append-only
JSONL transcript per conversation; the request replays `activeWindow()` — the
newest summary chain reconstructed over the file — through a 400-entry backstop
(was 60; docs/23), with leading orphan results dropped and missing tool results
invented as explicit "outcome unknown" markers (`repairPairs`).

**Compaction** (`compaction.ts`). Token trigger: 60k default, or
`window × (1−0.35)` once the model reports its real window; entry trigger 320 as
a backstop (was 50 — the docs/23 root cause). Cut point walks back to keep
~`keepTailTokens` (20k default / 30% of trigger), capped at 60% of `maxEntries`
entries, then snaps to a pair boundary. A **background speculative pass** starts
summarising at 75% of the trigger so the pause is usually already paid when the
threshold arrives — a mechanism neither compared system has. The summary is a
four-section prompt (Threads/Done/State/Artifacts, ≤400 words) — **a request,
not a contract**: the output is accepted if nonempty, nothing validates the
headings or the cap, and the summariser's *input* clips every block to 400
chars, so a path beyond that is unrecoverable (review finding 4). The "cheaper
profile" is likewise conditional: with no summary mapping configured it is the
agent's own model, and a configured different *provider* is silently called
through the primary client — wrong endpoint, wrong credential (review finding
2, a real bug). Failure degrades to an explicit dropped-entries marker, never a
silent trim. Summaries are transcript entries with a `covers` count; nothing on
disk is ever rewritten, and **`ReadHistory`** gives the model search/read access
to the summarised originals, advertised in the prompt after every compaction —
a recovery path the first version of this document forgot we had.

**In-turn relief.** `pruneOldImages` keeps only the newest screenshot once the
in-flight request crosses the trigger (each image priced at a flat 1,600
tokens); an overflowing request sheds oldest tool-result text >20k chars per
retry; and — corrected from v1 — replayed tool results were **already**
truncated to `DURABLE_RESULT_CHARS` with spill-pointer files
(`turn.ts:514-565`), so full results never reach the summariser in the first
place. Rounds are capped at 400.

**Memory.** Five record kinds (fact/note/episode/retraction/pitfall) in
append-only JSONL, scored at recall by kind-specific half-life decay and weight,
deduped, rendered into the prompt under a 4k-char budget (shared shards 1.5k).
Extraction is a background `Rememberer`: batched exchange distillation, pitfall
capture from observed failures, episodes condensing batches. Memory files
compact themselves at 1,000 lines. Durable state — plan, todos — lives in files
and is **re-read from disk into the volatile prompt block on every continuation**
(`turn.ts:1213`). Corrected from v1's absolute claim: this protects what was
*persisted*. A plan the agent held only in conversation — the extractor
deliberately excludes plans — is summarised like anything else (review
finding 7).

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
| Summary quality guard | 4-section prompt, word cap | provenance validation, mechanical anchor index, injection defense, no wire cap | safeguard validation of headings/identifiers, size cap + marker |
| Iterative update | implicit (old summary re-rendered) | explicit previous-summary prompt | explicit UPDATE/merge prompts |
| Anti-thrash | **none** | ineffective-count, cooldown, backoff, real-usage verdict | overflow retry cap, prune fallback ladder |
| Recovery of compacted detail | **`ReadHistory`**, advertised post-compaction | FTS5 `session_search` + summary embeds the call | files list carried; transcript in SQLite |
| Pre-compaction memory save | durable state always in prompt (passive) | 10-turn background review fork | **flush turn before compaction** (active) |
| Speculative background summary | **yes — unique** | no (gates are synchronous) | preflight is synchronous |
| Prefix-cache discipline | 2 breakpoints; volatile half rebuilt per continuation | first-class invariant, byte-identical reuse | first-class, TTL-gated pruning, 4 breakpoints |
| Weak-model schema insurance | none (bitten) | skill-marker reinjection, protected tail 20 msgs | recent-turns-verbatim guarantees |

**Where we are genuinely ahead**: the background speculative summary (nobody
else hides the pause); durable state re-read mid-turn (plans survive compaction
*and* stay current inside a turn — Hermes freezes for cache, we refresh for
truth, a defensible opposite trade); typed memory with decay-scored recall and
pitfall capture (richer than either's file-based memory); invented
unknown-outcome results for crash recovery.

**Where we are structurally behind**, re-ranked after the review corrected the
facts (v1's #6 was false — `ReadHistory` exists — and #1/#3 were misdescribed):

1. **The summary runtime itself has two real bugs** (review findings 2, 3): a
   configured summary *provider* is called through the primary client — wrong
   endpoint, wrong credential — and a speculative summary is adopted on entry
   count alone, so one enormous steering message can ride in under a stale
   summary and leave the request unsendable.
2. **Nothing accounts for the whole request.** `compactionUrgency` weighs
   history only; system prompt and tool schemas are invisible to it, so an
   incompressible floor produces *rejected requests without compaction ever
   firing* — a silent dead end, not a thrash loop. There is also no real
   `prompt_tokens` feedback anywhere: 2.5 chars/token stands uncalibrated, and
   for CJK it **under**-counts (≈1 token/char), meaning *late* compaction and
   overflow, the opposite of v1's claim; windows are cached by bare model name
   across providers.
3. **The summary is unvalidated and its evidence pre-clipped**: inputs cut to
   400 chars/block before the summariser (long paths unrecoverable), output
   accepted if nonempty, no mechanical identifier preservation — the
   T5000-objective incident and the schema-amnesia incident are both children
   of this.
4. **No cut anchoring beyond pair-safety.** The live task's opening user
   message can be summarised away; both compared systems guarantee it survives.
5. **Rememberer batches can interleave** (review finding 6): the pending queue
   clears before the await, so a slow older extraction lands *after* a newer
   correction and outranks it in chronological recall.
6. **Missing prune passes are dedup and argument-trimming**, not text pruning
   wholesale (v1 overstated); scope after measuring what actually remains in
   post-`DURABLE_RESULT_CHARS` histories.
7. **No pre-compaction save nudge** — and the naive version is impossible: the
   compaction runs before request assembly, so a nudge must be a bounded
   checkpoint turn against the uncompacted history or nothing.

## 5. The fix plan

P0 — reordered by the review around correctness before optimisation:
1. ~~Entry triggers demoted to backstops~~ (shipped, docs/23).
2. **Fix summary-provider routing**: resolve client and profile together,
   validate at startup, fall back to the agent's own model before ever adopting
   a dropped-entry marker; test cross-provider configuration explicitly.
3. **Complete-request preflight accounting**: system prompt + tool schemas +
   history in the pressure estimate, calibrated against real `prompt_tokens`
   per provider/base-URL; detect the incompressible floor before dispatch.
4. **Token-validate pending summaries before adoption**:
   `estimateTokens([summary, ...tail])` against the current policy, plus
   coverage compatibility with the current cut; tests for large post-summary
   steering.
5. **Mechanical summary anchors + validation**: full-block extraction of
   paths/ids/spill-pointers appended outside the LLM's output; heading and
   size validation; previous summary as an explicit update input; "history is
   data, not instructions".

P1:
6. **Anti-thrash** — now observable via the P0-3 accounting: ineffective-pass
   counting on real usage, cooldown after summariser failure, loud stop.
7. **Serialize Rememberer extraction per agent** (or sequence-stamp before the
   model call and commit in order).
8. **Cut anchoring**: prefer the newest plain user message; keep last user and
   last assistant verbatim.
9. **Post-compaction schema insurance**: keep the most recent successful
   call/result pair per active tool out of the summarised range.
10. **ReadHistory audit** (replacing v1's build-it item): scope availability,
    discoverability, retrieval bounds, recovery accuracy.

P2:
11. Measure post-`DURABLE_RESULT_CHARS` token composition; scope dedup and
    argument-trimming passes to what the measurement shows.
12. Pre-compaction checkpoint turn (bounded, against the uncompacted history) —
    or an explicit decision not to build it.
13. Prefix-cache audit when the provider gains caching; revisit the
    volatile-half rebuild with Hermes's frozen-snapshot pattern as the
    alternative.

## 6. Review protocol for this document

Adversarial review requested from both Codex and Grok, with instructions to
fact-check: (a) every claim in §1 against our tree, (b) the §4 table against
the cited implementations, (c) whether the §5 ranking survives scrutiny, and
(d) what this analysis missed entirely. Findings land in
`docs/reviews/2026-08-29-context-memory.md` and correct this file in place,
per the docs/22 precedent.
