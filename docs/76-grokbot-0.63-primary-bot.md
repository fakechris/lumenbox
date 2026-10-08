<!-- doc: 76-grokbot-0.63-primary-bot
     title: What Grok Bot 0.63's Primary Bot is, and what it says we should change
     family: decision
     status: current
     updated: 2026-10-02
-->
# What Grok Bot 0.63's Primary Bot is, and what it says we should change

Status: **proposed 2026-10-02** (INV-951; candidates INV-952, INV-953, INV-954), from the installed Grok Bot 0.63.0 and Chris's live box
(in-box host `ea899bd`). The extracted source is kept outside this repository, at
`research/grokbot/versions/0.63.0/box/host-slices/` (the host modules quoted here) and
`research/grokbot/versions/0.63.0/box/managed-skills/` (the 47 server-served skills). Nothing
here is built yet; the ranked list at the end is a proposal.

## What it is

Primary Bot is **not a skill**. No managed skill, plugin skill or bundled prompt section is
about it. It is a platform role: each person has at most one *main bot*, shown pinned at the
top of the sidebar, which they hand tasks to first. The app introduces it as: "Primary Bot does
work proactively. It is your go-to for everyday tasks, unblocks your work, and checks in when it
needs your help."

It is gated by `sand_grok_main_agent`, which defaults off. Chris's account does not have it, so
everything below comes from the shipped code, not from watching it run.

### The pointer

- `GrokBotUserRuntimeSettings.main_agent_id` (field 9). The client can read it even with the
  gate off.
- `SetGrokBotMainAgent`: "Makes a live AGENT the caller owns the caller's main bot (one per
  user, replacing any previous one) and pins it if it was not already pinned; the owner may
  unpin it afterwards. Deleting the agent clears the pointer." Fails `not_found` for an agent
  the caller does not own or has deleted.
- `EnsureGrokBotDefaultMainAgent`, the chooser's "Add now": creates the default main bot
  ("Grok Bot") or reports the one the caller already has. It is idempotent because the bot's id
  is fixed per user, so retries and concurrent calls converge on one row. Outcomes: `CREATED`,
  `PRESENT`, `HAS_MAIN_AGENT`, `TOMBSTONED`, `PINNED_FULL`, `BUSY`.
- The server sets a main bot on its own only for a new user's onboarding bot
  (`sand_grok_onboarding_main_agent`). An existing user with none picks one in a chooser:
  "Choose a primary Bot", "Create Primary Bot", "Replace with different Bot".
  `sand_grok_force_main_agent_selection` keeps that chooser open until a main bot is chosen.
- `PreviewInternalPrimaryBotMigration` / `ExecuteInternalPrimaryBotMigration` migrate existing
  users in cohorts. Preview is read-only and signed, and execute re-checks each owner. Their
  counters show what migration has to handle: existing system bots (converted), default names
  and icons (renamed or changed), customised bots, and owners with ambiguous or missing system
  bots.

### What the bot itself gets

- **The `SetPrimaryBot` tool** (`sand-agent-management-tools.ts`), with the protocol in its
  description: "Only call it when the user has asked to change their primary bot (for example
  by answering 'Choose another bot'). Before calling: list their existing bots from your
  teammates list with a one-line reason each would or would not suit the role, ask which one
  they want, and wait for their answer. Then call this with that agent's id and confirm the
  change in one sentence. Passing your own id keeps you as the primary bot. The user can also
  change this themselves from the sidebar."
- **A main bot stays its owner's.** Converting it to a Team Bot is refused
  (`sand-team-conversion-tool.ts`, blocker `main_bot`), and the bot is told what to say: "I'm
  your main Bot, so I stay yours. A new Team Bot fits better: Create new Team Bot in the app."
- **Proactivity runs on the server.** The proto describes changelog campaigns, user
  enrolment, a "proactivity due set" and dispatched wakes. A proactive turn is marked
  `platformProactivity`: it is routed as `sand-proactivity-wake`, and the trusted-automation
  marker is withheld, so the wake is treated like untrusted input. The turn runs as a
  **subagent that cannot write the main chat** (`PLATFORM_PROACTIVITY_SUBAGENT_CLOSING` in
  `automations-prompt.ts`):
  - "Stay quiet by default."
  - Call `WakeParent` only when there is a message the user should read, and put only those
    words in the reason. An email or Slack draft goes there as a `DraftExternalMessage`
    handoff.
  - The parent writes what the user sees. A normal final response "does not wake the parent,
    does not reach the user, and is not copied into the main chat".

## Where we stand

| Grok Bot 0.63 | LumenBox today |
| --- | --- |
| One explicit main bot per person, set by the person or by onboarding | Implicit. Unnamed messages go to the door's `defaultAgent` (`channels/identity.ts`), otherwise to the installation default. Skills fall back to "the box's first agent", then the installation's first (`orchestrator.ts`, `defaultAgent:`) |
| Pinned at the top of the sidebar | The roster has no first-among-equals |
| Deleting the agent clears the pointer | Removing an agent (`registry.remove`) leaves any door's `defaultAgent` that names it |
| `SetPrimaryBot` tool with an ask-first protocol | No tool. Agents cannot change routing |
| A main bot cannot be made a team bot | Teams (docs/45) have no rule about this |
| Server-driven proactive wakes; a quiet subagent that must hand a message up explicitly | `HEARTBEAT.md` every 30 min for any agent with unchecked items (INV-777); host-initiated messages limited to 2 per room per day (`follow-up-budget.ts`, INV-535) |

The gap that matters is the implicit first agent. Whichever agent was created first becomes
the one that answers unaddressed messages and runs skills that do not name an agent. Nobody
chose that, and the person is never shown it.

## What we should change, ranked

1. **An explicit primary agent per owner.** Store one pointer, `primaryAgent` (an agent id),
   per owner. In a single-person installation that is just the installation. Use it in this
   order: the door's `defaultAgent` → the primary → the box's first agent (the current
   behaviour, kept as the last fallback). Skills that do not name an agent run as the primary
   too. Deleting the agent clears the pointer, and the roster then says there is no primary,
   instead of the role silently moving to the next agent in the list. Done when unit tests
   cover the routing order and the delete case, and the web roster shows the primary first
   with a "Primary" mark.
2. **A person can choose it in the web app, and an agent can change it on request.** The web
   roster gets a "Make primary" action; this is the person-facing screen required by INV-795.
   Add a `set_primary_agent` tool with Grok's protocol: only when asked; list the candidates
   with one line each on why they would or would not suit; wait for the answer; pass your own
   id to stay primary; confirm in one sentence. It is a routing change, so it is audited like
   any other side effect.
3. **Proactive turns are quiet by default.** A heartbeat turn should not post its final text
   to the room. Like Grok's proactivity subagent, it should say something only through an
   explicit hand-off (`notify`, or whatever we name it) carrying the exact words, counted
   against `follow-up-budget.ts`. A heartbeat that finds nothing then costs the room nothing.
   We should measure first: count how many heartbeat turns posted something nobody answered,
   over a week, before changing it.
4. **The primary stays personal.** Any operation that moves an agent out of a person's
   ownership (a team transfer, a template export that carries memory) refuses the primary and
   says why, in Grok's terms: create a new team agent instead.

Not proposed: server-side enrolment and changelog campaigns. Grok uses them to tell users
about product changes; we have no such channel and no need for one. Onboarding already produces
a de facto primary: the starter team's first agent is Ada, who coordinates and replies first
(docs/37 §4). Item 1 makes her the primary explicitly, at install, instead of by list order.
