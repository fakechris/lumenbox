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
