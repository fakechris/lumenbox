# Ideas taken from outside reading

A running record of things worth building that came from somewhere other than this
codebase. Kept separate from [the roadmap](11-roadmap.md) so that ranked, committed work
does not fill up with things nobody has decided on yet. An entry graduates to the roadmap
when it has been argued for; until then it sits here with its source and, where possible,
the measurement that says whether we have the problem it describes.

---

## Conversation as knowledge

Source: *Turning conversation into knowledge: how Slack builds human-agent teams*, an
interview with Jaime DeLanghe (Slack CPO), 2026-08.

The claim that lands: conversation does **not** become knowledge on its own. Slack's own
early research said so — "you wish it did, but really it's just a lot of stuff that just
hangs out there and people still have to repeat themselves." Making sense of the exhaust
was never humanly possible; the argument is that it is now an agent's job.

**We have the problem, measured.** 445 transcript entries across 15 conversations have
produced 17 personal memories and **zero** shared ones — 1.13 memories per conversation,
and nothing at all that crosses between agents. The one channel that turns talk into
something durable is `RememberFact`, which the agent must decide to call.

This is the other half of the work done on 2026-08-25. Scoping conversations to threads
fixed context *pollution* — Monday's finished objective no longer steers Wednesday's
question. It did nothing for context *accumulation*, and by cleaning the separation it
made the gap plainer: nothing carries what was learned in a finished thread into the next
one.

The split worth holding on to:

> **A thread is working context and should stay clean. Knowledge is what survives a
> thread, and should accumulate across them.**

### Candidates, in the order they are worth doing

1. **Compaction should keep the reasoning, not only the record.** The article's phrasing
   is "ask an agent to reconstruct *why* it was decided, and how the context has shifted
   since". Our summary headings are Threads / Done / State / Artifacts — four ways of
   recording *what*, and no place for why, or for what changed after. Pure prompt change,
   effective the same turn, and aimed straight at the zero shared memories.

2. **An emoji reaction as a task trigger.** "In Jaime's channel, an emoji reaction adds an
   item to the list and an agent picks up the task." We already carry Feishu reactions —
   but only outbound, as status. Inbound, a reaction on a message is the cheapest possible
   way to say "deal with this", and the task board it would feed already exists.

3. **The briefing should be a queue of decisions, not a report of state.** Her Monday
   morning is a recap *with flagged escalations*, meeting prep, and a draft handed back
   for her to approve. Our digest reports what the board contains; it hands nothing back.
   Needs a definition of what earns a person's attention first, or it becomes another
   report nobody reads.

### One thing deliberately not copied

The article argues repeatedly for defaulting to public and widening the surface area,
because an agent can only learn from what it can see. We spent the same day narrowing
`OtherThreads` to one chat, on the evidence that an agent told to go looking without a
bounded target loops — OpenBot reverted exactly that feature after bots "went hunting the
open web and looped on a government 404 page".

Both can hold, along the same seam as above: **distilled knowledge crosses threads;
raw conversation does not.** What an agent learned goes somewhere shared and searchable;
the transcript it learned it from stays where it was said.

---

## What a retrieval layer returns decides what can be answered

Source: *Build a Multi-Agent GTM Intelligence System*, Akshay Pachaar, 2026-08-24. A
sponsored walkthrough of Seltz (`mcp.seltz.ai/mcp`) built on CrewAI, so the product claims
are advertising. The framing underneath them is not.

The framing: some questions have no page that answers them. "Which target companies hired
an AI leader last quarter, and what happened there since" only exists after a person's
role history and a company's recent news are merged. A search API returns ranked links
with snippets, and

> a snippet is enough to tell you a page is worth opening and never enough to answer from.

So the agent fetches, parses, extracts, repeats — once per entity. The pitch is that when
each call returns a complete record, the join is a merge instead of a reassembly.

### This article demonstrated its own thesis against us, on the same day

Both halves are in `~/.agentbox` and can be re-read.

In one thread the same article was pasted in as text, and the agent answered it well —
what it pitches, what to push back on. In another thread the question was three words,
`这个系统我指的是seltz`, and the agent:

- fetched `seltz.com` — cert error; the real product is `seltz.ai`
- opened Google — captcha (`/sorry/index`)
- opened Bing — results, none of them the product
- landed on a domain-appraisal page for a parked `seltz.com`, valued at $148
- concluded, correctly given what it had seen: *我没找到"叫 Seltz 的 GTM 系统"*

That refusal is the behaviour we spent the day building — it stopped rather than
inventing. It was still the wrong answer, and **not one word of the fix belongs to the
model.** The article had been in the vault, processed, since the day before.

### The mechanism finding, which is ours

`WebSearch` needs `BRAVE_SEARCH_API_KEY`. It is not in `~/.agentbox/config.json`, and
across every conversation on disk **the tool has been called zero times.** `WebFetch` on a
search engine correctly refuses and advises `browser_open` instead — which is what the
agent did, and what Google captchas. So every web question in this installation degrades
to scraping a search engine through a browser, and the degradation is invisible: it
returns a page, not an error.

### Candidates

1. **Configure the search key, and make its absence loud.** One line of config. The
   second half matters more: an installation that silently answers every web question by
   scraping a captcha page should say so at startup, the way a missing channel token does.

2. **A tool over the vault, not a bigger web search.** This is the same conclusion the
   Slack entry reached from the other direction, and the [pull argument](13-design-review.md)
   settles which shape: not more context pushed in, but somewhere the agent can *look*.
   The Seltz answer existed, was already distilled, and had no door.

3. **Sequential specialists with a join, as distinct from fan-out.** Ours is `Fork` —
   *n* independent branches, merged by concatenation. Theirs is a pipeline: stage 2 takes
   stage 1's names, stage 3 joins both. Different shape, and worth knowing which one a
   task needs before adding either.

### Not copied

Buying a structured index. The honest paragraph in the article is its own "when to chain
with open web search" — open web for discovery, the index for depth once you have a list.
Note that our MCP client support means any such index is pluggable without us building
one, which is the reason not to build one.

---

## A bot is a role plus the tools that make it accountable

Source: *Designing Grok Bot with Grok Bot*, a SpaceXAI designer, 2026-08-25. First-person
practice, not architecture — which is why it is worth reading: it says what the shape is
actually used for.

Four bots, each named for one job. **Figma Bro** does repetitive production. **Motion
God** prototypes motion. **Experiments** is where ideas go before anyone knows what they
should be. **Devbot** answers engineering questions *and helps the other bots understand
how an idea would get built*. They huddle, delegate, and bring the work back — one task
had Experiments hand movement to Motion God and desktop behaviour to Devbot, then
assemble the prototypes.

The line that matters is not about design at all:

> I don't want Figma Bro eyeballing any of this. Through the Figma MCP, it can inspect the
> actual file and use exact x and y positions… If there's an existing frame or component,
> that is the source of truth.

That is the same argument that got us a semantic snapshot instead of screenshots, arriving
from the other end. **A bot is not distinguished by its personality. It is distinguished
by which tool it has and what that tool lets it treat as ground truth.** Figma Bro without
the Figma MCP is a bot that eyeballs, and no amount of prompt fixes that.

Second thing worth taking: Motion God built *a playground on localhost around the real
animation spec file*, so its human could tune deterministically **and** direct in language
against the same running thing. An agent's best output is sometimes an environment, not an
artifact — and a box with its own computer and browser is the one thing here uniquely able
to produce that.

### Where this lands on us: the box has no MCP

Our agents differ by prompt and by allowlist. They cannot differ by *capability*, because:

- MCP servers are spawned by the host, over stdio, as host child processes. That is the
  right default — it is why a secret never enters the box.
- `presets.ts` names five faces of a preset: packaging, interface, skills, metering,
  acceptance. **There is no MCP face.**
- So a delegated engine running inside the box has skills and no external tools at all,
  and this installation's vault MCP — being configured host-side in another session — will
  reach the host and stop there.

The seam already exists and is already proven: presets point an engine's *model* traffic
at the relay so the key stays outside the box. Tool calls could travel the same way — the
box asks the host to run the MCP tool, the host holds the credential, the call lands in
the same transcript and passes the same policy gate as any other tool. That preserves the
one property the design is built on.

Which is a decision that crosses a boundary between two components that each already
work — [precisely the class](13-design-review.md) that goes to a hostile review before it
is built, not after. Recorded here as the argument for doing that, not as the design.

---

## Two arguments that point opposite ways, and both are right

Sources: *LLMs Eat Scaffolding for Breakfast* (2026-01-25) and *Against agent sprawl: what
comes after harnesses* (2026-08-07). Read together on purpose: one says delete the
harness, the other says the harness is the product. The seam between them is a useful
place to stand.

### Delete the scaffolding

The first says most agent infrastructure is bridging a model gap that closes. Its
sharpest evidence is not an argument, it is a diff: **Codex's system prompt went from 310
lines under o3 to 104 under GPT-5, a 66% cut** — personality, preambles, when to plan, how
to validate, all removed as things the model now knows. What remained was only what is
specific to Codex: sandboxing, tool use, output format. "Instead of *do this and this*, it
says *here are the tools at your disposal*."

**We measure clean, for now.** `BASE_PROMPT` is 64 lines, 4,033 characters — under the
104-line reference, and it is already the "here are the tools" shape. Worth re-measuring
whenever it is edited, because it grew four times in one day and each growth was locally
justified. The number to watch is not the assembled prompt, which is meant to be volatile;
it is the behavioural core, which is meant not to be.

The other half of the claim is a warning label for this whole document: *the worst AI
codebases are the ones that were best practices 12 months ago.* Every candidate recorded
here should be asked whether it bridges a gap that is closing.

### The harness is not the unit; the fleet is

The second says the opposite and is also right. Harness and model are co-trained and ship
as one artifact — "swap either half and you pay for it in performance and cost" — so the
rational setup is a *fleet* of harnesses, each running the model it was tuned with. That
is exactly the argument `presets.ts` was written from, arriving independently.

Then it names what a fleet needs, and the name is worth having: a **depot** — "a central
location where agents inside harnesses report status, request human reviews, maintain
durable execution and permissions, and internally cross-communicate to work as a team."
That is a description of what this repository is trying to be. Two things sharpen work
already on the list:

- **The attention criterion, stated exactly.** "You don't really care about which agents
  are working; you only want to know which agents *need your attention*." That is the
  missing definition from the briefing candidate above — a digest reports the first, a
  decision queue reports the second.
- **Review before the PR, not at it.** Local/agent review as a counterweight to volume,
  and human review at the level of a preview URL or a demo rather than a diff. Our board
  and claims machinery is the first; nothing here does the second.

### What checking this against our code found

Following the fleet argument into `presets.ts` turned up something the prose there claims
as built:

> The engine's model traffic is pointed at the relay, so the key stays outside the box and
> every token it spends lands in the same usage log as ours.

Neither half holds today.

- `delegateEnv` reads `AGENTBOX_RELAY_URL` and `AGENTBOX_RELAY_TOKEN`. **Nothing in the
  repository sets either.** They appear in `presets.ts`, its test, and the bundled
  `hostd.mjs` copy of the same function — and nowhere else. So `delegateEnv` returns `{}`
  on every real run, the engine gets no credential, and the delegated task cannot start.
- There is no model-API relay to point at in any case. The only relay is the **egress**
  relay, which forwards bytes and, by its own header, "never parses the traffic" — so it
  cannot substitute a key, count a token, or enforce a budget.

`Delegate` has been called **zero times** across every record on disk, which is why this
has never surfaced as a failure. The fix is not obviously the metering relay; it may be to
narrow the comment to what is true. Either way, a documented capability that cannot run is
the same silent-failure shape as the search key, and it was found the same way — by
checking a claim instead of reading it.

---

## Skills have a standard, we already speak it, and we cannot install one

Sources: `google/skills` (~80 skills, 2026-08-04), `niqinggood/openkitty-skills` (173
skills in 21 categories, 2026-08-14), `gfodor/legal-skills` (2026-08-14),
`joeseesun/qiaomu-meta-skill` (2026-08-05).

Four unrelated projects, same artifact, no coordination:

```
my-skill/
  SKILL.md      required: name, description, when it applies, the rules
  scripts/      optional: deterministic code
  references/   optional: source documents
```

Installed by copying the directory into whatever the host calls its skills folder —
`~/.grok/skills/`, `~/.claude/skills/`, ours is `/home/box/work/skills/`. Distributed by
`git clone`, or by a registry: `npx skills add google/skills`.

**Our format is already this.** That is luck worth banking: the ecosystem is directly
consumable. What we do not have is any way to consume it — `starter-skills.ts` bundles
four, an agent can write more, and **no code in the repository can bring in a skill from
outside.** openkitty also settles the question that creates: `external_skills` is an
ordered list, and your own directory wins. qiaomu says the same as advice — *fork it,
don't worship it*: install, run one real task, then delete the rules that are not yours.

### The boundary question, answered by someone who hit it

This is the best answer yet to *what belongs to the model and what belongs to the
harness*. From `legal-skills`, on why a markdown skill ships with Python:

> The scripts exist because models also cannot count, cannot do date arithmetic, and will
> report "all numerals consistent" after finding 19 of 20.

Three named failures, and the third is the one that matters: **the model's report of its
own completeness is not evidence.** So the rule is not "gate the prose" — which is what
made the regex grader wrong — it is:

> **Deterministic code goes exactly where the model is known to fail: counting, arithmetic
> over dates and quantities, and any claim about its own coverage.** Everything the model
> is actually good at — reading, judging, drafting, arguing — is left alone.

A 316-item checklist is gateable because "did all 316 get touched" is a count. "Is this
answer helpful" is not, and no amount of pattern-matching makes it one.

Three more things from the same repo, each a mechanism we lack:

- **A partitioned fan-out.** "11 specialized agents, each with the *whole* application and
  a part-file of checklist items they are forbidden to skip." Full context to everyone,
  the *work* partitioned — not the context. Our `Fork` partitions neither.
- **A convergence criterion.** The pipeline iterates "until two examiners and two
  adversaries clear the same packet." A stopping rule stated as agreement between
  independent checks. Our loops stop when the model decides they are done.
- **Freshness as skill content.** The skill instructs the agent to re-fetch the statutes
  and MPEP pages *on every run*, because the law moves. That is the pull argument arriving
  for the third time from a third direction — and note it is written in the skill, not in
  the harness, which is where a fact's expiry actually belongs.

And from `qiaomu-meta-skill`, the test that scaling makes mandatory: **触发评测** —
23/23 trigger evals, checking that a skill fires when it should and stays quiet when it
should not. With four skills the index is browsable and this does not matter. With 173 it
is the whole problem, and it is the one thing our golden suite has no case for.

### What this makes of the preset gap

A skill and an MCP server answer different halves. The skill says *how*; the MCP is what
lets the agent check rather than assume — Figma Bro's actual file, legal-skills' current
MPEP page. A preset that carries skills and no tools ships the instructions without the
ground truth, which is the [eyeballing failure](#a-bot-is-a-role-plus-the-tools-that-make-it-accountable)
under a different name. So the two halves of "skill+mcp preset" are not two features; they
are one, and shipping only the skills half would look like it worked.

---

## A memory nothing can check is not a memory

Sources: *Building Self-Correcting Memory in OpenWiki* (LangChain, 2026-08-25) and
*Knowledge Flywheels* (2026-08-05).

### The breakdown behind the 17

The [first entry](#conversation-as-knowledge) counted 17 memories against 445 transcript
entries. Split by kind, it is worse than the total suggested:

| kind | how it got there | count |
|---|---|---|
| `fact` | `RememberFact` — the agent decided to keep it | **2** |
| `note` | extracted automatically after a turn, nobody vouched for it | 15 |
| shared | any agent, for any other agent | **0** |

The one deliberate act has happened twice. Everything else is the extractor's residue —
and `note` is by design the kind that decays fastest and is dropped first when the budget
is tight. **The memory that survives is the memory nobody vouched for.**

And one of the fifteen is this:

```json
{"at":"2026-08-23T19:33:46.932Z","kind":"note","text":"(NOTHING)","source":"extracted"}
```

`NOTHING` is the sentinel the extractor asks for when a turn taught it nothing. It is
guarded in three places, all of them exact — `=== "NOTHING"` or `startsWith("NOTHING")` —
and the model wrote `(NOTHING)`. So one memory in fifteen is the extractor's own way of
saying it had nothing to say, stored as a thing it learned.

The bug is two lines to fix. The reason it survived for days is the interesting part, and
it is the next section's whole point: **nothing in this system can check a memory against
anything.** A stored line has no evidence attached, so there is no operation that could
have found this except a person reading the file.

### What OpenWiki does instead

When it writes a page it also records the *claims* that page makes and the code that
supports each one, **with the evidence's version**. Then:

- Staleness is `stored version != current version`. A deterministic sweep, **no model
  calls**, run before the agent does anything — so it stays fast at thousands of claims.
- **Stale is not wrong.** It means the claim can no longer be assumed without rechecking,
  and that uncertainty is durable: it persists across updates until somebody verifies.
- The agent never sweeps. Stale claims are surfaced *alongside the page when it reads it*,
  and it resolves them inside work it was doing anyway. So **cost scales with how much the
  source changed, not with how much is remembered.**
- Measured over a replayed commit history: stale claims 80 → 9, hallucinated 15 → **0**.
  In one run a change left 17% of claims stale; by the next checkpoint stale was 0% and
  supported had gone 77% → 98%.

The sentence to keep:

> Forgetting is not about deleting old memories. It is about **knowing when a belief should
> no longer be trusted**.

Our memory has decay — a score that fades with time — which is age, not doubt. Age is a
proxy that gets both cases wrong: a fact about how someone likes to be addressed is as
true in November as in August, and a fact about which port the box listens on can be false
an hour later. Evidence-linked claims distinguish them; a decay curve cannot.

That said, this is the piece most in need of its own [scaffolding test](#two-arguments-that-point-opposite-ways-and-both-are-right):
OpenWiki's evidence is code with a commit hash. Ours would be a chat message, a web page,
a file in the box — and only the last of those versions cleanly. A claims runtime with no
verifiable evidence is bookkeeping. **The subset worth doing first is the subset whose
evidence is a file in the box, because that is the one where the check is real.**

### Why this is not just hygiene

*Knowledge Flywheels* names the reason to care. Three scaling axes: models scale through
data and compute, agents through tools and harnesses, and knowledge through *distilling
what worked, what failed, when, and why* — with the claim that the third improves what the
**next** task can build on, at substantially lower cost than more elaborate
agent-centric self-improvement.

Its formulation is the one to steal, because it inverts what we treat as the asset:

> task + model + tools + **knowledge** → task-specific harness
>
> The persistent asset is not one harness, but the knowledge from which many harnesses can
> be constructed.

Set against the skills entry above, that is the same claim twice: a skill *is* distilled
experience made reusable, and our agents have written zero of them. Two memories and no
skills, from 445 turns, is not a memory problem or a skills problem. It is one missing
step — nothing ever asks *what did we learn* at a point where the answer could be written
down.

### And the install-path gap, confirmed in miniature

Checking that claim against the running box turned up a third one. `STARTERS` defines four
skills. The box has three: `morning-summary`, `research-brief`, `tidy-downloads`.
`study-a-corpus` is missing, and always will be, because seeding is guarded on the
directory being empty:

```ts
if (listing !== undefined && listing.entries.length > 0) return;
```

The guard landed in `5c5fee2`; `study-a-corpus` was added later, in `8545db0`. So it was
written, tested, committed — and cannot reach any box that already existed. Seeding is a
one-time event, and the code treats "has any skills" as "has the current skills."

Three findings in this document now share one shape: **a capability that is present in the
source, absent at runtime, and silent about the difference** — the unset relay variables,
the unconfigured search key, and this. That is a pattern worth a check of its own rather
than three separate fixes, and it is the same argument the preflight already makes for the
box: state what should be there, compare it to what is, and say so out loud.

---

## What is in the context matters less than what else is

Sources: *Context Rot: How Increasing Input Tokens Impacts LLM Performance* (Chroma,
2026-08-18) and Anthropic's *Context editing* API documentation (2026-08-06).

### The measurements

Chroma tested 18 models on deliberately trivial tasks — find one planted fact, replicate a
repeated string — while varying only input length. Four results worth carrying:

1. **Degradation is non-uniform and starts early**, even where the task is trivial enough
   that a model should behave like a computing system and does not.
2. **Low similarity between the question and the fact degrades fastest.** When the user's
   words resemble the stored fact, length costs little; when they do not — which is the
   normal case — length costs a lot.
3. **One distractor measurably hurts. Four compound it. Their impact is not uniform** —
   one of four produced a much larger decline than its siblings.
4. **Every model did better on a shuffled haystack than a logically structured one.** The
   authors' proposed explanation is that structure makes a planted fact stand out; the
   result held across all 18 either way. Worth knowing, not yet worth acting on.

The sentence the whole report reduces to:

> Whether relevant information is present in a model's context is not all that matters;
> what matters more is **how that information is presented**.

Result 3 is the one that pays here. It is the quantitative case for the three-state
`SectionState` contract and for narrowing `OtherThreads` to one chat — **every irrelevant
item we assemble is a distractor with a measurable cost, and one is already enough.** It
is also the counterweight to the Slack article's "widen the surface area", and settles
that disagreement on evidence rather than taste: widen what an agent *can reach*, never
what it is *handed*.

### The API already ships what we hand-rolled

`compaction.ts` was written around two decisions: compaction changes what is *sent* and
not what is stored, and a summary becomes an extra entry while the tail goes verbatim.
Anthropic's context editing makes the first of those a server-side feature:

- **`clear_tool_uses_20250919`** clears the oldest tool *results* past a threshold and
  "replaces each cleared result with placeholder text so Claude knows it was removed."
  That is [opencode's contract](13-design-review.md) — *unavailable is not the same as
  never existed* — shipped by the vendor. Optionally clears tool inputs too.
- **It happens server-side and the client keeps the full unmodified history.** Which is
  our first decision, implemented by someone else and with no estimator to be wrong.

This is the clearest instance in this document of scaffolding being eaten. Our compaction
exists because an agent hit 158KB in a day; the surgical version of that fix now exists
upstream. Two reasons not to simply delete ours: it is beta, and its failure mode is
different — ours degrades to dropping oldest entries *and saying so*, which is a property
worth keeping whatever runs above it. The honest next step is to measure one against the
other, not to assume either.

One thing to know before enabling: **tool-result clearing invalidates the cached prefix**
at the point of the clear, a direct interaction with the stable/volatile cache breakpoints
in `prompt.ts`. The parameter for that is `clear_at_least` — clear enough to be worth the
cache write, rather than nibbling.

### A default we never set

The same page documents `clear_thinking_20251015`, whose default varies by model class:
Opus 4.5+ and Sonnet 4.6+ keep all prior thinking; Haiku through 4.5 keeps only the last
turn's. Then the explicit instruction:

> If your code runs across multiple model tiers, set `keep` explicitly rather than relying
> on the per-model default.

We run thinking (`adaptive` / `summarized`), we permit four Claude models —
`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`, `claude-haiku-4-5` — and we set
`keep` nowhere. Three of the four keep all prior thinking and one keeps only the last
turn, so an installation configured onto Haiku silently loses reasoning continuity the
same conversation would have had on Opus. Not observed, because nothing here has run on
Haiku as the main model; recorded because it is the same shape as the rest of this
document — a behaviour that differs at runtime and says nothing about it.

---

## Emergent orchestration has a literature, and it is not encouraging

Sources: chengyongru, *multiagent 协作问题的初步整理* (2026-08-17), a survey of eight 2026
papers; and *Subagents on Subagents: How Many Layers Deep Is Too Many* (2026-08-13).

### First, the test a multi-agent design has to pass

Two results say the default answer is "use one agent". **OneFlow** found that across seven
benchmarks, a multiagent workflow on one base model can usually be simulated by a single
agent over multiple turns — and *cheaper*, through KV cache reuse. A second paper matched
thinking-token budgets and found single agents matching or beating multi-agent setups
across two benchmarks, three model families and five MAS architectures, suggesting much of
the apparent multiagent gain is just extra inference compute.

So the bar:

> A multiagent workflow must show it uses a condition a single agent does not have:
> different models, tools or real capabilities; different private information; different
> permissions and trust domains; environment actions that must run in parallel; different
> owners, goals or incentives; long-term state beyond one agent's capacity. Otherwise it is
> a more expensive single-agent workflow.

**We pass, and it is worth being able to say why.** Our agents hold different private
context (different chats), different permissions (principals and scopes), and answer to
different owners. That is three of the six, and none of them is available to one agent.
The corollary is a constraint: any *new* fan-out we add has to clear the same bar, and
`Fork` — same model, same tools, same principal, work split by volume — currently clears
it only on the last condition.

### Then, what goes wrong at scale

- **SILO-BENCH** (ACL 2026) removed predefined roles and gave each agent part of the truth.
  Agents communicated actively; communication did not convert into correct distributed
  reasoning. Performance fell sharply with task and agent count, reaching **zero success at
  ≥50 agents** on the hardest class. They call it the *Communication-Reasoning Gap*.
- **SIGDIAL 2026**, embodied: letting agents talk cut action conflicts by 40–90 points and
  **lowered** final task success versus silent collaboration. The transcript in the article
  is two agents spending six turns confirming that one of them will move a table.
- **Multi-Agent Teams Hold Experts Back** (ICML 2026): even told explicitly who the real
  expert is, teams fail to use them — they average the expert's answer with the wrong
  members'. Worse with more agents. The one upside is that the same averaging dampens a
  malicious member, so there is a genuine trade-off between using expertise and resisting
  a bad actor.
- **When 20 Agents Fail to Sort** (MAS-BENCH): a distributed sort collapses on inconsistent
  shared state, inconsistent conventions, duplicate submissions, and no agreement on
  whether the task is finished. Under simultaneous resource competition, **deadlock rates
  of 90% by default and 100% under a minimal prompt.**

And the aside that reframes all of it: humans need natural language because brains cannot
share state. Much of this literature may be studying *how several ChatGPTs converse*
rather than *how several agents coordinate*.

The conclusion is the part to keep:

> A real multiagent runtime has to re-confront the coordination problems of ordinary
> distributed systems — commit protocols, resource ordering, locks and leases, state
> versions, idempotent operations, termination detection. These cannot be solved by saying
> "please avoid duplicate work" in a prompt. Wherever the rule ends up encoded, it has to
> become **an explicit, executable, verifiable protocol rather than a behavioural
> suggestion.**

### Read against our own orchestrator

`orchestrator.ts` opens with:

> There is deliberately no router here: which agent handles what, and when to involve a
> teammate, is decided by the models through the messaging tools. The orchestration you see
> at runtime is **emergent, not encoded**.

And `claims.ts`, on the mechanism meant to stop two agents doing the same work:

> Nothing enforces that an agent claims before working — the model decides — so this makes
> duplicate work *visible and refusable* rather than impossible.

Emergent routing, natural-language messaging, advisory claims. That is, precisely, the
configuration the papers above degrade. Which is not an argument to change it now — at two
agents with different owners it is the right trade, and the honesty of both comments is why
this was easy to check. It is an argument about **what has to exist before agent count
grows**, and the list is no longer a guess:

| mechanism | ours |
|---|---|
| locks and leases | `claims.ts`, `DisplayLease` — advisory |
| state versions | `files.ts` — present |
| idempotent operations | partial: `deliveries` and `ingress` replay |
| commit protocol | none |
| resource ordering | none |
| **termination detection** | **none** |

Termination detection is the third time this document has arrived at the same hole —
legal-skills stops when two examiners and two adversaries clear the same packet, MAS-BENCH
fails partly because agents cannot agree a task is done, and our loops stop when a model
says so. And `DisplayLease` is the concrete place to look first for the deadlock result:
it is a scarce resource that multiple agents contend for, which is exactly the setting
where the measured rate was 90%.

### Blast radius, not depth

The second article asks how deep recursive delegation should go and answers that depth is
the wrong metric:

> For any agent-generated artifact, ask **what else becomes wrong if that artifact is
> wrong.**

An error at a leaf damages a leaf; an error at the root sets premises that every
downstream node treats as given, and fan-out multiplies it. Worse, **every handoff hardens
a mistake**: each node works on the previous node's artifact rather than the original
evidence, so "a small mistake can gradually become an assumption." Context isolation is
the benefit of subagents and also what puts distance between the final decision and the
evidence.

Its prescription for high-influence nodes — a verifier, structured output, independent
replication, human approval before fan-out, or **the original evidence travelling
alongside the conclusion** — contains the same idea as
[OpenWiki's claims](#a-memory-nothing-can-check-is-not-a-memory), reached from an entirely
different problem. Two independent arrivals at *attach the evidence to the belief* is the
strongest signal in this document so far, and it is one mechanism serving both: stale
knowledge and propagated error are the same failure seen at different times.

---

## Two performance articles, and why neither number is ours

Sources: *Inside Kimi K3's AgentENV: Can It Really Fork in 100 ms* (2026-08-03) and *How I
Got Computer-Use Clicks to under 10 ms on Modal* (2026-07-31).

### The measurement-boundary lesson

AgentENV advertises snapshot-backed boot or resume under 50 ms and incremental snapshots
under 100 ms. The author measured the boundary a *user* experiences — pause source,
capture VM and memory state, publish layers, resume source, create child, first successful
command — and got:

```
first-use latency ≈ 381.6 ms + 0.6728 ms × dirty MiB     (R² = 0.996)
```

360 ms at zero dirty memory, 1.75 s at 2 GiB. Then the fair conclusion, which is the
reason to record this at all:

> This does not contradict AgentENV's narrower under-100-millisecond claim. **The
> boundaries answer different questions.**

Not a debunking — a discipline. Every performance number in our own comments should name
the boundary it measured, because the one a person feels is almost never the one that was
easy to instrument.

### Measuring ourselves, and getting the opposite answer

The Modal article is directly about our X11 path. Its central finding is that per-action
process spawning dominates: `xdotool` wraps three XTest calls in an entire process
lifetime — fork, load the binary and its shared libraries, open a display connection,
close it — and a move-plus-click went **146 ms → 1.2 ms** by holding one display
connection open for the daemon's lifetime. Screenshots had the same shape: a capture
program, a temp PNG, a reopen, versus an XShm session held open and encoded in memory.

`x11-executor.ts` does exactly what it describes: it builds a `parts` array and spawns one
`xdotool` per action, and captures via `ffmpeg` to a temp file which it then reads and
unlinks. So the fix should be worth ~145 ms per action.

Measuring it in the running box did not reproduce the article's cost at all, and found a
production bug instead. Twenty invocations per condition, idle box at load 0.01:

| condition | per action |
|---|---|
| `mousemove --sync` to a position the pointer **is already at** | **15,541 ms** |
| `mousemove --sync` to a new position each time | **2 ms** |
| `mousemove` with no `--sync`, moving | **1 ms** |

So the process cost the article set out to remove is **1–2 ms here**, not 146. On that
number a persistent X11 connection buys nothing and the optimisation is correctly
declined; their figure evidently includes work, or an environment, we do not share.

The first row is the finding. **`xdotool mousemove --sync` blocks for roughly fifteen
seconds when the pointer is already where it is being sent.** `--sync` waits for the
pointer to arrive, and when no motion occurs there is nothing to wait for. It then returns
success.

`x11-executor.ts` uses `mousemove --sync` on six paths, including every click, drag and
scroll. So an action targeting the coordinate the pointer already occupies stalls for
~15 s, with any modifier keys held down for the duration — and the case that produces it is
not exotic. It is **clicking the same place twice**: a double-click expressed as two
clicks, a menu item under a button just pressed, or a model retrying a click that appeared
not to land — which is the single most likely thing a model does when a click appears not
to land.

It never surfaced as an error because `shell.ts` bounds these at 30 s and 15.5 s sits
comfortably inside. The action succeeds, slowly, and reports nothing: the same
silent-success shape as the rest of this document, here costing fifteen seconds of a
person's attention per occurrence.

The fix is not the article's. `--sync` is only meaningful when the pointer actually has to
travel, so the repair is to skip the move when the pointer is already at the target — not
to hold a display connection open.

**Fixed and verified** in `86b4985`: `pointerPath` drops any move that would not move
anything, on all six paths, and returns everything unchanged when the pointer's position
cannot be read so a failed query is never worse than not asking. Verified against the
rebuilt box by sending the same click twice at (640, 400) — 2,363 ms then 2,325 ms, both
dominated by the screenshot, with the pointer confirmed sitting on the clicked coordinate
for the second one. Before the change the second call would have spent fifteen seconds in
`mousemove --sync`.

*Boundary, since this section is about stating them:* wall time around `xdotool` inside a
single `docker exec`, excluding our daemon's dispatch and the host round trip. It is a
floor on process cost, not the cost of a tool call.

One thing we already get for free and should not lose: **we batch.** A click with
modifiers is `keydown … mousemove … click … keyup` in *one* `xdotool` invocation — one
process rather than five, and atomic because a single process is.

### The hazard attached to the optimisation, recorded before attempting it

If we ever do hold a persistent connection, the article names two failures that appear
only *after* the optimisation:

1. **The free flush disappears.** A process cannot exit without closing its display
   connection, and closing it flushes whatever Xlib has buffered — so waiting for
   `xdotool` to exit is also waiting for the events to land. A daemon holding the
   connection open never closes it, and without an explicit sync it can **report a click
   that never reached the screen.** Precisely the silent-success failure this document
   keeps finding, except here it would be *introduced* by a performance fix.
2. **Shared input state across concurrent requests.** One request sends Ctrl+L, another
   starts typing; if a `w` lands before Ctrl is released, the browser reads Ctrl+W and
   closes the tab. Their fix is an input lock held from the first press to the final
   release, and the same for drags.

We are protected from the second by accident of design — `DisplayLease` gives one holder
per display, so actions on a screen are already serialised — and from the first by using
short-lived processes. Both protections are properties of the thing the optimisation would
remove.

### On forking the box

AgentENV forks a *running sandbox* into independent children: microVM snapshots, dirty
page tracking, copy-on-write layers. We do not have that and, on the scaffolding test,
should not chase it. It exists to serve post-training and evaluation, where thousands of
short-lived environments branch from a prepared template. Our box is one long-lived
container per installation with a work volume that survives rebuilds — a workstation, not
a rollout. The two designs optimise opposite things, and the only reason to revisit is if
*branch my whole computer and try both* ever becomes something a person asks for.
