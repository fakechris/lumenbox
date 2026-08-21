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
