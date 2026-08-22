# Design

The mechanisms, in enough detail to change them safely. Each section says what the thing does,
then the decision that is easy to get wrong.

## 1. The turn loop

A turn is: assemble a prompt, call the model, execute the tool calls it returns, append the
results, repeat until it stops asking for tools.

- **The round limit is 400, and reaching it is a question rather than an answer.** A limit that
  silently returns leaves the caller believing the work finished; a limit that throws treats a
  task that was going fine identically to one stuck in a loop. So the last rounds are classified
  first — see §11.
- **Two cache breakpoints, not one.** The stable prefix (system prompt, roster) and the volatile
  part (conversation) are separated, so the prefix survives a conversation that grows.
- **Provider capabilities are declared, not assumed.** A compatible endpoint accepts a request
  containing a feature it does not implement and returns 200 with the feature ignored. Nothing
  surfaces at the HTTP layer, so the guard has to be in what is sent: vision, prompt caching,
  adaptive thinking and effort are per-provider flags, and vision is per-model.
- **Refusals are a stop reason, not an error.** The turn ends and says so.

## 2. Agent messaging

An agent sends to another and continues; the recipient wakes on its own turn.

- **Per-agent serialisation.** One turn at a time per agent, whatever wakes it — a user prompt
  and three teammate messages produce one turn each, in order, not four concurrent ones.
- **The wake loop drains.** Delivering a message to an agent whose turn is unwinding used to
  schedule work behind a guard the unwinding call still held, and the message was never
  consumed. The loop drains the queue rather than scheduling one item.
- **Priority interrupts only non-user-driven turns.** A person's request is not something a
  teammate may pre-empt.
- **The wake prompt is scaffolding, and is parsed back out for display.** What the model needs
  to be told (who sent this, that it is a peer, what to do about it) is not what a person
  should read. The parse takes the roster, because the format is flat and a message whose text
  contains `Note:` would otherwise look like a message from Note.

## 3. Computer use

### 3.1 Coordinates

The model works in a fixed API space, 1280 wide; the display may differ. One scaler converts,
in one place, and clicks derived from a screenshot land where the screenshot showed them.

### 3.2 Capture

`ffmpeg -f x11grab`, one frame, scaled to API space, encoded as lossless WebP tuned for text.

**The header patch.** ffmpeg cannot seek in a pipe, so it leaves the RIFF size at offset 4 and
the VP8 chunk size at offset 16 as zero. Every decoder rejects the file. The sizes are written
after capture. A layout that is not simple VP8 is left alone rather than guessed at.

### 3.3 Settle

2000ms between an action that changes the screen and a capture. Too short and the model sees a
half-rendered frame, concludes its click did nothing, and acts on that.

### 3.4 Typing

ASCII goes through `xdotool type`. Anything else has no keycode, so keycodes are borrowed:

- Bind each distinct unmapped character to a spare keycode up front.
- Write the keysym **twice** in the mapping, or the shift level makes `Á` arrive as `á`.
- Wait 300ms after mapping and after unmapping — the server and clients need to notice.
- Release the borrowed keycodes in a `finally`, or the keymap leaks.

### 3.5 Windows

`list_windows` returns id, title, geometry. `activate_window` raises and focuses.
`screenshot_window` captures a window's own pixels via `xwd`, which works while it is covered
because a compositor gives every window its own buffer. `click_in_window` takes coordinates in
the window's space, raises the window, and translates — a point outside the window is refused
rather than clamped, because clamping turns "the model read the wrong image" into a mystery
click.

**Raising is required before typing.** Synthetic input follows focus, not a window id.

### 3.6 Failure

A failed batch still returns a screenshot, after settling. The model goes blind exactly when
it most needs to see, otherwise.

## 4. Desktops

Per display N: Xvfb on `:N`, xfwm4 with its own compositing off, picom, autocutsel for both
selections, pcmanfm for icons, plank for the dock, x11vnc on 5900+N, websockify on 6080+N.
Only boxd's port is published; noVNC is proxied through it, so the number of desktops is not
fixed by port mappings chosen at create time.

Decisions:

- **`-noreset` and a stale-lock sweep.** A dead X server leaves a lock, and Xvfb refuses a
  display that looks taken — a restarted container came up with no desktop at all.
- **`xfwm4 --compositor=off` plus picom.** Two compositors fight and the screen goes black.
- **`x11vnc -noxdamage`.** With a compositor, damage against the root window misses composited
  repaints, and the viewer sits on a stale frame while everything else looks healthy.
- **One workspace.** xfwm4 defaults to four and switches on a scroll over the desktop; a stray
  wheel event swapped the screen for an empty one.
- **The compositor is checked semantically.** "Is a compositor serving this display" — the
  selection owner — not "is there a picom process": one that lost the selection lingers without
  compositing, and a process check reported it as running.

## 5. Supervision

Two levels, because the units are different.

**Services** (boxd, the orchestrator) are supervised by the entrypoint: restart in place with
exponential backoff, a cap that resets once a service has run long enough to count as having
worked, and escalation to the container's restart policy only when one cannot be kept alive.
The container is never recycled to recover a process.

**Desktop components** are supervised by boxd: restarts counted per component in a sliding
window, backoff between attempts, and past the cap the component is abandoned and reported in
`/health`. Restarts age out, so a briefly broken box heals itself. The compositor is abandoned
permanently after repeated episodes: one that keeps restarting repaints and redirects the
screen every time, while no compositor merely costs the dock its translucency.

**Crashes** are recorded by PID 1, which is the only thing that sees an orphan die, aggregated
by (process, signal) per minute so a crash loop is one line with a count.

## 6. Provenance

The transcript stores real `tool_use` and `tool_result` content blocks.

This replaced storing prose. With text only, a turn's history read as a request rather than as
work performed, so an agent would claim completion with the evidence invisible — and agents
learned to skip the work. The first fix made it worse: a synthesised "tools used" line taught
the model to write that line itself, with an invented success message. Only the real blocks
work, because they are the model's own protocol and it cannot forge them into the record.

Screenshots are stripped and noted (`[N screenshot(s) were attached…]`); the record would
otherwise be mostly base64. Orphan blocks are trimmed at the edges when history is replayed
into a request, since a tool result with no call is a protocol error.

## 7. Recording

`ffmpeg -f x11grab` continuous, H.264, 12fps, CRF 30, fragmented MP4.

- **Fragmented, flushed per packet, one-second fragments.** Fragmentation alone left a 28-byte
  file and "moov atom not found" when the encoder was killed: the output sat in ffmpeg's IO
  buffer and a fragment only closes on a keyframe. With both, a killed six-second recording
  leaves a playable three seconds.
- **Stopped with `q` on stdin**, escalating to SIGTERM then SIGKILL. Killing first truncates
  the last fragment for no reason.
- **12fps and CRF 30**, because this shares a CPU with the agent's browser and the purpose is
  review, not production.

## 8. Egress

An HTTP proxy on the box's loopback hands every connection to a relay outside, which opens it
from the user's network.

- **The box dials the relay, one connection per stream.** The reverse direction would need a
  multiplexer, which is where this kind of code goes wrong. Framing is a text preamble and then
  raw bytes.
- **The relay refuses to start without a token**, because a relay without one is an open proxy
  on whatever network it can reach.
- **An allow list of destinations**, because reaching the user's network is the feature and that
  network is what an agent should not be able to sweep.
- **Box-local addresses bypass the proxy**, or a loopback request would travel to the relay and
  back.
- **No fallback.** With the proxy configured and the relay down, the browser fails rather than
  quietly using the box's own address.

## 9. Access

The UI takes one shared token. Not configured plus a loopback bind is allowed; not configured
plus any other bind generates one and announces it.

**A cookie, not a header.** The desktop is an iframe and a recording is a video element, and
neither can carry an `Authorization` header — a header-only scheme protects the API and leaves
the screen open. A query token is accepted once to bootstrap the cookie, and the WebSocket
upgrade that carries the screen is checked the same way, because a browser sends cookies on an
upgrade but cannot set headers.

The token stays in the address bar after that first load, which it should not: it lands in
history and in anything that logs a referrer. See [07-review.md](07-review.md) R-04.

## 10. Priority

The agent's shell runs at `nice 19` and everything it starts inherits that; the desktop stack,
the capture path and anything launched from the dock stay at 0. Measured on twelve cores with
the agent saturating them: capture went 185ms idle, 489ms loaded, 189ms loaded with this.

Not cgroups: sub-cgroups need the cgroup tree delegated into the container, which means
privileged or a writable `/sys/fs/cgroup`. Promoting an agent-launched browser back to normal
priority would need `CAP_SYS_NICE`, which also allows real-time scheduling — a bad trade.

## 11. Finishing a long turn

Four mechanisms, all answering the same question — *why did this stop, and could it have kept
going?* — and each is only correct because of what it refuses to do.

**Compaction changes what is sent, never what is stored.** Over a threshold, the oldest entries
are replaced in the *request* by a summary; the transcript keeps every original. The cut must land
on a `blocks`/`results` pair boundary, because a tool call whose result was cut is a request the
provider rejects outright. Estimation is 2.5 characters per token — not the folklore 4, which
undercounted by 40% on tool-heavy conversations and made the trigger fire late. Images are counted
as images (~1600 tokens each). The window is *learned* from the provider's own usage numbers rather
than hard-coded per model.

Two additions the naive version lacked:

- **Pre-compaction in the background**, at 75% of the trigger, using a cheaper profile. Compacting
  at the moment of need means a person waits for a summariser in the middle of their turn.
- **In-turn image pruning**, which is a different problem: one computer-use turn can blow the
  window without any history at all. Only the newest screenshot is kept. It is safe where
  compaction is delicate because only tool-result *contents* change — the pairing cannot break.
  Measured: 94% of an eight-round computer-use request was images, 82% reduction.

**Transient failures are retried; permanent ones are not, and telling them apart is recursive.**
The signal is often three layers down an `error.cause` chain or inside an `AggregateError`. The
classifier collects *every* signal and lets permanent win — the earlier version returned the first
it found, so a permanent error wrapped in "connection closed" was retried four times. A stream that
produced no first token in 120s is a stall, not a slow answer. Backoff is equal-jitter, and a
server's `retry-after` is a floor, capped at 30s so a header cannot park a turn for an hour.

**Reaching the round limit is classified before it is reported.** If the last rounds repeat one
call signature with no state change, that is a loop and it is said so, with what repeated. If work
was still progressing, the turn continues in a fresh one — up to three times, each carrying a
prompt that says what has been done.

**A turn that ends with nothing to say says that.** The final message carrying no text used to
append nothing and emit nothing, which reaches a person as "nothing happened" when the truth is
"the model had no closing words". Two states, one representation — see [07-review.md](07-review.md).

## 12. Durable state: placement instead of protection

Plan, todos, skills and memory would each be a natural thing to write into the conversation. None
of them are. They live in the volatile system-prompt tier and are rebuilt from disk every turn,
which makes them *structurally* immune to compaction rather than protected from it by a rule
someone has to remember. Nothing needs to know they are special; there is no exemption list to
forget to add to.

The cost is that they must be small enough to re-send every turn, which is a useful discipline: it
is what forces memory onto a character budget and skills into an index rather than bodies.

## 13. Memory

Three kinds, because they decay at different rates and conflating them means either losing facts or
keeping chatter: `fact` (365 days, weight 1.0), `note` (30 days, 0.5) and `episode` (90 days, 1.5).
Recall scores by weight and recency and fills a **character** budget, not a count — ten short notes
and ten long ones cost very different amounts of the thing actually being spent.

- **Written both ways.** An agent can record something deliberately, and a cheap extraction pass
  runs every third exchange. Extraction is explicitly allowed to answer `NOTHING_TO_KEEP`, which
  is the whole difference between a memory that is useful and one full of "the user said hello".
- **Deduped on read, not on write.** Two near-identical facts recorded a month apart are both
  true; only one should occupy the budget.
- **Sharded by scope.** Personal memory is per-agent; a separate shared store is what lets one
  agent answer from something another learned.
- **The file is bounded, like every other durable log.** Past a threshold it is rewritten down to
  the live view — superseded records, retracted facts with their retractions, and lines no reader
  ever parsed all go; what stays keeps its bytes and timestamps, so the view and the decay do not
  move. Shared shards compact together: a retraction is only dropped once nothing it could kill
  remains on disk, so no crash between shard writes can resurrect a withdrawn fact.

## 14. Skills and schedules

A skill is a markdown file with frontmatter under `/home/box/work/skills/<slug>/SKILL.md`, written
by an agent and read by any agent. The prompt gets **the index only** — name, description, path.
Bodies are read on demand, because otherwise the fifth skill costs every turn whether or not it
applies.

- **Degrade where a guess is safe, refuse where it is not.** Unknown frontmatter keys are ignored,
  so a newer format does not break an older reader, and the parser itself is happy with a file that
  has no frontmatter at all. But a skill with no `description:` is *refused*, with a message naming
  the fix: the description is the only thing read when deciding whether a skill applies, so without
  one the skill would exist and never be chosen — the worst of both, and invisible to its author.
  Same rule as the schedule parser: something that means slightly the wrong thing is worse than
  something that did not load.
- **A `schedule:` key makes it an automation.** Minute resolution, ticking twice a minute so a busy
  loop cannot miss a window. **No catch-up** — two days of missed windows means "the daily report"
  arguably wants two runs and "check every hour" emphatically does not want forty-eight, and a cron
  expression cannot say which. **No overlap** — a skipped run is logged, because silence is
  indistinguishable from a schedule that stopped working.
- **A scheduled turn is told it was started by a timer.** An agent that believes someone is waiting
  asks clarifying questions nobody will answer, and hurries.

## 15. The policy gate

One decision point answers stop, budget, wake rate and approval, and it writes its audit row
*before* the action rather than after. Made one mechanism rather than four `if`s in four files —
which is also why it yielded a capability nobody planned: requiring a person's consent for a named
action.

**An approval fingerprint covers the exact text shown.** Fingerprinting a truncated description let
two commands sharing a 400-character prefix pass under one grant. An action too large to display is
refused, not truncated: consent to something nobody read is not consent.

## 16. Resuming an interrupted turn

An agent four hundred rounds into a task, killed by a restart or an OOM, used to leave its prompt
and its completed rounds in the transcript and simply stop. No error, no report, nothing that would
ever run again — the failure mode this whole system is meant not to have.

**The transcript is already the checkpoint.** Every completed round is appended as it happens, so
what a resumed turn needs is not "what did I do" — that is on disk — but "there was a turn here and
it did not end". A begin and an end record, so a begin with no end is a fact rather than a guess.
That is the entire mechanism; there is no separate snapshot to keep in step with anything.

**Nothing is re-executed.** A resumed turn is an ordinary turn whose opening message says what
happened, and the model reads its own history and decides. That is the only defensible choice while
a call and its result are separate appends: a crash between them leaves an action whose outcome is
genuinely unknown. Re-running it automatically would deploy twice; reporting it as failed would undo
work that succeeded. So it is described as *unknown*, in those words, with the instruction to look
before redoing — and the call that was in flight is deliberately kept in the request rather than
trimmed, because it is the one thing the agent needs in order to look.

**Resuming is bounded at two attempts.** A turn that ends the process will end it again; a crash
loop that restarts itself is worse than a task that stopped. After that the interruption is written
into the conversation, saying that the cause is probably in the work rather than in the machine and
that a person needs to look.

Ordering at startup: accepted-but-unstarted work first, then interrupted turns — a turn already
running is further along than a message only accepted, and they run in the order they are queued.

## 17. Two agents, one file (F10.3)

Every agent shares one `/home/box/work` as one uid. Two of them editing the same file is a lost
update — the ordinary one, not an agent-shaped novelty — and nothing could see it: the second write
won, silently, and the first agent went on believing its work was there.

Optimistic concurrency control, because that is what fits: conflicts between agents are rare and
re-reading is cheap. Each agent's last-seen version of each file is remembered; a write is refused
when the file is no longer that. Nothing is locked, so an agent alone in a file never learns this
exists.

Three decisions worth keeping:

- **Never read, and it already exists, is a conflict.** Overwriting a file you have not read is the
  same loss whether or not you knew about it.
- **Cannot check is not the same as checked.** A file too large to read whole has no version to
  compare, and letting that pass as "fine" is how the guarantee quietly stops applying to exactly
  the biggest files. It is refused, with the same deliberate flag as the way through.
- **Not persisted.** After a restart no agent has seen anything, so the first write to an existing
  file asks for a read first. The alternative is trusting a record of the world from before a gap in
  which anything could have happened.

**What it does not cover, stated rather than implied.** An agent with a shell can write the same
file with `sed -i` or a heredoc and nothing sees it — though the *next* tool write will, because the
comparison is against the file's real content rather than a record of who did what. So this turns
the both-used-the-tools case into a refusal, and the one-used-the-shell case into a refusal for the
other agent rather than a silent loss. It is not a lock and does not pretend to be one.

## 18. What a message from a teammate is allowed to be (F10.6)

An agent reads its teammates' messages, the pages it browses, the files it opens and the output of
the commands it runs. All of it arrives as text, and text can be phrased as an instruction. In a
fleet that matters more than it does for one agent: if instructions found in content are acted on
with the same weight as the user's, then one confused or compromised agent can direct the others.

The fix is not filtering — a message that has been rewritten is no longer the message, and the
agent needs to see what was actually said. It is telling the agent **where authority comes from**,
which is genuinely something it cannot work out from the outside:

- anyone here can send it a message, and the only thing establishing who sent one is a name in a
  string;
- a teammate has the same permissions and cannot grant more, cannot approve on the user's behalf,
  and cannot set aside what the user said;
- pages, files and command output are things it *found*, and no text anywhere grants permission.

That is a fact about this system, not advice about how to behave, which is the line this project
draws about what belongs in a prompt at all.

**A structural consequence.** All of that framing is written *above* the messages, and the messages
are last. The wake prompt is also parsed back out — a person reading a transcript should see what a
teammate said, not the scaffolding around it — and the format is flat, so "where do the messages
end" has no answer that survives a paragraph being added to the framing. Twice now, adding one
silently changed what a person saw. Messages last makes the boundary "from the first name onwards",
which nothing we add later can move.

## 19. Taking a piece of work (F10.2)

Two agents told to do the same thing both do it. Not a communication failure, and not fixable by
asking them to coordinate: it is the absence of a claim. Everything else here has one — a box has a
tenant, a desktop has an owner, a file has a version — and the work itself did not.

**A lease, not a lock.** A claim expires. An agent that dies holding one would otherwise park that
work permanently, turning a single failure into a lasting one, and there is no way to tell "still
working" from "gone" except by asking — which is what expiry does implicitly. Still working means
claiming again, which costs nothing and moves the clock.

**Expiry is computed on read.** Nothing has to be running for a claim to lapse, which is the
property that matters when the thing that stopped running is the process that held it.

**Advisory, and said so.** Nothing forces an agent to claim before working. This makes duplicate
work visible and refusable, not impossible — and the matching is on words, so two agents describing
one task differently will not collide. Nothing textual can fix that, and pretending otherwise would
be the failure the mechanism exists to avoid.

## 20. What an agent may do, as opposed to what it is asked to do

The starter team used to differ only in its descriptions: four agents with identical tools, which is
a division of tone rather than of labour. It is also the criterion by which a multi-agent design is
judged worth having at all — different tools, different permissions — and the one this system most
clearly failed.

Tools are now part of the profile, and withheld rather than refused: a tool an agent may not use is
not in its prompt. Offering it and rejecting the call spends a round, teaches the model its tool list
is not true, and produces a refusal somebody then has to explain.

The divisions are deliberately few, because a restriction nobody can justify is worse than none:

- **Only the coordinator builds the team.** `CreateAgent` and `UpdateAgent` belong to the one agent
  whose description is about deciding who should exist.
- **The reviewer is not offered `write_file`.** The failure this discourages is not dishonesty; it is
  that "fixed it" and "checked it" become the same act and nobody can tell afterwards which happened.
  It is discouragement, not a wall: the reviewer keeps `bash` — reproducing a step is its whole job
  and reproducing means running — and `sed -i` or a heredoc through `bash` can still write. Removing
  the natural tool makes writing a deliberate shell act rather than an accident, which is the same
  accident-prevention line the whole tool-division draws. A reviewer determined to rewrite the work
  can; the point is that it will not do so by reflex.

**An agent cannot widen its own set.** `UpdateAgent` never touched tools, and `CreateAgent` now
passes the creator's set down — otherwise an agent that may not write creates one that may and asks
it to write, and the restriction was only a longer path. This is the same rule as a teammate's
message carrying no authority: nothing here can grant what the granter does not hold.

An allowlist fails closed, which is the right direction for a restriction and the wrong one for
discovery: adding a tool would silently withhold it from three of four agents. So a test asserts the
coordinator's list covers every tool that exists, which makes adding one a decision rather than an
omission.

## 21. Choosing which memories are dropped

Recall scores by weight and recency and fills a character budget. When everything fits, that is the
whole story and it is fine: nothing is being decided, because nothing is being left out.

When it does not fit, the score is deciding something it is not qualified to decide — the newest
memory is not the one that bears on the question. So at that point, and only at that point, a cheap
model call reads the candidates and the current message and says which ones matter.

The gate is the design. `docs/05-data.md` §7 committed to lexical recall until there was evidence it
was failing, and "the budget is dropping memories" is that evidence rather than an impression. Below
the budget no call is made, which is almost always. Above it, one small call decides which of the
things that were going to be discarded should not be.

Three properties it has to have, each of which is a way it could go wrong:

- **Failing changes nothing.** Any error, or an answer that cannot be read, falls back to the score.
  It improves which memories are dropped; it is never why a turn did not happen.
- **Choosing none is a decision, and different from failing.** An empty selection is respected; an
  unparseable answer is not read as "none".
- **The prompt says padding is worse than omitting.** An irrelevant memory in front of an agent is
  worse than a missing one, because it will be treated as relevant.

## 22. The prompt's sections, named and ordered

The system prompt is assembled from named sections in a declared order, split across two tiers with
a cache breakpoint between them. Anything that changes per turn belongs in the volatile tier; put it
in the stable one and the cached prefix is invalidated every turn, at a cost that is invisible and
continuous.

The order is the part worth writing down, because it is the part that gets changed by accident —
sections are appended by whoever adds one, and "wherever it landed" is not a reason:

`plan → memory → skills → history → shared-memory → team`

An agent meets its own objective before its background; put memory first and the objective arrives
as a footnote to a pile of facts. Skills come after memory because a recipe is only worth reaching
for once the situation is understood. Shared memory comes after its own, because "I learned this"
and "a colleague thought everyone needed this" are different claims and the weaker one goes second.
The roster is last: delegation is a decision made after the work is understood, not a lens for
reading it.

**A section with nothing to say is left out — unless its emptiness is worth saying.** Most are
omitted when empty: an empty heading costs the same as a full one and tells the model there is a
category it ought to have something in. Memory is the exception, because an agent that has kept
nothing has to be told the capability exists or it never starts.

The rendering functions themselves live with the things they render — `durable.ts`, `memory.ts`,
`skills.ts`, `history.ts` — which is where the separation already was. What this adds is the names,
the order, and one place that states why.

## 23. Conversations: context belongs to the room it happened in

A transcript used to be per-agent, so two groups messaging the same agent read each
other's context. Now every agent has a **main conversation** — the team room the web
page, teammates, the scheduler and resume prompts share — and one thread per outside
chat, keyed by the chat's identity. The main conversation keeps the original
`conversation.jsonl` filename, so every install that predates conversations wakes up
with its history exactly where it was.

The bus serializes per (agent, conversation) and runs different conversations of one
agent **concurrently**: a long team-room task does not block a quick question from a
chat thread. Three things are keyed per conversation so concurrent workers cannot
clobber each other: the shell session (each thread keeps its own cwd and env), and the
plan and todo files. The one shared resource is the screen — an agent has a single
desktop and the operator watches the team room's — so the desktop tool is offered only
in the main conversation; side threads work headless, which is exactly what lets them
run alongside the room. Turn events, the resume ledger and speculative compaction
summaries all carry their conversation, so a resume lands in the thread it left and a
page viewing one thread ignores the stream of another.

## 24. People

A person used to be a bearer token. Now they are a Principal: a named subject with a
role — **viewer** reads, **driver** commands agents, **admin** also changes what the
system is — and a stable id that several channel identities (a personal phone, a work
account) resolve to, so one person's history and spend are one person's. An unknown
identity resolves to a viewer named after itself: a fresh install works and is safe
before anyone is configured. The file is 0600 because it is the access-control list.
Spend is attributed to the principal who drove the turn; work nobody drove — a wake, a
scheduled run — is grouped separately so the parts still sum to the whole.

## 25. The task board

Work that outlives one reply becomes a Task: title, assignee, status
(open/doing/blocked/review/done/dropped), and a history of who moved it, when, in
which turn — the turn id on every agent-made change is what links a board movement
back to the transcript that is its evidence. Ids are small numbers people can say in
chat, and a counter marker survives compaction so an id never means two things.

The board is advisory like claims, with one enforced exception: **when a task names a
reviewer, its assignee cannot move it to done** — the attempt lands in `review` with a
note saying so. A gate the worker can wave itself through is decoration; everything
else is visible rather than impossible, the same trust model as the rest of the
system. Agents hold one tool (create/take/update/list) and see their own live tasks in
every prompt beside the plan, because a board nobody re-reads is a board nobody works
from.

## 26. The credential vault

A secret is a named value with grants: holder (`agent:<id>`, `principal:<id>`, or
`*`), optional expiry. Resolution hands back a value only when a live grant covers the
caller, and every resolution — allowed or refused — is audited, because a credential
whose use leaves no trace is the thing an audit exists to prevent. An expired or
unreadable expiry is dead, which is the safe direction. No read path returns a value;
a list shows names, descriptions and grants.

Delivery is coupled to host execution on purpose: a granted secret enters exactly one
host command's environment on the operator's machine and never enters the box, never
a file, never the prompt. A secret an agent needs *inside* the box cannot be kept out
of it by definition, and the vault refuses that case rather than leaking into it.

## 27. The door out of the box

`RunOnHost` is the one way an agent reaches the machine the orchestrator runs on: a
USB device, a desktop automation script, a CLI installed on the host. It is off by
default, and off means the tool is **absent** — not offered and refused — so an agent
on a box without it never learns it might have asked. On, every host command still
pauses for a person to approve the exact text, by construction rather than by a
configurable list an operator might leave empty. Commands run under a directory the
operator chose (no default: a default would be this code choosing what an agent may
reach), through the login shell, as a single shell argument so a filename with a
space is data. Not a security boundary — an approved command runs with the
orchestrator's privileges, which is the point of approving it — but an accident
boundary and an audit trail.

## 28. Chat channels

A channel is a front door, not a second product: one message in, the addressed agent
runs an ordinary turn through the ordinary gates, and what it said goes back as the
reply. Closed by default — a bot handle is discoverable, and an unauthorised sender is
told exactly one thing: their own `channel:id`, which is the string an admin needs to
add them as a person. Permission belongs to the person (their role); context belongs
to the room (each chat is its own conversation). An approval that pauses a
channel-driven turn is pushed back to whoever asked, because the person on the phone
is exactly the person not looking at the page.

## 29. The turn engine, hardened

Four properties added after a comparative review of durable-harness practice:

- **Truncation honesty.** A `max_tokens` stop with output far below the cap this code
  sent is a response the context squeezed, not an answer. It is discarded — a tool
  call cut mid-JSON is not evidence — and the round sheds and retries under the same
  bounded counter as a rejected request. Its cost is recorded *before* that
  classification runs, an ordering that is now load-bearing: spend must not vanish
  with a response we chose to throw away.
- **The race catalog.** Every check-then-act across an await boundary has its two
  legal histories stated in a test that forces both orders with a gated turn runner.
  The catalog is the contract: the next concurrency change breaks a named test, not a
  user.
- **Mid-turn steering.** The user's queued messages for a conversation are consumed at
  the running turn's next round boundary, mid-task, with the work intact. Only the
  user's own messages steer; a teammate's message keeps its own turn and causal
  record, and scheduled or resume kickoffs are exempt so their reports are never
  buried inside an unrelated reply.
- **Safe replay on resume.** The transcript's tool_use block is already the durable
  record of a call — nothing mutates arguments between the model and the tool — so a
  resumed turn re-executes interrupted *pure reads* from the block alone, marked as
  re-run so a second resume does nothing twice. Everything with a side effect keeps
  the honest "outcome unknown" treatment.

## 30. Scopes: authority as one named object

An agent's power was scattered — a tool allowlist on its profile, secret grants in the
vault, an egress list on the relay, a work directory in the box — and lining them up by
hand for "this agent, on the vendor project" was several edits that could disagree. A
**Scope** binds them into one named object that agents are placed into: name it once,
add a secret or narrow the tools, and everyone in the scope moves together; remove an
agent from the scope and it loses all of the scope's authority at once. This is the
vault's Grant grown up — a grant answered "may this holder use this one secret", a
scope answers "what may an agent in this project reach at all", and a secret grant is
now one line of it.

Two facets are enforced today. **Tools**: a scoped agent's offered tools are the
scope's list, replacing the profile's own, because an agent in a scope is defined by
it. **Secrets**: `RunOnHost` resolves a secret the caller's scope lists, audited as a
scope grant exactly as a direct vault grant is — the vault still owns the value, the
scope owns the authorization. Two facets are declared but not yet enforced —
`egressHosts` and `filesRoot` — because the relay's allow list and the box's work
directory are global infrastructure whose per-scope enforcement is a box-protocol
change of its own; the fields are here so that change has a place to read from and no
migration when it lands. `scopes.json` is 0600, because a scope names secrets and is
the shape of who-may-do-what.

## 31. Provider per agent

Agent identity and runtime are separate: an agent may name its own provider preset and
model, and the reviewer can run a bigger model than the tidy-up agent without either
knowing. Absent, an agent runs on the installation's default. The selection is a pure
function (`effectiveProviderFor`) so it is testable without a credential; the
orchestrator caches one client per distinct provider shape, because building one per
turn would be waste. A per-agent provider whose credential is missing is *not*
silently fallen back to the default — that is the exact silent-model-swap the config
work fixed — so the turn fails with the clear message `createClient` already throws.

## 32. Per-person spend caps

The box budget (`AGENTBOX_BUDGET_TOKENS`) caps everyone together; a run can be under it
and still be one person spending everything. A per-person cap
(`AGENTBOX_PRINCIPAL_BUDGET_TOKENS`) turns the spend attribution of §24 into control:
"no one channel user gets more than X in the window". The model-call gate carries the
driving principal, and refuses on their behalf when their own windowed spend is at or
over the cap — while the same box, and every other person on it, is unaffected. Work
nobody drove (a wake, a scheduled run) has no principal and is subject only to the box
budget. Configured the same way the box budget is: an environment variable, or the
config file's env map.
