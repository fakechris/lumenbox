# 42 · One front, invisible workers

*2026-09-08. Why our multi-agent chat feels worse than Grok Bot's, traced to the harness rather
than to any one prompt, and what to change. Companion to docs/41 (the chat) and docs/29 (bots).*

## What Grok Bot actually does

Read from the 0.30 prompts (`diff/dispatcher.new.txt`, `project-coordinator.new.txt`) and the
0.30 analysis, not from memory:

- **The bot you talk to is the dispatcher, never the workhorse.** "Your own turns must stay
  short — a reply, bookkeeping, a dispatch — so a new message always gets an answer within
  seconds, even while heavy work is in flight."
- **Workers are blank executors with no way to reach the user.** "Executors start blank … and
  executors have no SendToUser — they cannot reach the user at all." A worker's only channel is
  `SendToAgent agent_id:"parent"`; "an unsent result is invisible."
- **The machinery is invisible.** Never say "dispatching", "delegating", "spinning up". "You are
  one person doing many things at once."
- **Decisions are a widget, one at a time.** A question widget with ≤6 options, `allowCustom`,
  `dismissOnMoveOn`: the person can ignore it and the bot moves on with a default.
- **Separate bots are peers with their own chats**, made rarely (Bot Boss made three in two
  days), each with a persona the person sees; the coordinator still fronts.

So the person has one conversation per bot, and inside it one voice. Everything heavy happens
behind that voice.

## What ours does

- **Every agent is a peer with a chat and a direct line to the person.** `AskUser` from any
  agent lands in that agent's chat; a teammate woken by a message can ask the person things
  the front agent never sees.
- **The only worker we offer is a teammate.** The team section says "delegation is a decision
  made after the work" and warns against waking teammates; `Delegate` exists but is framed as
  "a specialist engine for repositories". A front agent facing a heavy request therefore
  either does it inline (the person waits with no signal) or creates/wakes a peer (the person
  is pulled into another chat and interrogated there).
- **Creating a teammate demands a full persona from the creator**, four parts, from nothing.
  The creator does not have the facts, so it asks the person for them. That is the whole of
  the dr eggbot interview: our `CreateAgent` made a persona author out of a router, and
  `AskUser`'s options never reached the page, so each question became prose with digits.
- **Questions had no budget and no dismissal.** Grok's widget can be moved past; ours held the
  turn until answered, so five questions were five stalls.

Fixed today on the surface (docs/41 stage two): question cards with buttons, consent/secret/
computer cards in the thread, approval wakes the agent, the on-it row, prose replies carried
to peers, task assignment notices, first message to a new agent, name resolution among
teammates, and `CreateAgent` told not to interview.

## What to change in the harness (the plan)

1. **An executor, not a teammate, for heavy work.** `Delegate` grows a `preset: "self"`: a
   background run of the same agent's model and tools, blank context, a self-contained brief,
   no `AskUser`, no `SendToAgent` to anyone but its parent, result delivered to the parent as
   a system message. The front agent's prompt says what Grok's says: your turns stay short;
   anything beyond a few tool calls goes to an executor; steer a running one rather than
   starting another; never name the machinery to the person. `Jobs` already tracks it.
2. **Workers cannot reach the person.** A turn opened by a peer message or an executor brief
   has no `AskUser`; the question goes to the parent as a message and the parent decides
   whether to ask the person. One voice per chat.
3. **A question can be moved past.** A question card that the person answers by typing
   something else is dismissed with "moved on"; the agent gets the person's message and a note
   that its question was not answered, and proceeds on its stated default. Every `AskUser` must
   name the default it will take.
4. **A persona is drafted, not interviewed for.** `CreateAgent` from a brief writes the four
   parts itself from the brief and the catalog; the new agent's own first turn asks the person
   its one question. The creator never asks on the new agent's behalf.
5. **A question budget per task.** Two `AskUser` calls per task contract; the third is refused
   with "decide and say which way you went".

Order: 1 and 2 together (they are one mechanism), then 3, then 4 and 5 as prompt/tool text.
