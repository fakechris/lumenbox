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
