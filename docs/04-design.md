# Design

The mechanisms, in enough detail to change them safely. Each section says what the thing does,
then the decision that is easy to get wrong.

## 1. The turn loop

A turn is: assemble a prompt, call the model, execute the tool calls it returns, append the
results, repeat until it stops asking for tools.

- **The round limit is 400 and it throws.** A limit that silently returns leaves the caller
  believing the work finished. 400 is high because a computer-use task legitimately runs long.
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
