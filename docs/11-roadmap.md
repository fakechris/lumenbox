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
of usability, the honesty surfaces (now finished — R18, R22, R23), one large security item
that turned out to be two (R7 keeps at-rest hygiene, R4 inherits containment), and the
structural growth into multi-person use.

**R22–R30 were added on 2026-08-26** from the outside-reading pass in
[docs/14](14-from-outside-reading.md). The same day, three mechanisms were added to
existing entries (R30, R8) after reading **FrontierAgent** (ApodexAI, Apache-2.0) against
its own launch copy: the copy oversold mid-run steering as impact analysis and partial
recomputation, which the code does not do — and undersold a code-level submission gate,
which it does.

None of these are new ambitions. Most are gaps that a pass found in code we had already
shipped, each recorded with the measurement that established it. R25 also carries forward
the adversarial-review findings from 2026-08-25 that were recorded and never acted on.

**Shipped and struck from the tiers below:** R1, R2, R5, R6, R9, R11, R12, R13, R14, R15,
R18, R19, R20, R22, R23, and the first third of R28. Alongside them, work that predated
this list: the MCP client and server, Delegate, Fork, lanes, the three-tier permission
boundary, and the upgrade safety story in [docs/12](12-upgrades.md).

**Designed but deliberately not built**, each with the review that stopped it:
[R7](15-secrets-in-the-record.md) — the containment framing did not survive, and what is
left is at-rest hygiene with containment moved to R4. [R30](16-long-work.md) — designed
twice and stopped twice. The first review killed the completion gate's load-bearing claim;
the [second](reviews/2026-08-26-obligation-ledger.md) killed the protocol that was supposed
to come first, and found ten false claims about our own code in the document proposing it.
What survives is one field, not a ledger. All three documents keep the wrong version rather
than rewriting it, because the correction is the useful part.

---

## Tier 1 — small, high value, unblocked

These close loops the recent work opened. Days, not weeks, each.

### ~~R35~~ — shipped 2026-08-29 (`0514602`)

Both defects closed by one mechanism: the SDK's own logger is the witness (it exposes no
state and no close hook), a custom logger classifies its lines, `connect failed` schedules
a narrated retry on a 5/15/30/60s backoff, `client ready` resets it and logs
`socket ready` — the evidence of life the old `connected` line never had. Kill and
relaunch immediately; the socket rides out the vendor's ~1 minute registration window on
its own. The original entry follows.

### R35. A Feishu socket that fails on its *first* connect leaves the bot deaf and silent

Observed 2026-08-28, restarting the web server to pick up the box-class work. The process
logged `channel feishu: connected`, then `[ws] ws connect failed` a few seconds later, and
then nothing at all — for four minutes, until it was restarted again. A message sent to the
bot in that window got no reply and produced no error anywhere. The likely cause is
ordinary: the previous process had been killed three seconds earlier, Feishu still had its
connection registered, and it refuses a second consumer for one app id. Our consumer lock
(`src/channels/single-consumer.ts`) correctly showed one holder, because **the collision is
at the vendor's end and the lock is machine-local** — it cannot see this.

Two separate defects:

1. `wsClient.start({ eventDispatcher })` is fire-and-forget (`feishu.ts:794`) and our
   `channel feishu: connected` line is logged **because we called start**, not because
   anything connected. The log asserts a state nobody checked. DingTalk's path does better
   and says `connection closed; reconnecting in 5s`.
2. Nothing retried. The SDK reconnects on a socket that *closes*; a socket that never
   *opened* apparently just stops. The only thing that would eventually notice is the
   two-hour health check, which is a very long time to be deaf while looking fine.

Smallest honest fix: treat "start returned but no event has ever arrived" as a failure with
its own retry and its own log line, and stop logging `connected` for a call rather than for
a connection. A restart that waits for the old process to be gone at the *vendor's* end —
not just locally — would also help, and there is no signal for that other than time.

### ~~R37~~ — closed 2026-09-03 as blocked-external (vendor risk control; `bots/join` 121016)

### R37. Meeting presence — the browser path worked once, then the vendor said no

**Final state, 2026-08-29 evening.** The browser path is dead by policy, not by
bug: after the one fully successful join-and-share, every later join by the
dedicated account terminated the meeting within seconds — confirmed by hand,
without any agent involved: the account joining manually got **「由于安全原因会
议中止」**. Risk control: a fresh account, web-only, sharing its screen seconds
after joining, several short meetings in a row — the exact automation signature
the vendor's model hunts, and one earlier invite-kills-meeting theory tested and
discarded on the way (a chat-triggered join with no invitation died identically).
This will not be engineered around: simulating a human at a meeting the vendor
gates behind an official agents API is the wrong side of their policy, and the
121016 admin switch is the same policy's front door. **The official `bots/join`
path is therefore the primary route** — blocked solely on the tenant-side switch
(ticket ammunition: code 121016, log_id in the section below). What stays
working with zero risk surface: the 「桌面」 authenticated link, 「屏幕」
stills, and a possible card-stream watch verb. Also logged from the same
session: MiniMax-M3 lost the `computer` tool schema after a memory compaction
and burned ten minutes guessing parameter shapes — a separate defect worth its
own fix (schema examples surviving compaction).

### R37 (history). Meeting presence: invite the bot, watch its desktop in the call

Chartered 2026-08-29. The property the owner asked for: see the box's screen from
Feishu **with no inbound connectivity at all** — the desktop arrives through the
vendor's own encrypted RTC, connections all outbound, no URL published anywhere.

The vendor offers no media API, so the shape follows the prior art (Hermes Agent's
`feishu_meeting_invite.py`, read from source): the platform's whole contribution is
turning `vc.bot.meeting_invited_v1` into an ordinary message to the door's default
agent, with join instructions. The joining is the agent's job — and this
installation's agent has what Hermes's lacks: a real Linux desktop with a browser
on it. The instructions: open `vc.feishu.cn/j/<meeting_no>` in the box's Chromium,
join as a guest under its own name, share the entire screen, stay until dismissed.

**Validated end-to-end 2026-08-29, same day, in a real meeting.** The whole chain
ran: invite → `video_chat` message (the field is `meet_number` — learned from the
wire, pinned in a test; the VC *event* is a second entrance once subscribed) →
agent opens the join page → joins → shares the entire screen → the inviter watched
the box's desktop live in the call. The three unknowns, answered:

1. **Guest browser join requires identity** (QR login or phone+SMS) — solved by
   logging the box's Chromium into a **dedicated Feishu account** once; the
   session persists in the browser profile (and dies with `box up --recreate`,
   when it must be scanned again).
2. **`getDisplayMedia` works against Xvfb** — picker, thumbnail and live stream
   all real.
3. The meeting shows the bot as the logged-in account.

Two hand-learned traps are now in the agent's join instructions
(`meetingInvitePrompt`): the identity wall means "say so, don't try phone
numbers", and the post-share privacy toast must be left to expire — clicking it
early killed the first share. Console prerequisite per app: subscribe
`vc.bot.meeting_invited_v1`. A per-door `meetingRemoteControl` option (off by
default — control of the shared screen is control of the box) decides the
agent's answer when a participant requests remote control; whether the vendor's
web client offers that dialog at all is untested.

**The official `bots/join` path, tested to its current end (2026-08-29):**
`scripts/feishu-meeting-join.mjs`, request shape from larksuite/cli's Go source
(`join_type: 1`, the number under `join_identify` — the flat form answers
99992402 naming both fields). Against an ended meeting: `121005 meeting not
exist` — past validation, past any gray gate (no 20017), scope accepted.
Against a **live** meeting: **`121016 "switch for allowing agents to join
meetings is disabled"`** — and the switch exists nowhere in this tenant's admin
console (产品设置→视频会议 and the 智能伙伴 section were both searched by the
admin). Conclusion: the API's server side reached general release ahead of its
admin-console switch; this tenant cannot flip what it cannot see. Next move
when wanted: a ticket quoting code 121016 and log_id
`2026082922191786012D43FEF29AC760B8`. Not blocking anything — the browser path
is the screen story and works today; the official path would only add formal
presence and in-meeting text (it has no media face).

### R36. Hot-loadable extensions: reload the edges without restarting the core

Asked for twice on 2026-08-29, with two working references. Pi's official mechanism:
extensions are TS modules default-exporting `function (api)`, loaded by jiti (runtime TS
compilation, no build step), discovered in `~/.pi/agent/extensions/*.ts`, re-registered by
a `/reload` command — extensions, skills, prompts, keybindings together. deepseek-harness
goes further with cordis: a live plugin runtime the agent itself can define into and
retract from, host halves in a `node:vm` sandbox.

What both prove, and what neither does: **you hot-load a plugin layer, not the core.**
Node cannot swap the running server's own modules; the trick is an extension seam where
modules register against an API and a reload tears down and re-imports them (dynamic
`import` with a cache-busting query, or jiti, or a vm sandbox). Our restart story already
covers the core (R35's retry made restarts waitless); what a seam would buy is editing
the *edges* without dropping the Feishu socket at all.

Where the seams already almost exist here:

- **Skills** are files read from disk at use — effectively hot today.
- **MCP servers** are external processes; making their config re-readable would hot-add
  tools without restart.
- **Channel wire verbs** (看板/团队/定时…) and **tool definitions** are the Pi-shaped
  candidates: a `~/.agentbox/extensions/*.ts` directory, a factory-function contract, a
  reload verb, every registration torn down and re-made.

Not started: it is a feature with a security face (an extension runs with the process's
full authority — the loading rule and who may drop files there need docs/10 treatment),
and the cheap majority of its value (skills hot, restarts painless) is already shipped.
Build when a person edits extensions often enough to feel the restart.

**R36, first seam shipped 2026-09-02 (`b02ecb4`).** Lifecycle hooks in Claude Code's dialect:
`~/.agentbox/hooks.json` runs PreToolUse / PostToolUse / Stop / PreCompact commands with the
same stdin payload and answers Claude Code uses, re-read on mtime. Not a plugin system — the
edges that can be scripted today are the tool call, the turn end and compaction — but every
existing hook script is portable to us unchanged, which is the vocabulary decision R36 needed
before any loader.

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

**And it inherited a requirement from R7's review.** The only thing that would actually
keep a credential out of the record is a **capability proxy**: the host performs the
privileged operation and the model never holds the value. Today's `RunOnHost` is the
gesture without the enforcement — it injects a real secret into a child process, and an
approved command can print it straight back into a tool result. The vault is honest that
it refuses the in-box case; it does not, and cannot as built, prove the value stays out of
the *record*.

So `secrets` in the list above is not "which secrets may this scope name". It is **which
operations may this scope perform with a secret it never sees** — a different and larger
object than a grant, and the reason the boundary shape really is the whole decision.

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
- **An ablation** — redefined, because the obvious version measures the wrong thing.
  `AGENTBOX_ABLATE=memory` exists (`prompt.ts`) and running the suite with it would show
  no difference, for two reasons that took measuring to see. Golden runs in a fresh state
  directory, so its memory is empty and removing it changes nothing. And more
  fundamentally, **what is stored and what the suite grades are different dimensions**:

  | what the 16 records hold | what golden grades |
  |---|---|
  | style — "answer in Chinese", "definition first, then context", "prefer tables" | is the number 36 |
  | domain corrections — "100Gbps is often mistyped as 100GB", "DGX is a family, ask which SKU" | did the task reach the board |
  | scepticism — "flag unverified specifics" | did it report the absence |

  Almost all of it is about *how* to answer; the suite grades *what*. So the run would
  come back flat, and flat would be read as "the memory layer is theatre" — a clean-looking
  number from an experiment aimed at the wrong axis, which is worse than no experiment.

  **The cost half is exact and worth having now: 16 records, 3,002 characters, ≈1,200
  tokens injected into every single turn.**

  The experiment that would answer it grades style with the `judge` that already exists —
  is it in the user's language, is it structured, did it ask which baseline — over a set of
  tasks written for that, which makes it the process-invariant work above rather than an
  ablation.

  And the cheaper question to answer first, because it can retire a whole layer: **2 of
  the 16 are `fact` (deliberate, via `RememberFact`) and 14 are `note` (auto-extracted,
  nobody vouched for them), and the notes are most of the 1,200 tokens.** Keep only the
  facts and measure the style delta. If it barely moves, the note tier — extractor, decay,
  budget — is scaffolding that can be deleted, and deleting it also settles the finding in
  docs/14 that the memory which survives is the memory nobody vouched for.

And the validation step that makes a suite trustworthy at all: our seventeen tasks were
invented and have never been compared to real traffic. Both halves of that comparison are
already on disk.

### ~~R31~~ — closed 2026-09-03 (`spend.ts` + `/api/spend`; residue re-filed, see the triage)

### R31. One place to see what happened, and drill into it
A requirement that grew out of a day of work rather than out of a comparison: **every
question asked on 2026-08-26 was answered by writing a throwaway script.** How many
memories, how many tool calls, what a batch of fetches cost, what is on the board, how
long a turn took. Fifteen or so one-offs, none re-runnable, several wrong on the first
attempt precisely because they were improvised. `agentbox scan-records` was the first one
promoted into the tree, on the principle that **a number nobody can re-run is a claim**;
this entry is that principle applied to the rest.

What is wanted is concrete: a daily view, and the ability to drill from it into one task —
its execution, its artifacts, its rounds, its token and cost consumption. Over time, the
thing decisions get made from.

**The data exists and cannot be joined.** Measured:

| ledger | carries | lacks |
|---|---|---|
| `usage.jsonl` (562) | `agentId`, `at`, `round`, `seq`, `model`, input/output/cache tokens | **`turnId`, `conversation`, `taskId`** |
| `tasks.jsonl` (143) | `id`, `status`, `history`, `requester`, `assigneeId`, `conversation` | **`turnId`** |
| `turns.jsonl` (134) | `id`, `agentId`, `about`, `attempt`, `event` | — |
| `activity` (511), `policy` (1209), `inbox` (136), `ingress` (48), `deliveries` (68) | their own events | a shared key |

So a daily total is answerable today — 2026-08-25 cost 762,412 tokens, 08-26 cost 403,975,
and Ada accounts for 1,783,693 of 1,822,631 — while **the thing actually asked for is
not**: of 46 tasks on the board, zero can be costed. The only available join is "same
agent, near in time", which is a guess rather than a total.

**This is the same gap as [docs/16](16-long-work.md), seen from the reporting side.** The
missing thing is the id that ties a task to its turns to their tokens. Two requirements,
one substrate.

**Corrected 2026-08-26, after the second review of docs/16.** The earlier version of this
paragraph said the substrate was the obligation ledger and that it should be built before
either requirement. That was wrong in a way worth naming, because it delayed this entry
behind a design that has now failed twice: *an obligation ledger is a fourth file with the
same hole in it.* Adding an id to a new file joins nothing. What both requirements need is
`workId` **on the records already being written** — one field, one write site for usage
(`turn.ts:1433`), stable across resumes, which `turnId` is not (`turn.ts:818` mints a fresh
one per attempt).

Which reverses the dependency: **R31 no longer waits on anything.** It needs the field, the
field is additive, and nothing about the completion gate has to be settled first.

What this entry adds on its own, beyond the join:

- **Artifacts as a first-class column.** "What did this task produce" currently means
  reading a transcript. Files written, tasks settled, deliverables pushed — the same set
  that [R28's churn detection](#) wants for `stateHash`, which is a second reason to
  record them.
- **Cost in money, not only tokens.** `usage` has `model` and `provider`, so a rate table
  turns tokens into a number a person can act on. Without it, "403,975 tokens" is a
  quantity nobody has intuition for.
- **The admin view is a different question from the agent view.** The web UI answers
  "what is this agent doing now". This answers "where did the month go" — different
  audience, different time horizon, and the reason it is a separate surface rather than
  another tab.

Medium, and mostly assembly rather than invention: the ledgers are already append-only,
replayable and on disk. What is missing is one id and one reader.

### ~~R32. The answer has to land where the person is looking~~ — shipped 2026-08-27

**Both halves are in.** The prompt half (closing-message rule) shipped earlier; the
mechanical half now: `BOOKKEEPING_TOOLS` in tools.ts (Tasks, RememberFact, SetTodos,
SetPlan, ClaimWork), and in turn.ts, text followed *only* by bookkeeping calls is appended
to the transcript as prose — where `replySince` reads the reply from — with an 80-char
floor so a genuine "记一下" stays an aside. The promoted text is stripped from the blocks
entry so it replays once, not twice. The Tasks tool description now says a note goes to
the board and not to the person. Tested as the pair the plan demanded: t51's shape
delivered, the one-line acknowledgement left alone, provisional text before an
investigative call untouched. Deferred from the plan: the on-disk count of historical
instances — the transcripts remain if anyone wants the number.

The section below is kept as the analysis that led there.

### The original analysis
Measured on t51, 2026-08-27, from the records rather than from the complaint. The person
asked which local models fit a new Mac. The agent ran `free -h`, found 16GB, worked out the
tier and wrote a table of what fits and what does not — **and the person's screen said
"已记下。t51 进入 review,等你下一步。"**

Where the answer went instead, all three places verified in the files:

| written to | who reads it |
|---|---|
| assistant narration between tool calls | the transcript, and the web UI as a folded step |
| the `Tasks.update` note | the board |
| a `RememberFact` | the agent's own future prompts |

Two of those are now less wrong — the card can say `review` and the board keeps it — but
**none of them is the chat**, and the chat is where the question was asked.

The shape is familiar and it is the third instance: an agent that names a file path instead
of sending the file ([`named-files.ts`](../src/host/named-files.ts)), a trace whose reasoning
is legible while its answer is a receipt, and now a turn whose conclusion is filed rather
than delivered. Each time the model did the work and put it somewhere reasonable; each time
"reasonable" did not mean "in front of the person".

And as with the file case, this is not a judgement about meaning: **whether the reply
contains the conclusion the turn produced is checkable.** A turn that wrote a substantial
task note and then delivered only a status line is a specific, detectable shape, which puts
it on the harness's side of the line this codebase keeps drawing.

### The rule that caused it, found in the code

`turn.ts:1556`, and it is one line:

```ts
if (toolUses.length === 0) {
  // …this round's text is the answer, and the turn ends
```

**Whether a piece of text is "the answer" or "thinking out loud" is decided entirely by
whether a tool call happens to follow it.** That is a fact about sequencing, not about
content, and t51 is what it costs: the agent wrote its whole analysis, then tidied up —
`Tasks.update`, `RememberFact` — and *the tidying demoted the answer to narration.* Had it
written the same paragraph and stopped, the person would have received all of it.

So this is not a model that withheld its work. It is a harness that reclassified the work as
internal because the model was conscientious afterwards.

### The plan

**1. Not every tool call is evidence of unfinished work.** Split the toolset in two:

- **investigative** — `bash`, `WebFetch`, `WebSearch`, `computer`, `read_file`… calls whose
  results the agent has not seen yet, so anything said before them is genuinely provisional.
- **bookkeeping** — `Tasks`, `RememberFact`, `SetTodos`, `Plan`… calls that record what has
  already been concluded. Their results tell the agent nothing it did not know.

Text followed **only** by bookkeeping calls is not narration. It is the answer, filed. This
is a static property of the tool list, not a judgement about any particular call, which is
what keeps it out of the model's hands.

**2. Deliver it.** When a turn ends and its last substantial text was demoted this way, that
text is the reply — not a fabricated summary of it, and not a second message.

**3. Say so where the agent can act on it.** `Tasks.update`'s description should state that
a note goes to the board and not to the person. The tool reads as a way to report; it is a
way to file.

**Why this is buildable now and the earlier framing was not.** The problem was stated as
"deliver the note when the reply does not already cover it", which needs a definition of
"cover" that is not a model's opinion — the completion-gate trap. Recast against the actual
rule, no such judgement is required: the classification is over tool *names*, fixed at build
time, and the text to deliver is text the agent already wrote for the person.

**The one risk, named:** a turn that legitimately says "I'll write that down" and then writes
it down would now deliver "I'll write that down" as its answer, which it already effectively
does. The floor is a length threshold, and the test that matters is the pair — t51's table
delivered, a genuine one-line acknowledgement left alone.

Small, and the measurement to check it against is on disk: every turn in the transcripts
whose last text block was followed only by bookkeeping calls is a case this would have
changed, and they can be counted before anything ships.

### ~~R33. Synthetic clicks do not reach the box's browser~~ — diagnosed and armed
**Resolved 2026-08-28, by a person hitting it.** The cause was never XTEST and never
Chromium: a stuck login popup ("X - The Everything App") held the X11 **input grab**, and a
grab swallows every button and key event on the display — human clicks through noVNC and
synthetic clicks through xdotool travel the same road and died the same death, while
pointer motion and hover kept rendering. That is exactly the "able to look, unable to
touch" symptom, and it explains the sibling observations: the unkillable "Restore pages?"
bubble in every stuck screenshot, Escape ignored, and Bob's desktop (another display)
working throughout.

Proof by removal: closing the popup **through the window manager** (`wmctrl -ic`, an EWMH
ClientMessage — the one channel a grab cannot block) instantly restored clicks; the next
synthetic click opened a terminal from the dock.

What shipped: a `close_window` computer action (the WM's polite close), and the tool
description now tells the agent the symptom and the way out — clicks that visibly do
nothing while hover still renders mean a grab, and the grabbing window's own close button
is as dead as everything else, so close it by id. The residual honest gap: a grab-eaten
click still *reports success* (XTEST injection succeeds by X11's rules), so detection
remains behavioural, not mechanical.

The identity-box line and the "watch it work" narrative are unblocked.


Found while verifying the admin view, and reproducible from inside the container with no
part of our code involved:

```sh
DISPLAY=:1 xdotool mousemove --sync 260 669 click 1   # exit 0
```

The pointer moves. The button under it renders its hover state. `xdotool getactivewindow`
names the Chromium window and `getmouselocation` reports the pointer inside it. **The click
does nothing.** `key Escape` is ignored the same way. Motion arrives; button and key events
do not.

So the computer-use path against the desktop browser is, on this box, **able to look and
unable to touch** — and an agent driving it would see hover states change under its cursor
and conclude its clicks were landing. This is the pattern from
[docs/14](14-from-outside-reading.md) in its purest form: the capability reports success and
never reports its own failure.

Not yet diagnosed. The suspects, in order: the Chromium instance is the one Playwright
launched and may refuse XTEST input; a stale "Restore pages?" bubble may hold a pointer
grab; or the container's XTEST extension is partially functional. What is established is
that it is not our executor — the raw command fails identically.

Two things this run fixed in passing, both ours and both real: an action name the executor
did not recognise fell through its `switch` and came back `{"success": true}` having done
nothing (`left_click`, which is Anthropic's vocabulary rather than ours), and `agentbox`'s
own screenshot script now forces a real load when only a URL fragment changes, because
Playwright's `goto` does not — which had it photographing a build that no longer existed.

Next step is a bisect rather than a design: a plain `xterm` on the same display, clicked the
same way, separates "Chromium ignores XTEST" from "this box ignores XTEST".

### R34. The identity the bot already has, usable as a capability — near half shipped 2026-08-27

**The near half is in**: `ReadFeishuDoc`, a host tool shaped like WebFetch
(`feishu-docs.ts`) — docx directly, wiki resolved to the docx it wraps, sheets/bitable/
drive answered honestly with the way that works today (export, or drop the file in the
chat). Offered only where a Feishu app is configured, same reasoning as WebSearch. The
app's two read-only scopes are granted by scan: `scripts/feishu-enable-docs.mjs`. The
auto-route idea (a pasted doc link fetched like an attachment, before the turn) was
deliberately left out for now — the tool description tells the agent to read a pasted
link immediately, which covers the observed case through the model; if practice shows
links still being apologised at, the route moves into the channel. The far half stays
with R29 as written below.
Observed 2026-08-27, in one message. A person pasted a Feishu doc link into the Feishu
chat; the agent answered "这个飞书文档需要登录才能看到正文" and asked what to do.
**It said this through a Feishu bot identity that was, at that moment, authenticated.**
The credential that could read the doc is the same one that delivered the apology for not
reading it.

The gap, named precisely: the channel identity is wired only for *messaging*. The adapter
uses `im.message.*` and nothing else — no docs, no drive, no wiki, no contacts. A person
reasonably assumes "the bot is in our Feishu" means "the bot can see what I send it from
our Feishu", and today the second does not follow.

Two layers, and they sit on opposite sides of the vault line:

- **Host-side identity tools (the near half).** The Feishu credential lives in host config
  and must stay there. So doc-reading is a *host* tool, shaped like `WebFetch`: the agent
  asks for a doc by URL, the host resolves it with the channel's own credential, the text
  comes back as a tool result. Same pattern for DingTalk. Cheap, no new secret movement,
  and it closes the exact case observed. A `feishu.example.com/docx/...` URL in a message
  should probably route there *automatically*, the way channel files already land in the
  chat inbox — the person did not think of the link as different from an attachment.
- **Box-side identity tooling (the far half, R29's territory).** Real scenarios need more
  than reading — 建群、拉人、发日程、查审批流. That is CLI/MCP-shaped and wants presets,
  but a Feishu CLI in the box implies a credential in the box, which the vault forbids and
  the observed case does not require. The honest shape is the one the model relay already
  established: **the tool runs in the box, the credential stays on the host, calls go
  through a narrow authenticated proxy** — per-capability, auditable, revocable. This is
  R29's MCP preset story with an identity attached, and it should be designed there, not
  improvised per-platform.

What was actually observed also carried a second, unrelated defect, fixed the same day:
the AskUser options reached the person as four lines of `[object Object]` — a model sent
option objects despite the schema saying strings, and `String()` did the rest. The
question that was supposed to rescue the failed doc-read was itself unreadable.

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
that reads a `.env` or a key puts it in its own history in clear.

**Designed, reviewed, and the design's central claim did not survive.** The full account is
[docs/15](15-secrets-in-the-record.md); what the roadmap needs to carry is that this entry's
own framing was wrong. It asked for "a redaction design that does not destroy legitimate
content", and the measurement — now reproducible as `agentbox scan-records` — says the
detection half of that has no true positives to find on our records and only false ones:
two matches over 1.8 MB, a Chinese search term in a URL parameter named `key` and a snippet
demonstrating reading a key from the environment.

What the adversarial review then established, and this entry now inherits:

- **Redaction at storage is at-rest hygiene, not containment.** `turn.ts` stores the
  redacted copy and pushes the raw results to the model on the next line; the model can
  re-emit the value base64'd, split, or quoted, and that lands verbatim. Worth doing,
  worth not overclaiming.
- **Containment needs a capability proxy**, where the host performs the privileged
  operation and the model never holds the credential. That is not a redaction feature. It
  is the shape `RunOnHost` gestures at and does not enforce — a `RunOnHost` command can
  simply print the value it was given — and it belongs with **R4's Scope growth**, which
  is the object that would own it.
- **A path list cannot police credential files while `bash` exists.** `~/.config/gh/hosts.yml`
  matches no plausible glob, and the shell reads anything the uid can. Refusing to serve a
  `.env` body through `read_file` is still worth having; calling it a boundary is not.

Shipped from this pass rather than deferred with it: the record scanner and its CLI
(`ec8bad1`), and the spool's three corrections — spill before durable truncation, a
non-configurable spool path so the backup exclusion cannot be bypassed, and hourly reaping
(`79112a0`). Remaining work is large and now correctly named: **at-rest hygiene here, and
containment under R4.**

### R8. Per-step checkpoint and resume of side effects
The oldest deferral. Today a turn interrupted mid-batch resumes by re-reading its
transcript and telling the model "the outcome is unknown — look before redoing"; safe
reads now re-run automatically (shipped), but a side-effecting call whose result was
never written is still declared unknown rather than completed. The reference design is
a write-ahead intent record per effect plus provisioned ids (pi harness-v2 §5–7). Large.
The current coarse-boundary approach is honest and tested; this is an upgrade, not a
fix, which is why it has waited.

**Two boundary conditions worth stealing separately, and much cheaper.** FrontierAgent's
mid-run steering (`apodex/steer.py`, `observers.py`) is, despite its marketing, only
"queue typed lines and inject them as the next user message at a turn boundary" — it
credits Claude Code and kimi for the pattern, and there is no dependency analysis or
partial recomputation anywhere in it. But two conditions around the injection are real
engineering we do not have:

- **Do not inject on a turn that made no tool calls.** The model is finishing; an injected
  message there leaves a dangling user turn on a loop about to stop.
- **Wake an idle coordinator when an instruction arrives.** Their fan-in can park a
  coordinator for minutes waiting on sub-agents; steering wakes it instead of waiting out
  a timeout. Our `Fork` join has exactly that shape, and nothing can currently interrupt it.

Both are small and neither depends on the write-ahead design, so they need not wait for it.
Recorded here rather than in a new entry because they are the same subject: what a turn is
allowed to do at a boundary it did not choose.

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

**A worked implementation exists and it is small.** FrontierAgent (ApodexAI, Apache-2.0,
read at `~/sdcard/source/FrontierAgent`) gates submission in code, in one function —
`plugins/tools/finalize_answer.py`:

> Checks (in order): empty answer (blocks) · sub-agents created but never assigned
> (WARN-only, never blocks) · **task-board items still open/in_progress (blocks)** ·
> (Planning Mode) solo submission (blocks) · (Planning Mode) **answer not independently
> verified (blocks)**.

Two things to take, neither of which is code to copy:

1. **A board with an unresolved item refuses the answer.** That is termination detection,
   and the reason it works is the detail in its own docstring: the gate is "identical
   regardless of HOW the agent signals done" — one implementation behind both the explicit
   finish tool *and* the bare-text terminator. A gate on one exit is a gate on no exits.
   Our board already carries the states this needs; nothing consults them at the end of a
   turn.
2. **Be precise about what such a gate buys.** Theirs checks that a verifier *ran*, not
   that it *approved* — nothing in that file reads a verdict. So it enforces "somebody
   independent looked", which is weaker than legal-skills' "two examiners cleared the same
   version" and much stronger than nothing. Worth implementing as the first, and worth not
   describing as the second.

And one mechanism from the same repo that answers a question this entry did not think to
ask: **who guarantees the independent check is independent?** In `create_subagent`, any
sub-agent whose name contains `verifier` is force-fed a verifier prompt and *the caller's
own `system_prompt` for it is ignored*. The coordinator therefore cannot write itself a
compliant reviewer — the harness owns the reviewer's identity, and the caller only chooses
to have one.

We already hold the equivalent property in one place and not the other. `golden.ts` runs
its judge on a different provider on the stated grounds that a model should not grade
itself. `Fork` has no such notion: the parent writes each child's brief, so a
parent-spawned "checker" is whatever the parent said it is. If a verify-fork is ever added,
the identity of the verifier has to come from the harness, or the check is the parent
marking its own work with extra steps.

### The gate has a 1980 solution, and the board predicate is not it

The objection that has to be answered before building any of this: **a gate that blocks on
"is there unresolved work" can livelock, because working is what produces unresolved
work.** Done badly it is a system arguing with itself and never finishing.

This is *termination detection*, and it was solved by
[Dijkstra and Scholten in 1980](https://www.cs.utexas.edu/~EWD/transcriptions/EWD06xx/EWD687a.html)
for exactly our shape — an initiator that dispatches work, nodes that may dispatch further,
and the question of how the initiator knows the whole thing is over. The protocol runs
along the spawn tree: a node joins as a child of whoever first messaged it, acknowledges
every later message immediately, and returns *that first* acknowledgement only once it is
idle **and** has no outstanding acknowledgements of its own. The initiator declares
termination when it is idle with none outstanding. Nodes are explicitly allowed to go
active again mid-computation, which is the discover-more-work case.

The difference from FrontierAgent's gate is the whole point:

| | what it checks | property |
|---|---|---|
| board predicate | "is anything open right now" | **global and non-monotone** — anyone can make it true again, at any time |
| Dijkstra–Scholten | outstanding acknowledgements along the tree | **structural** — a child's new work increments its own parent's count, which is that parent's own act rather than a predicate being flipped underneath it |

**`Fork` is already a spawn tree.** Parent dispatches, children report. So this needs a
counter and a rule, not an architecture: each outstanding fork is one unacknowledged
child, and a parent may finish only when idle with a count of zero.

### And the semantic half must never be the only authority

[LoopTrap](https://arxiv.org/html/2605.05846v1) demonstrates *termination poisoning*:
injecting content into what an agent reads — a page, a document, an API response — to
corrupt the progress signals it uses to judge completion, so it never terminates. Its
authors note this is stealthier than resource exhaustion because the agent **genuinely
believes the task is unfinished**. Anything we build where a model's judgement of "am I
done" is the sole gate is attackable through every tool that reads the outside world,
which is most of them.

So the design is three layers, and the ranking between them is not negotiable:

1. **Structural** — no agent has outstanding work. Dijkstra–Scholten-shaped, provable,
   unattackable by content because it never reads any.
2. **Semantic** — the work is actually right. Verifier agents, consensus, quality. This is
   the layer that catches wrong answers and the layer an attacker owns; it may refuse to
   finish and must never be what *permits* finishing on its own.
3. **Budget** — tokens, wall clock, spawn depth. Crude, and the only one that terminates
   unconditionally. It exists because the first two can both be wrong at once.

Empirical support for caring: a
[trace-observability study on GAIA](https://arxiv.org/html/2606.01365v1) classifies
tool-using multi-agent failures and finds the deeper levels dominated by repeated-action
loops and max-step termination — the most common real failure is the termination judgement
itself, not the work.

### What the gate says while it is closed

A gate that is honest and silent reproduces the experience reported of Apodex: more
trustworthy, and an afternoon with no answer. In a research console that is acceptable;
in a chat where somebody asked one question it is not.

The answer falls out of layer 1 rather than needing a design of its own: **the count is
the message.** Not "still working" — "two of three sub-questions settled, waiting on the
evidence check". That number *is* the termination condition, so reporting it is free and
cannot drift from the truth the way a progress estimate does. The task card already
updates in place and is the surface for it.

Per [docs/13](13-design-review.md) this went to hostile review before being built.

### The review came back and layer 1 does not survive as scoped

Three findings rated fatal, all verified against the code. **This is the entry's own
correction, kept rather than rewritten, because the wrong version is the useful record.**

**1. There is no durable fork edge to count.** `Fork` injects each brief through
`sendFromUser`; the child queue is marked started before the turn ledger begins, and the
parent's tool-use blocks are appended only after the whole batch returns. Die in that
window and the child is invisible to both inbox recovery and turn recovery, with nothing
linking it to the parent. A persisted counter hangs at one; a process-local counter resets
to zero and permits early completion. Both crash orders for a separate acknowledgement
write are unrecoverable without a commit protocol. `rescue.ts` rescues board tasks, not
forks, edges or counts.

**2. A scalar acknowledgement cannot tell success from terminal failure.** A fork whose
child times out or throws comes back as `--- fork N FAILED ---` inside a tool result that
is *not* an error, and the parent then answers and the task closes `done` — which
`fork.test.ts` asserts today. Decrement on failure and the gate finishes early with work
missing; do not, and it hangs. **Early completion is the worse half**, because it is
exactly the wrong-still-looks-correct shape docs/13 exists for. The states needed are at
least `pending | running | succeeded | failed | unknown | abandoned`, and failure has to be
an explicit obligation rather than a settlement.

**3. `Fork` is a one-level star, and the real work graph is a DAG with detached work.**
Children are *forbidden* from forking (the tool refuses a conversation already under
`fork/`), so depth is exactly one. Meanwhile work escapes the star in four ways the count
would never see: `SendToAgent` returns immediately while the teammate runs on; the bus
batches two senders into one turn, making a merge node rather than a unique-parent tree
node; `bash --background` and `Delegate` return a job id and outlive everybody; and a
scheduled skill enters through `orchestrator.prompt()` as an independent turn.

So **"Fork is already a spawn tree, this needs a counter and a rule" was wrong**, and it
was the load-bearing claim.

### What the review says survives

- The **critique of the board predicate** — mutable, advisory, not consulted at completion,
  and not a stable causal termination condition.
- **Dijkstra–Scholten's shape**, for a closed and reliably accounted computation. What the
  repository does not supply is the reliable message protocol, the stable root, and the
  durable graph it assumes. The algorithm can sit on that protocol; it cannot replace it.
- **Semantic verification as a veto and never the sole permit** — with the harness owning
  the verifier's identity and provider, and a verdict bound to an artifact version. Fork
  does neither today.
- **A hard budget as fail-safe**, persistent, enforced before spawn across total
  descendants, wall time and spend. Reaching it means *stopped incomplete*, not *finished*.
- **Mandatory completion accounting can coexist** with advisory claims and model-driven
  routing, once routing decisions are distinguished from encoded protocol invariants.

### Ten claims this document made about our own code, and what is true

Recorded because the pattern matters more than any single one: **every one of these was
written from a module comment or a memory of the design rather than from the code.**

| claimed | actually |
|---|---|
| agents have different owners, so we pass the multi-agent bar | `ownerUserId` is optional; default agents have none. Ownership diversity is *supported*, not guaranteed |
| `DisplayLease` is advisory | it is **enforced** — a second agent is refused. No TTL, so it is closer to an in-memory mutex than a lease |
| `DisplayLease` is the deadlock case to look at | it never waits or queues, so it cannot deadlock. Retrying models may livelock or starve, which is a different thing |
| termination detection: none | `AgentBus.idle()` already detects in-process quiescence and `settle()` is called in production. What is missing is a *submission gate*, not the predicate |
| our loops stop when a model says so | they also stop on budget refusal, model refusal, abort, provider failure, repeated-call detection, and round limits |
| `golden.ts` judges on a different provider | `resolveSummaryProvider` may return the same provider and model; only Anthropic has a cheaper-model mapping. **Independence is configurable, not guaranteed** |
| `deliveries`/`ingress` show idempotent operations | they are replayable ledgers. On the live path delivery debt is closed *before* the reply is sent, so a crash between loses it |
| the task card is a general progress surface | only adapters implementing both card methods get one; plain chats get none, and fork-child events are filtered out |

And one the review found on its own: **`activeAgentIds()` is already broken.** Worker keys
use a NUL delimiter and the helper searches for a space, so `indexOf(" ")` returns −1 and
it yields a truncated composite key instead of an agent id. Web deletion can miss an active
agent today, and this helper cannot back a completion gate.

### Where that leaves R30

The gate is **not** the next thing to build. What comes first is the protocol underneath
it: durable fork ids, parent turn ids, child conversation ids, terminal states, idempotent
acknowledgement, and restart reconciliation. Until that exists, a completion gate would be
a counter over a graph that is not recorded — which is the same failure as the board
predicate, wearing a proof.

**Designed in [docs/16](16-long-work.md)**, together with the two questions that turn out
to share its substrate: what long work costs, and how it stops when it is going nowhere.
That document also records the finding that made the cost question urgent:
`AGENTBOX_BUDGET_TOKENS` is unset, `config.json` has no policy block, and
`policy.test.ts` asserts that the default is `undefined` — **the spend ceiling is built,
tested, and switched off**, so the worst case is unbounded.

**Second review, 2026-08-26: the single-obligation-ledger design did not survive either.**
Five fatal findings and five major, with the fatal ones going to the parts that were meant
to be its strength — write-before-dispatch does not make the two crash orders
distinguishable, because inbox compaction erases the evidence (`inbox.ts:111`); and
`parentTurnId` is an *attempt* id that changes on every resume (`turn.ts:818`), so the
graph has no spine. Ten claims the document made about our own code were false, in a
document that opened by asserting all of them had been read out of the source.

What survives is smaller and better: **one `workId`, stable across resumes, written onto
the records that already exist.** The gate comes after a dispatch record and a proper
separation of attempt outcome from obligation resolution — three steps further out than
the last plan claimed, and the honest ordering is now in docs/16.

### ~~R21~~ — shipped 2026-09-02 as docs/29 (bot templates: pack, share links, import)

### R21. Agent and skill bundles: export and import
A team's agent (profile, skills, scope shape — never its memories or secrets) packaged
as a file another installation can import. The sharing unit people actually want, and
the seed of any future gallery. Deliberately after the delegation preset work: the
preset's packaging face is this feature's foundation, and building the bundle format
before a second real installation exists would be designing for an audience of zero.
Large-ish; design the boundary (what travels, what never does) first.
**Designed 2026-09-02 in [docs/29](29-bot-templates.md)** (v2, after v1's picker was
rejected): the bot packs itself through a served skill and one `PackTemplate` tool; the new
bot installs itself in its first turn from a recipe file in the box, with host rails
(routines forced paused, template-origin stamps, untrusted cue, reconcile + retry). Curated
memory *facts* do travel (the "never its memories" above is revised there, §3); the catalog
becomes the first-party shelf of the same format; share links on the control plane later.

---

## Triage, 2026-09-03 — every open entry checked against the tree at `3f94ad5`

Each entry below was re-read and then grepped for, by a reviewer told not to believe a doc
that says a thing *will* be built. Verdicts: **close** (done or superseded), **partial**
(what exists, what is missing, the next concrete step), **open** (first step, size).

| # | Entry | Verdict | Where it stands |
| --- | --- | --- | --- |
| R21 | Agent and skill bundles | **close** | docs/29: templates, share links, import; the catalog is the first-party shelf |
| R31 | One place to see what happened | **close** | `spend.ts` + `/api/spend`, three cuts, honesty rules. Residue: `rates` in config is empty (data), and "artifacts as a column" moves under R28 |
| R37 | Meeting presence | **close (blocked)** | both paths built to their end; the vendor's risk control and `bots/join` 121016 are outside the tree |
| R35 | Feishu first-connect | **close** | shipped 2026-08-29 |
| R3 | Win/Linux packaging | partial, S | `dist:win`/`dist:linux`, icons, `productName` all there; no artifact ever produced, no CI job. Next: a `workflow_dispatch` release job that asserts the installers exist |
| R8 | Checkpoint and resume | partial, S first | coarse resume ships; the cheap rider is still missing: steering is appended even when the previous round made no tool call (`turn.ts` ~1465). Next: guard on `toolUses.length > 0`. Write-ahead intent stays L |
| R24 | Which model, which code | partial, S | usage rows carry provider/model/workId/turnId; the transcript carries no version or SHA. Next: stamp `{version, commit, promptHash}` on the turn-ledger record at begin |
| R28 | Failures → eval cases | partial, S | 21 golden cases incl. the process and style tiers; trigger evals are now unblocked by `trigger: message`. Next: `AGENTBOX_ABLATE=notes` and run the style tier; then a fires/stays-quiet suite for listeners |
| R34 | Channel identity as capability | partial, S if needed | `ReadFeishuDoc` shipped; no auto-route at admission, no DingTalk twin. Next only if pasted links still get apologies: match the URL at admission and pre-fetch |
| R26 | Installable skills | partial, S–M | catalog + template import are the path *in*; still one `SKILLS_DIR`, no ordered search path. Next: `loadSkills` over a list of roots, own first, collisions reported |
| R36 | Hot-loadable extensions | partial, S then M | the hooks seam is real (`hooks.ts`, Claude Code dialect); no loader, no reload verb, MCP config still startup-only. **Security first**: `hooks.json` is arbitrary command execution from a mutable file and docs/10 has no entry for it — write that (S); then re-readable MCP config (M) |
| R10 | Gateway hardening | partial | S-4 closed (`stripIdentityHeaders`); S-2 no TLS, S-3 password list only, S-6 key beside the db. Next when promoted: S-6 — `AGENTBOX_CONTROL_KEY` as the documented path, loud warning otherwise |
| R25 | Conversation identity | partial, M | `ConversationDirectory` closed finding 2; p2p is still one growing history, prefix re-derivation in three places. Next: scope p2p on `root_id ?? message_id`, with an answer for the existing chat-level files |
| R7 | Secrets in the record | partial, M | scanner + spool shipped; at-rest hygiene not built at all. Next: exact-match redaction of vault-held values at the transcript append site, labelled hygiene not containment |
| R4 | Grant → Scope | partial, L | tools + secrets enforced, egress/filesRoot declared; memory/sandbox/schedule absent; the capability proxy unbuilt. Design first, on one privileged operation |
| R16 | Webhook triggers | partial, M | `trigger: message` covers the chat half; no HTTP ingress at all. Next: a per-door signed URL admitting into the same path `channels/manager.ts` uses |
| R30 | Coordination as protocol | partial, L | `workId` shipped; dispatch record, fork terminal states, submission gate all absent; `inbox.ts` warn-and-dispatch and `appendLine` without fsync still there |
| R17 | Project tier of memory | open, M | no scope on `MemoryRecord`; the boundary exists now (`Scope.chats`, `turn.ts` resolves it). First: `scope?` on the record + a third render block |
| R27 | Evidence attached to belief | open, M, design first | decay still by age × kind. First: `basis?: {path, hash}` rendered as "unverified" on mismatch, never "wrong" |
| R29 | Box has no MCP face | open, L, review first | nothing in `boxd` or `presets.ts` knows MCP; the tool-proxy design needs the docs/13 review before code |

Two things promoted out of residue, each its own entry now:

- **R38. MiniMax-M3 loses the `computer` tool schema after compaction** (found in the R37
  work, filed nowhere). A compaction/tool-schema defect: reproduce on a long turn, then decide
  whether the tool list rides the stable prefix or is re-sent after a summary. S–M.
- **R39. `hooks.json` needs its docs/10 entry.** It is arbitrary command execution from a
  mutable file in the state directory; who may write there and how the loading rule is
  enforced are unwritten. S.

**The order I would take**, after the handoff's five (auto-review week, a live listener,
conduct numbers, the prompt floor, the pre-launch security list): R8's rider and R24's stamp
(both S, both make the next investigation cheaper), R39, R28's ablation, R36's MCP reload,
R26's search path, then R25. R4, R16, R30, R29 wait for their designs; R17 and R27 wait for a
week of memory numbers. docs/30 Stage C (`TransferFile`) is paused at Chris's call.

## What to do next, as of 2026-09-01

The 2026-08-27 ranking below still holds for the tiers; what changed since is written
where it belongs rather than restated here:

- **docs/25** — the workbuddy program (E1–E5) is run and closed; the catalog (PR #14) is
  its shipped form.
- **docs/26** — inbound reliability: catch-up sweeps, durable dedup, watermarks. Open:
  the same for DingTalk, and the webhook-versus-websocket decision.
- **docs/27** — testing and release, audited against OpenClaw and Hermes. Open: a contract
  assertion per adapter, then tiering.
- **docs/reviews/2026-09-01-runtime-audit.md** — four fixes, two open items (skill-index
  budget; query-aware memory in continuations) and one design item that gates multi-user:
  provenance for skill files, because the scheduler reads writable content as
  configuration.
- **docs/28** — Grok Bot 0.30.0 re-analysed at source (app + the public box image);
  twelve ranked changes for us, from an auto-review classifier in shadow mode to
  greppable memory files. The full write-up and artifacts are archived outside the repo.
- **docs/handoff-2026-09-01.md** — the state of the running installation.

## What to do next, as of 2026-08-27

The previous version of this section ranked seven items and then, twice in the same
paragraph, deferred to "the structural choice". It has been rewritten rather than appended
to, because the obligation review changed the dependency order underneath three of them.

### Shipped since the last ranking

- **R23** (`f883d7f`), **R22** (`fe573a3`), **R1** the composer, **R18**'s remaining two
  thirds (`ccb0875`), **R19** the exec marker (`0d4fcba`).
- **R7's shippable half**: the reproducible scanner and the spool's three corrections. The
  detection half is measurably the wrong approach on our own records and the containment
  half moved to R4, so what is left under R7 is at-rest hygiene, correctly named.
- **The trace UI**, four attempts and one demand from the outside — verified against the
  running page rather than against its bytes. `scripts/ui-shot.mjs` is what that left behind.
- **docs/17**, the two-agent convention, written because there are two.
- **Board 三小件** (2026-08-27): the "看板" whole-message verb (the room's tasks grouped by
  what a person does about each state — see `board-view.ts`), the blocked-landing
  announcement (a task an agent parks speaks in its chat now instead of waiting for
  tomorrow's digest; the channel's own failure path stays silent because it already told
  the chat), and the title rewrite (`retitleTask` — the first line of a request is a
  request, not a name; the person's whole message is kept as the task's description before
  any rewrite). Answering, verbatim: "现在有各种 task,我都对应不上".

### A box says what it is (2026-08-28)

docs/18 v4 steps 1–3, shipped. A box carries a class in `config.boxes[name]`; absent means
`shared`, which is the honest default because every mechanism that would make a box private
is unbuilt. A shared box says so where the work happens — a permanent badge in the desktop
header, the sentence above the screen, a paragraph in the agent's own prompt — and it
labels rather than refuses, for the reasons in docs/18 §3.1. Attach mode also stopped
falling back to the local box's token, which had been sending this machine's box key to
whatever URL was configured.

This retires the finding below: the team box never promised anything about its screens, and
now it says so. Steps 4–8 (one session resolver, box lineage on agents, the takeover state,
private-box provisioning, revoke-and-wipe) are what private boxes cost and are unstarted.

### The team box cannot promise anything about its screens (2026-08-29)

Found while reviewing the identity-box design, but it is not about identity boxes — it is
true of the box running today. `docker/box/start-display` brings up Xvfb with **access
control off**, and the X socket directory is **1777** (`docker/box/Dockerfile`). Any
process in the container that can speak X11 or RFB reads any agent's screen without
touching a tool we control; `docker/box/vnc-probe` is an existing example, in Python, that
reads the whole framebuffer.

Consequences, in the order they matter:

1. **Do not describe the recordings as evidence of what happened.** Anything in the box
   can read the screen, and — separately — nothing binds a recording to the session it
   claims to be of. The private-deployment story leans on 可围观/可审计; that story is
   currently stronger than the mechanism.
2. Per-agent desktops are a convenience, not a boundary. Two agents in one box are not
   isolated from each other in any way an attacker would respect.
3. Fixing it means X access control on with per-desktop cookies, or one component owning
   the framebuffer — the same architecture question docs/18 v3 sidesteps by putting each
   person in their own container.

Not urgent for a single-user installation, where every agent is yours. It becomes
load-bearing the moment two people share a box, which is what docs/09 says a tenant is.

### Backlog notes from a Linux-CUA product teardown (2026-08-28, local research note)

Three liftable ideas, ranked; the teardown itself stays outside the repo.

- **Semantic agent cursor.** Render the agent's cursor with visible state (acting /
  delivering / targeting / idle) and a per-agent colour on the box display. Cheap, and it
  is the 可围观 story made literal: in noVNC and in recordings, a watcher reads intent at
  a glance. Prior art exists as a compositor-drawn overlay with a 12-state cursor theme.
- **AT-SPI click verification — the mechanical half R33 still lacks.** A grab-eaten
  synthetic click reports success by X11's rules; detection is behavioural today. The
  accessibility bus (AT-SPI) can read the target element's state before and after a
  click, turning "reported success, did nothing" into a checkable fact. Also the road to
  element-handle (not coordinate) targeting later.
- **Box toolbox for the hero scenario: officecli + local OCR.** The batch-reports user
  needs solid .docx/.xlsx/.pptx handling and scanned-PDF OCR in the box. Evaluate
  bundling `iOfficeAI/OfficeCLI` (single-file .NET CLI) and PaddleOCR-small as box CLIs,
  each taught by a SKILL.md — capability from bash, knowledge from the skill, exactly the
  knowledge/capability split adopted above. Prior art bundles both rather than rewriting.
- Confirmation, not an item: a major Linux desktop-CUA product pays for Wayland with a
  user-installed GNOME Shell extension (logout required), an unsupported KDE, and three
  compositor branches. X11-in-container avoids that entire class; our R33 was the cheap
  end of the trade.

### Backlog note: prefix stability audit — moot while the provider is MiniMax

Status check 2026-08-29: the installation runs MiniMax-M3 with **no prompt caching at
all** (the startup line says so), so there is no cached rate to protect and the audit
below measures nothing until the provider changes. Keep it in mind at the next
provider switch; the instrument (the spend table's cache-read column) is ready.

### Backlog note: prefix stability audit (from the Grok Bot teardown, 2026-08-27)

Two independent teams (Manus 2025-07, Cursor's Grok Bot 2026-08) converged on the same
constraint: the serialized tool array and the front of the system prompt must not change
across rounds, or every round pays full input price instead of the ~10× cached rate — and
an agent's cost is overwhelmingly input. Our channel prompt has grown sections lately
(progress.json convention, closing-message rule); if any dynamic value (timestamps, task
lists) sits early in the prompt, we pay the tax every round. We now have the instrument to
check: the spend table's cache-read column, over a few days of real traffic. Small audit,
not urgent, measurable before and after. The same teardown's knowledge/capability split is
the rule we already follow by instinct — a capability expressible through bash goes in the
prompt as a convention, not in the tools array — now adopted as an explicit test for every
"add a tool" impulse.

### ~~1. `workId` and `kind`~~ — shipped; this entry outlived its implementation

Verified 2026-08-29: `UsageRecord` carries `workId` (stable across resumes, minted or
inherited at `turn.ts:859`), `turnId`, `conversation`, `principal` and `kind`, all
written at the turn's record site and at `recordAside`, with `byKind` reporting and
tests in usage/spend. Found still-open by a backlog sweep whose only defect was this
stale entry. The original text follows for the reasoning it recorded.

### 1. `workId` and `kind`, on records already being written

**The next thing to build, and it is small.** One id allocated when work begins, unchanged
across every resume and continuation, written onto usage rows, turn records and task
changes. Plus `kind` on the usage row.

Why this and not something with a bigger name:

- **Everything downstream needs it.** The gate, the estimate, the drill-down and the
  heaviest-turn metric are all joins, and there is nothing to join on. `turnId` is minted
  fresh per attempt (`turn.ts:818`), so it is the wrong key by construction.
- **It is additive and reversible.** One write site for usage (`turn.ts:1433`), and nothing
  reads the field on the day it lands. Per docs/13 it does not need a hostile review first:
  it changes no completion semantics and no test's notion of correct.
- **The clock starts when it lands, not when it is designed.** `usage.jsonl` keeps 48 hours
  (`usage.ts:79`) and `kind` has never existed, so every day without this is a day of cost
  history that cannot be reconstructed afterwards.
- **`conversation` is already in scope at the write site** and costs nothing to add
  alongside. It does not solve task attribution — a task spans conversations and a
  conversation spans tasks — but it makes fork children costable immediately, which is the
  case the estimate cares about most.

### ~~2. R31, the admin view~~ — shipped; found built during the 2026-08-29 sweep

Another entry that outlived its implementation (workId's sibling). Verified live:
`GET /api/spend` serves day totals, per-task costing over the board's own run ids
(104 tasks costed on this installation), work-id and task drill-downs, a
hash-addressable modal UI, and honest caveats — including naming the unpriced
models. The one open half is *data*, not code: `rates` in config.json is empty,
so MiniMax-M3 and claude-opus-5 report tokens without money. Filling it is one
config block with real prices — a wrong rate being worse than no rate is the
view's own stated philosophy.

### 2 (original). R31, the admin view — now unblocked

It waited on the obligation ledger and no longer does. With the join key in place this is
assembly: the ledgers are append-only, replayable and on disk. A daily view, drill into one
task, its rounds, its artifacts, its tokens and its money.

Two things it needs that are not the join: **artifacts as a column** (shared with item 3
below, which is a second reason to record them) and **a rate table**, because "403,975
tokens" is a quantity nobody has intuition for.

### 3. Widen `stateHash` to artifacts

Independent of everything above and worth doing in parallel. `detectLoop` catches the honest
repeat and misses churn and oscillation entirely, because progress is defined by what was
*called* rather than by what *changed*. Files written, tasks settled, obligations closed.
Changes what a test asserts is correct, so it goes to review first.

### 4–6. The completion gate, three steps further out than the last plan claimed

In order, each reviewed before it is built:

4. **A dispatch record** — one id preallocated before the effect, shared by inbox admission,
   child attempt, transcript cause and usage. This is what the obligation ledger was
   reaching for. It also has to fix two things the review found underneath it: an inbox
   append failure currently warns and dispatches anyway (`inbox.ts:125`), and `appendLine`
   does not `fsync` (`jsonl.ts:44`), so "durably written before the effect" is not
   established even when the order is right.
5. **Attempt outcome separated from obligation resolution** — bounded retries with new
   attempt ids, and an explicit waiver from a named authority, both durable. This is the
   repair for the livelock that `failed`-as-unresolved reintroduced.
6. **The gate itself**, Dijkstra–Scholten-shaped, over records that exist by then.

**Honest statement of where this stands: nothing has been built.** The design has been
written twice and killed twice, and the second review found ten false claims about our own
code in it. What survives is item 1, which is a field.

### Then the structural choice, which is a product decision rather than a ranking

**The multi-person direction** — rooms, group-as-interface, task-as-state,
box-as-workstation. Everything under it is either a dependency of it or considerably easier
after it: R4's Scope growth, R16's webhooks, R17's project memory, R21's bundles. Two items
sit squarely on that path and did not before: **R25** (a conversation's identity, which is
the object a room is made of) and **R30** (coordination as protocol, which stops being
optional as the agent count grows).

This is the fork in the road. Items 1–3 are observability and correctness on what exists;
the multi-person work is a different product. They do not compete for the same week, and
item 1 is small enough that it does not have to be chosen against anything.

### Still open, still true

- **R28's cheapest third.** The suite passed the Seltz refusal by luck and has no way to
  keep it. The failure modes in docs/14 are already written down as prose; turning them into
  cases is mechanical.
- **The browser work has only met fixtures.** A real OAuth flow and a live payment iframe
  are where it will actually be tested, and neither has happened.
- **Two loops left open on purpose**, both waiting on the multi-person work rather than on
  effort: nothing listens for the "wait" that postpones an upgrade, and `ANNOUNCE_MINUTES`
  is a number nothing counts down.
- **Three candidates from reading, deliberately not promoted**, each needing a product
  decision rather than effort: compaction that keeps *why* a thing was decided; an inbound
  emoji reaction as a task trigger; and the briefing as a queue of decisions rather than a
  report of state — with the criterion the reading supplied, *you only want to know which
  agents need your attention*.

### Corrections carried forward

- An earlier count in docs/14 said `WebSearch` had never been called. It was called twice
  and refused twice — a grep for `web_search` against a tool named `WebSearch`, the same
  wrong-name failure that started that document.
- docs/16's first version claimed the usage ledger records every call attributed to a
  principal. It records the turn loop only, from one write site, with `principal` optional.

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
