# Why the agent kept compacting, and what long-horizon systems do instead

Status: **investigation closed, root cause fixed 2026-08-29; refinements listed.**
Prompted by an afternoon in which one agent compacted three times during a single
piece of work and, in the middle of it, forgot how to call its own `computer` tool.

## 1. The evidence

Every compaction that day, from the log, verbatim triggers:

```
Ada: history is 62 entries, over the 50 entry trigger … about 12085 tokens became 826
Bob: history is 74 entries, over the 50 entry trigger … about 5689 tokens became 676
Bob: history is 62 entries, over the 50 entry trigger … about 5292 tokens became 732
```

Not one fired on tokens. The token trigger is 60,000 by default and higher when the
model reports its real window; these histories were **five to twelve thousand
tokens** — under a tenth of the threshold — and were summarised anyway, every time,
because of a count.

## 2. The root cause, as a chain

1. `turn.ts` replays at most `HISTORY_LIMIT = 60` transcript entries into a new
   turn, silently dropping the rest.
2. To keep that silent drop from ever happening, compaction's policy carried
   `maxEntries: 50` — compact *before* the backstop bites. Sound reasoning, wrong
   constant.
3. A computer-use turn writes **two entries per round** (the assistant's tool
   calls, the user-role results), and a turn may run up to 400 rounds. One
   meeting-join turn produced 30–60 entries by itself.
4. So the entry trigger fired after nearly every CUA turn, at trivial token
   counts. The kept tail is capped at 60% of `maxEntries` (30 entries), which the
   *next* CUA turn immediately blew past again: **chronic compaction, by
   construction.**
5. Collateral, and the part that cost real minutes: each compaction summarised
   the earlier half of the *current task* — including the model's own recent,
   correctly-formatted `computer` calls. MiniMax-M3 follows tool schemas largely
   by imitating its own in-context examples; with them summarised away it spent
   ten minutes guessing parameter shapes (`{actions:{item:…}}`, `{}`,
   single-object) while a meeting waited.

The deeper error is conceptual and worth stating so it is not rebuilt: **entries
were treated as the scarce resource. The scarce resource is tokens.** The same
system happily carries 400 rounds *inside* a turn — with in-turn image pruning
managing the real weight — and then held the *replay* of finished turns to 60
entries. The two limits described different worlds.

## 3. The fix (shipped)

- `HISTORY_LIMIT` 60 → 400 (`AGENTBOX_HISTORY_LIMIT`), a backstop against entry
  floods, no longer a budget.
- `maxEntries` 50 → 320 (`AGENTBOX_COMPACT_MAX_ENTRIES`), still under the
  backstop for the original reason, no longer reachable by ordinary work.
- The token trigger — 60k default, window-derived when the model reports one —
  now governs in practice, which is what it was always meant to do.

Expected effect: compaction returns to being an event that happens when a
conversation is genuinely large, not per-turn punctuation. The MiniMax schema
loss becomes correspondingly rare (and is tracked as its own defect below).

## 4. What the systems that do this well actually do

Surveyed 2026-08-29; sources at the end.

- **Trigger on tokens as a fraction of the real window, never on message count.**
  Claude Code auto-compacts when ~13k tokens *remain* (about 92% of a 200k
  window used); Anthropic's server-side compaction and `clear_tool_uses` context
  editing are both configured by input-token thresholds (e.g. trigger at 100k).
  Nobody counts messages. Our token machinery already matched this; the count
  trigger was the outlier.
- **Structure-preserving edits before narrative summaries.** Anthropic's
  `clear_tool_uses_20250919` clears old *tool results* (optionally calls),
  replacing each with a placeholder, keeping the N most recent intact — the
  conversation's shape survives, recent exemplars survive, and reported gains are
  +29% on agentic benchmarks. Our `pruneOldImages` is exactly this pattern for
  screenshots; extending it to old *text* tool results would be the natural next
  step and is cheaper than summarising.
- **Externalise durable state so compaction is safe.** Manus treats the
  filesystem as "the ultimate context" and restores from files, not from the
  window; Anthropic's memory tool warns the model *before* clearing so it saves
  what matters. We already do much of this (progress.md, todos, the task board) —
  which is why compaction here is survivable at all.
- **Recitation over retention.** Manus rewrites `todo.md` at the *end* of the
  context each step, pulling the plan into recent attention instead of trusting
  the middle of a long window. Our closing-message rule and SetTodos are cousins;
  worth remembering as the alternative to keeping everything.
- **Keep errors in context.** Manus deliberately leaves failed actions visible —
  the model updates its priors. Our summary prompt already demands failures be
  recorded; the principle extends to *not* summarising away the recent failed
  attempts of a live task.
- **Protect the prefix.** Manus's KV-cache rule: stable prompt prefix,
  append-only context, mask tools rather than remove them — a single changed
  token invalidates the cache for everything after. Moot on MiniMax (no prompt
  caching, see the roadmap's prefix-audit note) but binding the day the provider
  changes.

## 5. Refinements worth doing, in order

1. **Clear old text tool-results before summarising** (the `clear_tool_uses`
   shape): between turns, replace tool results older than the last N with
   one-line placeholders. Reclaims most CUA bulk with no model call, no summary
   risk, and no loss of the call structure the schema-imitation depends on.
2. **Cut at task boundaries.** `chooseCutPoint` may cut after any results entry;
   preferring the last plain user message keeps a live task's history intact and
   summarises only *finished* exchanges — directly preventing the
   schema-amnesia failure even when compaction does fire.
3. **The MiniMax schema-loss defect in its own right**: after any compaction, a
   weak model should still see one well-formed call per active tool. Options:
   keep the most recent successful call/result pair per tool out of the
   summarised range, or have the summary carry a fixed "tool call shapes" line.
   Rare now; cheap insurance when it lands with (2).
4. **Warn-then-save, when a memory tool exists**: Anthropic's pattern of telling
   the model clearing is imminent so it writes to memory first — ours would be a
   nudge to update progress.md before adopting a summary.

## Sources

[Manus: Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) ·
[Anthropic: context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) ·
[Anthropic: compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) ·
[Anthropic: memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) ·
[Claude Cookbook: context engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) ·
[Claude Code context buffer analysis](https://claudefa.st/blog/guide/mechanics/context-buffer-management)
