# Roadmap and backlog

Everything deferred on purpose, in one place, ranked. The ranking lens is the one used
throughout: **(current risk × user impact) ÷ effort**, with hard dependencies noted.
This is a living document — an item moves up when its blocker clears or its risk rises,
and moves out when it ships. Written product-independently; the comparative analyses
that motivated several items live in the (untracked) `research/` directory.

The system today has the framework's five organization objects (conversations, people,
tasks, credentials, workers), a hardened turn engine, and — as of the 2026-08 run — the
reference toolset is complete: web fetch and search, a semantic browser, background shell
jobs, an edit tool, and a way for an agent to ask a question. What remains is a last mile
of usability, the unfinished half of the honesty surfaces, one large security item that
the browser work has made *larger*, and the structural growth into multi-person use.

**R22–R30 were added on 2026-08-26** from the outside-reading pass in
[docs/14](14-from-outside-reading.md). They are not new ambitions: most are gaps that pass
found in code we had already shipped, each with the measurement that established it. R25
also carries forward the adversarial-review findings that were recorded on 2026-08-25 and
never acted on.

**Shipped since this document was written**, and struck from the tiers below: R2, R5, R6,
R9, R11, R12, R13, R14, R15, R20, and the version-handshake third of R18. Alongside them,
work that predated this list: the MCP client and server, Delegate, Fork, lanes, the
three-tier permission boundary, and the upgrade safety story now in docs/12-upgrades.md.

---

## Tier 1 — small, high value, unblocked

These close loops the recent work opened. Days, not weeks, each.

### ~~R1. The composer respects the viewed conversation~~ — shipped, in two halves
The composer half landed on 08-22 (`779f24e`), thirteen minutes after this entry was
written, and the entry survived unstruck. The second half landed on 08-26 (`6c74e1b`)
after the product decision it was waiting on: a console message into a channel thread is
**a room message, not a whisper** — the interjection is pushed to the chat marked
〔控制台〕 and the agent's reply follows it, so the chat's members and the agent read the
same history. The enabling piece, `ConversationDirectory`, is R25's first slice built
early: the explicit id → chatKey record the adversarial review asked for, because the
derived id is one-way and nothing could answer "which chat is this?".

<details><summary>original entry</summary>

The middle pane can *view* any conversation, but the composer always sends to `main`.
Read a Telegram thread, reply, and the reply lands in the team room instead. Either
send to the viewed conversation, or disable the composer when viewing a side thread
and say why. Small; a correctness gap the conversation viewer created.
</details>

### ~~R2. Answer an approval from the chat channel~~ — shipped
<details><summary>original entry</summary>

A channel-driven turn that hits the policy gate pushes a notice to the phone — but the
person still has to open the web UI to allow or deny. A reply of `allow` / `allow always`
/ `deny` on the origin chat should answer it, so the "manage from a phone" story is
actually end to end. Medium-small. Depends on nothing; reuses the policy grant scopes.
</details>

### R3. Windows and Linux packaging
`package.json` already carries `win`/`linux` build config, but only `dist:app` (mac,
dir) exists. Add the platform targets and a real installer output, and settle the
macOS app name (packaging fixes the "still says Electron" menu-bar label). Medium.
Makes it a distributable rather than a dev launch.

### ~~R12. Web search and fetch as first-class tools~~ — shipped
Landed as `WebFetch` and `WebSearch`. The address guard written for it (`forbiddenAddress`)
turned out to be reusable at the browser's navigate boundary, which none of the three
reference implementations has.

<details><summary>original entry</summary>

"What is the current X" and "read this page" degrade today to `curl` through an HTML
stripper, or to pixel-driving the desktop browser — an order of magnitude more
latency and tokens, and it fails outright on JavaScript-rendered pages. A search
tool over a pluggable provider and a fetch tool that can render close the largest
single capability gap for some of the least code. Small. They enter through the same
allowlist / scope / policy surfaces as every other tool.
</details>

### ~~R14. An edit tool, not whole-file rewrites~~ — shipped
`edit_file`, refusing both text that is absent and text that appears more than once.

<details><summary>original entry</summary>

`write_file` re-emits the whole file for a one-line change: tokens scale with the
file, not with the change, and a stale rewrite gets refused by the changed-since-read
guard — which is honest, but still a failed edit. A `str_replace`-shaped tool (old
text, new text, optionally several pairs per call) is small and removes both costs.
</details>

### ~~R15. An agent can ask a question mid-task~~ — shipped, differently
Built as `AskUser`, which does **not** suspend the turn. The turn ends and the reply
arrives as an ordinary message that wakes the agent — reusing the existing message path
instead of adding suspension machinery. An agent told to carry on would either act on the
guess it just said it could not make, or burn rounds waiting for a message that arrives as
a new turn anyway.

<details><summary>original entry</summary>

A turn can only end with a final answer, so an ambiguous instruction forces a guess
carried to completion. An `ask` tool that suspends the turn, pushes the question to
the origin chat as a card (answers as buttons, the words still working), and resumes
on the reply is the approval pipeline wearing different clothes — suspension,
channel push, and one-shot binding all exist today. Small-medium; the payoff is
long-task success rate.
</details>

### ~~R22. Say out loud what is configured but absent~~ — shipped (`fe573a3`)
`absences.ts` names each gap at both boot sites with its degradation and one-line remedy;
starter seeding is per-skill with a `.seeded` marker (deletions stick, new starters
arrive — `study-a-corpus` reached the running box on the next restart); the presets
metering comment now describes the seam it has instead of the metering it does not.

<details><summary>original entry</summary>

Three findings from [outside reading](14-from-outside-reading.md) share one shape — present
in the source, absent at runtime, silent about the difference. `WebSearch` needs
`BRAVE_SEARCH_API_KEY`, which is unset, so it was called twice and refused twice while
every web question quietly degraded to scraping a captcha page. `delegateEnv` reads
`AGENTBOX_RELAY_URL` and `AGENTBOX_RELAY_TOKEN`, which **nothing in the repository sets**,
so a delegated engine gets no credential and cannot start. And starter skills seed only
into an empty directory, so `study-a-corpus` — added after that guard — can never reach a
box that already exists. One startup check that states what should be there, compares it
to what is, and names the gaps, plus the three fixes under it. Small, and it is the same
argument the box preflight already makes.
</details>

### ~~R23. Stamp a tool result when the result arrives~~ — shipped (`f883d7f`)
The `blocks` entry says when the model asked, the `results` entry when the answers were
in. No format change; the existing field started telling the truth.

<details><summary>original entry</summary>

The `blocks` entry and its `results` entry carry an identical timestamp, because both are
written when the exchange is appended. So all 172 tool batches on disk derive a duration of
0.00s and the transcript records *when a pair was written*, not *how long anything took*.
That is the gap the `--sync` click bug fell through: it never failed, it returned success
in fifteen seconds, and a pass/fail suite cannot see that by construction. **One line**,
and the dead records become a latency surface. Smallest item on this page and the
prerequisite for R24.
</details>

### R24. A run has to say which model and which code produced it
Every transcript entry carries `at, blocks, causedBy, covers, kind, role, text`. `causedBy`
and `covers` are more than the reference asks for — but nothing records the model, the
harness version, or the code SHA, and the assembled prompt is never stored. So "did this
regression start the day we swapped the model" and "how long was the context when it got
confused" are both unanswerable from our own records, while "how often did this tool return
an empty result" is answerable and was answered. Small; needs a decision about where the
prompt hash lives, not a subsystem.

### ~~R19. Host-initiated exec, marked as such~~ — shipped (`0d4fcba`)
`ExecRequest.actor` labels who asked, and boxd logs every command with it. The gap
turned out to be larger than the entry said: nothing logged exec *at all*, so the one
endpoint where "who did that" matters most was the one that could not answer. Untrusted
by construction — evidence about our own callers, not proof about a stranger — and
`unlabelled` rather than a guess when absent.

### ~~R20. Spill what pruning removes~~ — shipped
<details><summary>original entry</summary>

Every layer of long-output handling truncates honestly — and what it drops is gone
everywhere at once: the omitted middle of a shell result capped at 20k characters
exists nowhere on disk, and the transcript stores only the first 2k of each result,
so even `ReadHistory` recovers a stub of a stub. The reference discipline is prune +
spill: the full text always lands somewhere durable, and the pruned copy carries a
pointer. Smallest full shape: boxd tees exec output past a threshold into a spool
file, and the truncation note names the path and line count — `read_file`'s line
ranges already are the read-back side, no new reader needed; `storableResult`'s cut
gets the same pointer. Small; R13's blood line (a terminal file is a spill), but it
does not wait for it.
</details>

---

## Tier 2 — medium, valuable, mostly unblocked

### R4. Grant grows into Scope
The Grant object (holder, resource, expiry) was built as the Scope seed. The growth:
bind `{memory, files, secrets, tools, sandbox, schedule}` into one grantable boundary,
so "this agent, in this project scope" is a single authorization rather than five
separate settings. The framework's largest remaining object. Medium-large; design
first, because the boundary shape is the whole decision.

### ~~R5. Provider per agent~~ — shipped
<details><summary>original entry</summary>

The runtime is a global singleton: changing the model changes the whole installation.
The framework's principle 1 is that agent identity and runtime are separate — an agent
should be able to run a cheaper model without the others knowing. Add an optional
per-agent provider/model override on the profile, falling back to the global default.
Medium. Unblocks "the reviewer runs the big model, the tidy-up agent runs the cheap one".
</details>

### ~~R6. Per-principal / per-conversation spend caps~~ — shipped
<details><summary>original entry</summary>

Spend is now attributed per person; the budget gate is still global. A cap per
principal (or per conversation) turns attribution into control — "this channel user
gets $2/day". Medium. Depends on nothing; extends the existing policy budget.
</details>

### ~~R11. A semantic browser toolset over the box's own browser~~ — shipped
Six tools over a hand-rolled CDP driver inside boxd, plus the shell guard rider. Shadow DOM
and cross-origin frames are walked, which all three reference implementations punt on.
Refs are derived from what an element *is* rather than its position, because a positional
counter renumbers when a banner appears and turns a held ref into a different element.
No persisted ref store: it trades a loud failure for a quiet one.

<details><summary>original entry</summary>

Pixel-driving the desktop works for any GUI app, but for the browser it is the slow
and unreliable path: locating a button in a screenshot misreads coordinates, and every
step costs an image. The reference shape is a page-level toolset — navigate, a
structured snapshot with element refs, click/type/fill by ref, tabs, screenshot —
attached over CDP to **the same visible Chromium the desktop shows**, so semantic
automation, the person's view and the persistent logins are one browser, not two.
Medium-large; pairs with the fork/delegation work (browser snapshots are exactly the
context traffic an isolated sub-conversation should eat). Rider, cheap and immediate:
block UI-automation binaries (`xdotool`, `wmctrl`, `pyautogui`, `playwright`) in the
shell tool — an agent that finds them routes around the audited `computer` tool and
takes the screenshot pipeline blind with it. When it lands, the final-screenshot gate
grows to include the browser tools.
</details>

### ~~R13. Shell jobs: background, stream, and await~~ — shipped
<details><summary>original entry</summary>

A command that runs past the timeout is lost, not slow — a dev server, a large
build, a long download are a category of task the box simply cannot do. The
reference shape: `block_until_ms` auto-backgrounds the call, output streams to a
terminal file the agent can read incrementally, and an `await` tool blocks on a
regex over that output. Needs a job field on the exec protocol and per-job state in
boxd. Medium. Rider, nearly free: enrich the box toolchain (`ripgrep`, `gh`, `tmux`,
`uv`) — the agent's own productivity multiplies, and tmux is a substrate jobs can
fall back to.
</details>

### R25. What identifies a conversation, finished
The adversarial review of 2026-08-25 raised six findings; the top one was fixed and the
rest were recorded and not acted on. They are still true:

- **P2P conversations are unbounded.** Group messages are keyed on `root_id ?? message_id`,
  but `feishu.ts` still returns `feishu:${chatId}` for `p2p` — so a direct chat running for
  weeks is one growing history, which is the problem thread-scoping was built to fix.
- **A derived key is not a record.** `conversationIdFor`, `scopes.boundTo` and the web
  server's `digestFor` each re-derive identity by string prefix, so three places have to
  agree and a chat id that is a prefix of another collides. An explicit conversation record
  ends the class.
- **317 records are unreachable.** `feishu-oc_…5ec315f91c2e4a19.jsonl`, the chat-level file
  written before threading, cannot be addressed by any key the system now produces. Migrate
  it or declare it archived — either is fine; leaving it is the thing that is not.

Medium. This is the decision that was implemented three times, so per docs/13 it goes to
review before the fourth.

### R26. Skills you can install, not only write
Four unrelated projects ship the same artifact — a directory with `SKILL.md`, `scripts/`,
`references/`, installed by copying into the host's skills folder — and **our format is
already that**, which makes the ecosystem directly consumable. Nothing in the repository
can consume it: four bundled starters, agent-authored skills, and no path in from outside.
`openkitty` settles the question that creates: `external_skills` is an ordered list and
your own directory wins. Small-medium, and it is the honest version of R21's import half.

Rider, and the reason not to over-invest: a skill that encodes *how this installation
works* cannot be baked into anyone's weights, and one that teaches a general method can.
Build the first kind; borrow the second and expect to delete it.

### R27. Evidence attached to the belief
Two unrelated sources arrive at the same mechanism: OpenWiki stores each claim with the
*versioned evidence* that supports it, so staleness is a deterministic diff with no model
calls and "stale" means unverified rather than wrong; and the subagent-depth argument says
a high-influence artifact should travel with its original evidence, or every handoff
hardens a mistake into an assumption. Stale knowledge and propagated error are the same
failure at different times, and one mechanism serves both.

Our memory decays on *age*, which is a proxy that gets both cases wrong — how someone likes
to be addressed is as true in November as in August; which port the box listens on can be
false in an hour. **Start with the subset whose evidence is a file in the box**, because
that is the only kind we can version cleanly; a claims runtime over unversionable evidence
is bookkeeping. Medium; design first.

### R28. Turn the observed failures into eval cases — first third landed
`4bf2a77`: the memory sentinel is now matched by letters rather than exactly (the stored
`(NOTHING)` removed, the next one impossible), and the Seltz failure is a golden task —
`empty-is-not-an-answer`, an empty directory the prompt insists holds notes, graded on
having actually looked and then on reporting absence without describing features. Passed
live on its first run. Remaining: process invariants, trigger evals (waits on R26), the
memory ablation, and the seventeen-tasks-versus-traffic comparison.
"If your eval doesn't include the failure modes you've seen in the wild, it's a vanity
scorecard" — and docs/14 is a list of failure modes seen in the wild, none of which is a
case in the suite: an empty search result plus a wrong domain, a sentinel string stored as
a memory, an over-refusing contract, a click that succeeded in fifteen seconds. Three
additions that are cheap once R23 lands:

- **Process invariants**, checkable on every run rather than on the seventeen tasks we
  wrote — "no unsafe writes", "did not answer from priors after an empty tool result".
- **Trigger evals** for skills: does a skill fire when it should and stay quiet when it
  should not. Irrelevant at four skills, the whole problem at a hundred, so it is R26's
  dependency rather than a separate wish.
- **An ablation**: remove memory and measure the delta. With 2 facts and 15 notes, this is
  the honest test of a component we keep proposing to extend — if the score barely moves,
  the memory layer is theatre.

And the validation step that makes a suite trustworthy at all: our seventeen tasks were
invented and have never been compared to real traffic. Both halves of that comparison are
already on disk.

### R16. Webhook and event triggers
Scheduled skills cover "every morning"; nothing covers "when the build breaks" or
"when an external system pings". An HTTP ingress whose calls arrive as inbound
messages — identity-bound, scoped, through the same gate as every other channel —
turns automations from cron-only into event-driven, and is the entry ticket for the
enterprise direction. Medium; design the identity story first, because a webhook is
a credential.

### R17. A project tier of memory
Memory is self and team today; the third natural boundary is the scope. What was
learned inside a project stays with it, is injected for whoever works there, and
dies with it — the Scope object already exists as that boundary, so this is memory's
third growth rather than a new subsystem. Medium.

### ~~R18. Finish the honest box~~ — shipped, all three
The version handshake (`BOXD_PROTOCOL`) landed with the upgrade work; the last two thirds
landed 08-26 (`ccb0875`). Uploads write to a `.part` name and take the final name in one
atomic rename — through an in-tree symlink the write goes to the resolved target, where
the direct write went. And a failed box call now says which of four situations it is,
with the remedy in the message because the reader is usually a model: refused (4xx) will
be refused again unchanged; crashed (5xx) and timeout mean the effect is unknown, check
before redoing; unreachable means nothing was delivered and retry is safe.

---

## Tier 3 — large, or needs a design decision first

### R7. Secrets an agent reads land in the transcript in clear (S-1)
The heaviest security item, and **heavier again** since this was written. Backups copy the
transcript; the volume backup now copies the browser profile too; and the browser and web
tools mean an agent reads far more third-party text than it did. The browser snapshot
redacts password fields, which is the narrowest possible version of this — a token in a URL,
in a page body, or in a fetched API response still lands in the transcript in clear. An agent
that reads a `.env` or a key puts it in its own history in clear. Needs a redaction
design that does not also destroy legitimate content — the hard part is deciding what a
secret looks like without a false positive eating a real answer. Large; design first.

### R8. Per-step checkpoint and resume of side effects
The oldest deferral. Today a turn interrupted mid-batch resumes by re-reading its
transcript and telling the model "the outcome is unknown — look before redoing"; safe
reads now re-run automatically (shipped), but a side-effecting call whose result was
never written is still declared unknown rather than completed. The reference design is
a write-ahead intent record per effect plus provisioned ids (pi harness-v2 §5–7). Large.
The current coarse-boundary approach is honest and tested; this is an upgrade, not a
fix, which is why it has waited.

### ~~R9. Auto-review as a state machine~~ — shipped
<details><summary>original entry</summary>

Two products build a confirm → reviewer → runner → persisted-state machine for
automatic review. The mechanism is clear; the blocker is unchanged — the review
*criteria* must be designed, and no external structure designs them. Medium once the
criteria exist; do not start before they do.
</details>

### R10. Gateway hardening for real multi-tenant (S-2, S-3, S-4, S-6)
A batch, only when multi-tenant SaaS is actually the goal: TLS on the gateway (S-2), a
real identity provider instead of a token list (S-3), the box not trusting gateway
identity headers blindly (S-4), and the control-plane key not sitting beside its
database (S-6). Large. The current single-operator model does not need these, and doing
them speculatively is the over-engineering the whole project avoids.

### R29. The box has no MCP, and a preset has no MCP face
MCP servers are host child processes over stdio — the right default, and the reason a
secret never enters the box. The consequence is that **anything running inside the box has
no external tools at all**, including a delegated preset engine, and `presets.ts` names
five faces (packaging, interface, skills, metering, acceptance) with no MCP among them. So
a preset ships instructions without the ground truth that makes them checkable, which is
the eyeballing failure under another name: a skill says *how*, an MCP is what lets an agent
verify instead of assume.

The seam exists and is already proven in shape — presets point model traffic at a relay so
the key stays outside the box; tool calls could travel the same way, with the host holding
the credential and the call landing in the same transcript and policy gate. Large, and it
crosses two components that each already work, which is exactly the class docs/13 sends to
hostile review **before** it is built.

### R30. Coordination as protocol, before agent count grows
A survey of eight 2026 papers says a multiagent design must use a condition a single agent
lacks or it is a more expensive single agent. We pass on three counts — different private
context, different permissions, different owners — and `Fork` clears only one, which is a
constraint on new fan-out rather than a defence of what exists.

The scale results are the part to act on. Communication does not become coordination;
letting agents talk cut action conflicts and *lowered* task success; teams average the
expert away; simultaneous resource competition deadlocked at 90–100%. Our orchestrator says
orchestration is "emergent, not encoded" and `claims.ts` says its lease is advisory. Both
are honest, both are fine at two agents, and both are the configuration those papers
degrade. What has to exist before the count grows:

| mechanism | ours |
|---|---|
| locks and leases | `claims.ts`, `DisplayLease` — advisory |
| state versions | `files.ts` — present |
| idempotent operations | partial (`deliveries`, `ingress` replay) |
| commit protocol | none |
| resource ordering | none |
| **termination detection** | **none** |

Termination detection is the one that keeps recurring: our loops stop when a model says
they are done, where the reference stops when two independent checks agree on the same
artifact. `DisplayLease` is the concrete place to look first for the deadlock result — a
scarce resource that several agents contend for is precisely the measured setting. Large;
a dependency of the multi-person direction rather than a parallel track.

### R21. Agent and skill bundles: export and import
A team's agent (profile, skills, scope shape — never its memories or secrets) packaged
as a file another installation can import. The sharing unit people actually want, and
the seed of any future gallery. Deliberately after the delegation preset work: the
preset's packaging face is this feature's foundation, and building the bundle format
before a second real installation exists would be designing for an audience of zero.
Large-ish; design the boundary (what travels, what never does) first.

---

## What to do next, as of 2026-08-26

Reranked after a pass over outside reading (docs/14) that produced one fixed production bug
and several measurements of our own state. The new items win on the lens not because they
matter more than R1 or R7, but because three of them are one line to a day each and every
one of them makes the *next* problem findable.

1. ~~**R23, stamp the tool result.**~~ Shipped (`f883d7f`).
2. ~~**R22, say what is missing.**~~ Shipped (`fe573a3`).
3. ~~**R1, the composer.**~~ Shipped — see the entry. Its second half also landed the
   first slice of R25 (the explicit conversation record), which shrinks that item.
4. ~~**R18's remaining two thirds.**~~ Shipped (`ccb0875`).
5. **R28's cheapest third.** The failure modes in docs/14 as eval cases. The suite passed
   the Seltz refusal by luck and has no way to keep it.
6. ~~**R19, the exec marker.**~~ Shipped (`0d4fcba`).
7. **R7, secret redaction.** Still the heaviest security item and still growing on its own:
   the web and browser tools mean an agent reads far more text written by other people, and
   every token in a URL or an API response lands in the transcript in clear. Needs design
   before code — the hard part remains what a secret looks like without a false positive
   eating a real answer.

Then the structural choice, which is a product decision rather than a ranking:
**the multi-person direction** (rooms, group-as-interface, task-as-state, box-as-
workstation). Everything under it — R4's Scope growth, R16's webhooks, R17's project
memory, R21's bundles — is either a dependency of it or considerably easier after it. Two
items now sit squarely on that path and did not before: **R25** (a conversation's identity,
which is the object a room is made of) and **R30** (coordination as protocol, which is what
stops being optional as the agent count grows).

Three candidates recorded from reading and deliberately not promoted, because each needs a
product decision rather than effort: compaction that keeps *why* a thing was decided and not
only what; an inbound emoji reaction as a task trigger; and the briefing as a queue of
decisions rather than a report of state — with the criterion the reading supplied, *you only
want to know which agents need your attention*.

Then the structural choice, which is a product decision rather than a ranking:
**the multi-person direction** (rooms, group-as-interface, task-as-state, box-as-
workstation). Everything under it — R4's Scope growth, R16's webhooks, R17's project
memory, R21's bundles — is either a dependency of it or considerably easier after it.

Two loops this run left open on purpose, both small and both waiting on the multi-person
work rather than on effort: nothing yet listens for the "wait" that postpones an upgrade,
and `ANNOUNCE_MINUTES` is a number nothing counts down. Both are really questions about
how a bot holds a conversation with a room.

Not on any tier, and worth stating: **the browser work has only met fixtures.** A real
OAuth flow and a live payment iframe are where it will actually be tested, and neither
has happened.

One correction to carry: an earlier count in docs/14 said `WebSearch` had never been
called. It was called twice and refused twice — a grep for `web_search` against a tool named
`WebSearch`, which is the same wrong-name failure that started that document.

---

## Explicitly not now, with the reason

- **Box-side credential delivery.** Weakens the vault's one strong property (a secret
  never enters the box). The host-side path is the honest one.
- **Trash instead of delete.** Three products route deletes through a trash; the box's
  exposure is `/home/box/work`, excluded from backups, and a real implementation
  (intercepting `/bin/rm`) is not cheap while a half-measure (an alias) is decoration.
- **Signed events / federation.** No sovereignty or cross-system-audit requirement has
  appeared. Nothing forecloses it later.
- **The five review deferrals** (docs/07-review.md): OCC non-atomic cross-agent,
  allocation credential split, optimistic recording start, checked-audit fail-open for
  plain allows, wall-clock lease. Each is an edge case documented with its reason,
  behind bigger rocks.
- **Voice, mobile-native, code-mode sandbox, embeddings/CKG retrieval.** Product scale
  or shape the box does not have; the documented retrieval trigger has not fired.
- **Image generation, video-review subagents, a WebAuthn bridge.** Real in the
  reference, but each is a product-shape decision waiting for a user who asks, not an
  architecture gap; recorded so they stop being rediscovered.
- **Forking a running box.** Snapshot-and-branch sandboxes exist to serve post-training and
  evaluation, where thousands of short-lived environments branch from a template. Ours is
  one long-lived container per installation with a work volume that survives rebuilds — a
  workstation, not a rollout. Revisit only if *branch my whole computer and try both*
  becomes something a person asks for.
- **A persistent X11 connection for computer use.** The published case for it measures a
  move-plus-click at 146 ms; measured here it is 1–2 ms, so the optimisation buys nothing
  — and it would *remove* two protections we currently get for free: the Xlib flush that a
  process exit performs, without which a daemon can report a click that never reached the
  screen, and the serialisation `DisplayLease` already provides against concurrent requests
  sharing X11 input state. The real defect in that path was `--sync` on a no-op move, fixed
  in `86b4985`.
- **Buying a structured web index.** The join-shaped questions it serves are real, but MCP
  client support means any such index is pluggable — which is precisely the reason not to
  build one. Set the search key first (R22) and see what is still missing.
