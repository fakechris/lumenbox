# External audit, 2026-09-01: seven findings, verified one at a time

An outside review of memory, skills, scheduling and prompt assembly, delivered
as seven CONFIRMED findings with file:line evidence. Every one was reproduced
against the source before anything was changed — the house rule, and it earned
its keep again: one finding was partly wrong, and two were regressions
introduced by that same day's work.

## Verdicts

| # | Claim | Verdict | Outcome |
| --- | --- | --- | --- |
| 1 | caller/principal is agent-level state that leaks into scheduled and woken turns | **Confirmed** | Fixed: cleared when a turn has no caller |
| 2 | a scheduled skill is a cross-scope dispatch channel via `agent:` | **Confirmed** | Mitigated: `runAs` must resolve to the default agent; real fix needs provenance |
| 3 | Recall resurrects retracted facts and truncates two tiers in the wrong order | **Confirmed** | Fixed: reads the deduped live view, sorts by time before cutting |
| 4 | an unbounded skill description is an incompressible context DoS | **Confirmed, open** | Recorded below; not fixed today |
| 5 | SkillCache's concurrency and partial-failure states are wrong | **Confirmed** (regression from that morning) | Fixed: join the in-flight read first, arm the TTL on completion |
| 6 | query-aware memory applies only to the first turn's own tier | **Confirmed, open** | Recorded below; the comment and the behaviour disagree |
| 7 | the CJK dedupe fix only fixed lexical recall | **Partly right** | Claim corrected; behaviour pinned, similarity merging refused with reasons |

## The two that were mine, from the same day

**#5** — I had changed the skill cache that morning so a *failed* read arms the
TTL (a box that is down should not be re-listed every turn). I armed it at the
start of the read, which let a concurrent first caller pass the freshness check
and receive the still-empty cache: two callers, one refresh, two answers, and
the second was an agent told it had no skills. Joining the in-flight read before
the freshness check, and arming on completion, satisfies both requirements.

**#7** — I wrote that Chinese rephrasings "finally collide". They do not.
Bigrams gave the two phrasings shared tokens, which fixed *lexical recall* and
therefore the extractor's already-known list — paraphrase is suppressed at the
write path, which is real value — but `dedupe()` is exact-key and stays that way
in every language. Merging on similarity was considered and refused: at a
threshold low enough to merge those two Chinese sentences, "port is 8080" and
"port is 9090" merge too, and losing a fact is worse than repeating one. The
test now asserts both halves, including the one that does not work.

## The one that needed a judgement call

**#2** is the only finding that is a security boundary rather than a defect. A
skill file is ordinary content in the box, writable by any agent holding
`write_file` or `bash`; `agent:` in its frontmatter was taken as authority; and
a scheduled run with no `deliver:` executes in the main conversation, where the
writing agent's chat scope no longer constrains the tool set. That is privilege
escalation with a one-minute clock available to it.

Nothing else *in the file* can gate it. `owner` and `authored_by` are
frontmatter too, so an attacker writes whatever the rule asks for — which is why
the mitigation is blunt: a schedule runs as this installation's default agent,
and a request for anyone else is refused out loud. The live installation's one
scheduled skill names the default agent, so nothing legitimate broke.

The real fix is provenance the filesystem does not carry: the host recording who
wrote a skill, or scheduled skills living in host-owned state rather than in the
box. That is a design change under docs/13, not a patch, and it is the item to
pick up before multi-user.

## Still open, with what each would cost

**#4 — skill-index DoS.** `description` has no length cap, the loader walks every
directory, and the renderer puts every visible skill's name, full description and
helpers into the system prompt. A 300,000-character description was accepted and
produced a 301,610-character prompt; the request path warns about an oversized
floor and then sends it, and overflow shedding can only drop conversation
messages, never skills. One bad global skill degrades every agent's every turn.
Fix: a per-description cap at parse time and a total index budget with the
overflow named — small, and it belongs with the shedding ladder so the floor has
something to give.

**#6 — query-aware memory.** The initial assembly selects the agent's own
memories against the request; shared memory is always score-based, and a
continuation rebuilds the volatile block with a plain `recall()`, discarding the
selection. The comment says memory "is not re-selected here", which reads as
"kept" and means "dropped". Fix: carry the selection into the continuation, or
change the comment to match — but not leave them disagreeing.
