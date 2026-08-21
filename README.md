# lumenbox

A multi-agent orchestrator with a remote Docker "box" and Linux computer-use.
(The CLI and internal names still use the working name `agentbox`.)

This is an independent implementation of an architecture described in local research
notes, built around the three parts that make it interesting:

- **Multiple agents** that message each other asynchronously and decide among
  themselves who does what.
- **A remote Docker box**: the agents' computer is a container, which can live on
  another machine.
- **Linux computer-use**: a real X11 desktop driven by `xdotool`, captured with
  `ffmpeg`, and watchable over noVNC — **one desktop per agent**, so they never
  fight over focus and you can drive any of them while the others work.

## How it fits together

```
┌─────────────────────────────────────────────────────────┐
│ host (your machine)                                     │
│                                                         │
│  CLI ──▶ Orchestrator                                   │
│            ├── AgentRegistry   ~/.agentbox/agents/<id>/ │
│            │                     profile.json           │
│            │                     conversation.jsonl     │
│            │                     memory.md              │
│            ├── AgentBus        async delivery + wakes    │
│            │                   one turn per agent       │
│            └── turn loop ──▶ Anthropic API (streaming)   │
│                    │                                    │
└────────────────────┼────────────────────────────────────┘
                     │ HTTP + bearer token
                     ▼
┌─────────────────────────────────────────────────────────┐
│ box (Docker container — local or remote)                 │
│                                                         │
│  boxd :1337   computer / exec / fs / vnc proxy           │
│    └── one X11Executor per desktop                       │
│                                                          │
│  desktop :1   Xvfb ▸ xfwm4 ▸ pcmanfm ▸ x11vnc ▸ noVNC     │
│  desktop :2   Xvfb ▸ xfwm4 ▸ pcmanfm ▸ x11vnc ▸ noVNC     │
│  ...          created on demand, one per agent            │
└─────────────────────────────────────────────────────────┘
```

The host never runs `xdotool` or `ffmpeg` itself. It decides; the box acts.

Only boxd's port is published. It proxies each desktop's noVNC, so the number of
desktops is not capped by port mappings fixed at container-create time — and the
web UI reaches any of them through one stable path.

## Setup

Requires Node 22.18+ and a Docker engine.

```bash
npm install
npm run build          # builds the CLI and the daemon bundle the image needs
npm run agentbox -- box build
npm run agentbox -- box up
```

`box up` prints the noVNC URL. Open it to watch the agents work.

Credentials come from `ANTHROPIC_API_KEY`, or from an `ant auth login` profile.

```bash
npm run agentbox -- chat
```

That drops you into a REPL with a coordinator agent. Ask it to do something that
needs the desktop, or to bring in a teammate:

```
you: open example.com in chromium and tell me the headline
you: I need someone to own our release notes. Set them up and brief them.
```

## Other model providers

The Messages API is implemented by several vendors, so pointing agentbox elsewhere
is mostly a base URL and a key:

```bash
npm run agentbox -- providers                 # what is configured
npm run agentbox -- chat --provider minimax   # MiniMax-M3
```

What is *not* interchangeable is capability, and it does not fail loudly. A
compatible endpoint will accept a request containing something it does not
implement and return 200. MiniMax accepts `thinking`, `output_config.effort`, and
`cache_control` without complaint and implements none of them, so agentbox omits
them rather than leaving the behaviour to chance.

Vision is the sharp edge, and it varies **by model on the same endpoint**:

| Model | Screenshots | Notes |
|---|---|---|
| `MiniMax-M3` (default) | Reads them | Read a real 1280×800 WebP screenshot back correctly, so it gets the `computer` tool |
| `MiniMax-M2` | Accepted and discarded | Answers *"I'm unable to view the image"* while its thinking says *"no image is provided"* — HTTP 200 throughout |

So vision is resolved per model, and a model that cannot see is not given the
`computer` tool at all — its prompt says it has no screen and tells it not to
describe one, instead of handing it screenshots it would narrate from imagination.
`bash` and the file tools do not need sight and stay available, which is enough for
real work.

Verified end to end on M3: an agent wrote and ran a Python script in the box, read
a word off the desktop through the `computer` tool, and handed a task to a teammate
that the teammate completed on its own turn.

An unknown model is assumed blind, since that is the assumption whose failure is
visible. Override with `AGENTBOX_VISION=1` (or `0`) once you have checked — and do
check rather than trusting a model card: send a solid colour image and ask what
colour it is.

For any other endpoint:

```bash
export AGENTBOX_BASE_URL=https://your-endpoint/anthropic
export AGENTBOX_MODEL=your-model
export AGENTBOX_KEY_ENV=YOUR_KEY_VAR      # which env var holds the key
export AGENTBOX_AUTH=bearer               # or x-api-key
npm run agentbox -- chat --provider custom
```

Every optional capability defaults **off**, because a wrong "yes" fails silently
while a wrong "no" only costs a feature and says so. Opt in once you have checked:
`AGENTBOX_VISION=1`, `AGENTBOX_CACHING=1`, `AGENTBOX_THINKING=1`, `AGENTBOX_EFFORT=1`.

## Where the orchestrator runs

Two topologies, one image.

**Driven from outside** (`agentbox box up`) is the developer's shape: the box runs the
desktop and the daemon, and the orchestrator runs wherever your editor is. The turn loop
reaches the box over its published port.

**Self-contained** (`agentbox box up --with-host`) is the production shape: the
orchestrator runs inside the box too, reaching the daemon over loopback, and the only thing
outside the container is a browser. The web UI is published to `127.0.0.1:7777`, the
orchestrator's own state lives on its own volume, and nothing on the host machine runs any
of this code. Verified with no orchestrator process on the host at all: the UI answers, the
desktops proxy, and an agent ran a turn — shell, screenshot and transcript — entirely
inside the container.

That second shape is why the container has two users. `box` is the agent: its shell, its
desktop, its browser, and everything it creates has to be box-owned. `hostd` is the
orchestrator, so its transcripts, the desktop-owner tokens and the model credential are not
lying in the agent's home directory. The entrypoint runs as root only long enough to drop
privileges for each service.

Be exact about what the split buys: `box` has passwordless sudo, so an agent that decides
to read hostd's files can, and this was checked rather than assumed — a direct read gets
`Permission denied`, and `sudo cat` gets the file. What it removes is the accidental case,
and it puts the seam where it needs to be for the day the model credential moves behind a
relay and the boundary becomes real. Until then, running the orchestrator in the box means
the credential is in the box.

One consequence worth knowing: with the orchestrator inside, the owner tokens are inside
too, so `box shot` and the smoke test — which run out here — can no longer present a claim
for an agent's desktop. That is the right way round (the box holds its own secrets), and it
means the CLI is a tool for the developer topology.

## Where the box's traffic comes from

A box browses from its own address, which in a cluster is a datacentre one. Real sites treat
those differently — blocked, geofenced, or served a different page — and anything on the
user's own network is unreachable from a box entirely. `agentbox egress` runs a relay on this
machine, the box's browser goes through it, and the agent then appears on the network the user
actually has.

```
agentbox egress --allow example.com,*.internal.example.com
AGENTBOX_EGRESS_RELAY=host.docker.internal:8790 agentbox box up --recreate
```

The relay refuses to start without a token, because a relay without one is an open proxy on
whatever network it can reach. `--allow` is not decoration either: reaching the user's network
is the feature, and the user's network is exactly what an agent should not be able to sweep,
so a deployment says what it means. Empty means anywhere.

The obvious design is a WebSocket the client opens into the box, with streams multiplexed
inside it. This goes the other way — the box dials the relay, one
connection per stream — so there is no multiplexer, which is where this kind of code goes
wrong. The cost is a TCP setup per stream, which is what a proxy does anyway.

Two things worth knowing. Box-local addresses bypass the proxy on purpose, so boxd, noVNC and
anything an agent serves locally are not sent out to the relay and back. And there is no
fallback: with the proxy configured and the relay down, the browser gets
`ERR_INTERNET_DISCONNECTED` rather than quietly browsing from the box's own address — checked
with a fresh profile, because the first attempt at that check was reading Chromium's disk
cache.

## Who may drive the agents

The UI used to have no authentication, justified by binding loopback: anything able to reach
it can already drive the agents. That held while the orchestrator ran on someone's own
machine. It stopped holding when it moved into the box, where it binds 0.0.0.0 and only
Docker's publish address keeps it local — one flag, or a Kubernetes Service, and it is open.

So: a configured token is required, no token is allowed only on a loopback bind, and a
non-loopback bind with no token gets one generated and announced rather than being served
openly. `box up --with-host` generates one, persists it next to the box token so a recreate
does not invalidate an open tab, and prints the URL with it.

The mechanism is a cookie rather than a header, because of what the page loads. The desktop is
an iframe and a recording is a video element, and neither can carry an `Authorization` header —
a header-only scheme would protect the API and leave the screen open. A token in the query
string is accepted once to bootstrap the cookie, and the WebSocket upgrade carrying the screen
is checked the same way. `AGENTBOX_UI_TOKEN` or `web --token` set it for the topologies the CLI
does not start.

There is one secret and no users: whoever holds the token can drive every agent. That is the
right shape for one person's box and the wrong shape for a shared deployment, which needs
identities — the seam is here, not the implementation.

## Where the box comes from

The orchestrator needs two things about a box: a URL and a token. It does not need to know
the box is a Docker container — but that assumption had spread anyway, because the only way
to learn the URL was to ask the Docker CLI for a published port, so the turn loop and the
web UI both imported the Docker manager to answer a question that has nothing to do with
Docker.

A `BoxProvisioner` answers that question, and optionally owns the box's lifecycle:

| Kind | Selected by | Lifecycle |
| --- | --- | --- |
| `docker` | the default | creates, starts and stops the container |
| `attached` | `AGENTBOX_BOXD_URL` | none — the box is someone else's to run |
| `kubernetes` | not written yet | a pod from a broker, reached through a Service |

`attached` is what makes the core runnable with no Docker at all: point it at a box and the
turn loop, the tools and the web UI work unchanged. That is verified rather than assumed —
the whole smoke suite passes in a process with no `docker` on its `PATH`.

The reason to draw this line before there is a cluster to test against: in a centralised
deployment the boxes are pods created by a control plane, not containers created by a
laptop, and everything else in here — per-agent desktops, desktop ownership, recording,
supervision — is already independent of which of those it is. The Kubernetes provisioner is
a third file in `src/box/`, and nothing outside that directory has to change for it.

`box build`, `box up` and `box down` stay Docker-only, because they are Docker lifecycle.
With `AGENTBOX_BOXD_URL` set, starting and stopping the box is whoever runs it's job.

## Putting the box on another machine

The box lifecycle goes through the `docker` CLI, so anything Docker can target
works with no extra configuration:

```bash
export DOCKER_HOST=ssh://you@build-server
npm run agentbox -- box up
```

`agentbox` reads `DOCKER_HOST` to work out where published ports actually live, so
the daemon URL points at the remote host rather than your loopback. `docker context
use <name>` works the same way. Override the address explicitly with
`AGENTBOX_BOX_HOST` if your engine is reachable at a different name than its Docker
endpoint (a tunnel, say).

Two things to know before pointing this at a shared machine: the daemon's port is
published on the engine host, so anything that can route there can reach it, and the
bearer token is the only thing in the way. And the box gives its agent a shell with
`sudo`. The container is the security boundary — put nothing in it you would not hand
to the model.

## Commands

```
box build                 Build the box image
box up [--recreate]       Start the box, wait for the desktop
box status                Container state, ports, health, detected resolution
box down [--rm]           Stop (and optionally remove) the box
box logs [--tail N]       Container logs
box shot [file.webp]      Screenshot the box desktop
box exec <command>        Run a shell command in the box

agents                    List agents
agent new <name> [desc]   Create an agent

providers                 Which providers are configured, and what they can do
web [--port N]            Serve the web UI (default http://127.0.0.1:7777)
chat [agent] [message]    Talk to an agent; omit the message for a REPL
                          --no-box            run without the box tools
                          --provider <name>   anthropic | minimax | custom
                          --model <id>        override the model
where                     Print state directories
```

### Settings

Anything that changes per run is an environment variable — which provider, which model,
where the box is. Settings someone decides once live in a file instead, because
re-exporting a variable in every shell to hold a preference is the wrong shape for it.

`~/.agentbox/config.json`, written with its defaults the first time `web` starts:

```json
{
  "activityLimit": 400
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `activityLimit` | 400 | How many recent events the web UI keeps, so a page opened later still shows what the agents did. Not a record of the run — the transcripts on disk are that — so it is bounded, and older events are dropped first. |

The events themselves are in `~/.agentbox/activity.jsonl`, one per line with the time
they happened, so the feed survives a restart of the server and not just a reload of
the page. Delete the file to clear the feed.

### When something dies unwatched

PID 1 is `box-init` rather than tini, for one reason: only PID 1 sees an orphan die, and
tini reaped every one of them and discarded the status. Everything unsupervised in the box
dies as an orphan — a browser the agent started and abandoned, a binary it installed and ran,
a helper that setsid'd away from its parent — so a process crash-looping in here was
invisible. No log line, no counter, nothing to point at when the box "felt broken".

`box-init` does tini's job and keeps the answer: reap, name the process from a cache sampled
just before it died, and record one entry per (process, signal) per minute, so a crash loop
is one line with a count instead of thousands. `/health` carries the recent ones. It starts
and restarts nothing — supervision belongs to the entrypoint and to boxd, and a watcher that
also acted would be a second opinion about who owns a process.

Replacing tini is worth being careful with, and it earned that: it surfaced a latent bug in
the entrypoint's own signal trap. `kill 0` includes the sender, so with the handler still
installed the shell re-entered itself once per signal until bash blew its stack — an ordinary
`docker stop` exited 139. It had been masked for weeks by PID 1 sharing the process group.
The trap now ignores the signal for itself before signalling the group, and a stop takes two
seconds and exits 0.

### Who gets the CPU

A box shares one CPU allowance between two workloads that want different things: the
desktop, whose latency a person feels directly as "computer use is slow", and whatever the
agent is running, which is throughput work. They used to compete as equals, and the
difference is measurable — on twelve cores, with the agent saturating all of them, a
screenshot went from 185ms to 489ms.

So the agent's shell runs at `nice 19`, and everything it starts inherits that. The desktop
stack, the capture path and anything launched from the dock or a desktop icon stay at 0.
With the agent saturating the box, a screenshot is back to 189ms — nice costs the agent
nothing while the box is idle, because Linux hands spare time to whoever wants it, and hands
the desktop the CPU when it does not.

A browser the agent launches is behind the desktop too, which is the right way round: the
agent's browsing is throughput, a person's is what they are looking at, and clicking the
dock icon gets normal priority. Promoting an agent-launched browser would need
`CAP_SYS_NICE` — lowering a nice value is privileged, and `sudo renice` fails with
"Operation not permitted" even as root in here — and that capability also allows real-time
scheduling, which a runaway process could use to starve the host. Not worth it for a browser
that is slower while the agent compiles.

`AGENTBOX_CPUS` sets a container ceiling if a box shares a machine. Unset by default: the
split inside the box is what matters, and a wrong ceiling just makes the agent slow.

### Keeping it running

Both services in the box are supervised in place, with exponential backoff and a cap. The
container is not the unit worth recycling: the desktops, the browser sessions and whatever
an agent is in the middle of all live in it, so taking it down to recover one crashed
service destroys all of that. Measured before this existed — killing the orchestrator
exited the container and took every desktop with it. A service that cannot be kept alive at
all escalates to the container's restart policy, which is the bigger hammer.

A restart also has to work, which is less obvious than it sounds: a dead X server leaves
its lock behind, and Xvfb refuses to start on a display that looks taken, so a restarted
container came up with no desktop and gave up. `start-display` clears a stale lock when
nothing is serving the display.

Desktop components get the same treatment, one level down. boxd counts restarts per
component in a sliding window, backs off between attempts, and past a cap stops restarting
that component and says so in `/health` rather than hammering it. Old restarts age out, so
a box that was briefly broken heals itself.

The compositor is deliberately different: after repeated crashloop episodes it is disabled
for the life of the process, because a picom that keeps restarting redirects and repaints
the screen every time — smearing the wallpaper over window content — while a desktop with
no compositor merely loses the dock's translucency. "No compositor" beats "a compositor
that flaps". Verified by killing it in a loop: it ends up `disabled`, `/health` reports
`degraded`, and screenshots, VNC and the agent's tools all keep working without it.

### The desktop

Each display runs `Xvfb ▸ xfwm4 ▸ pcmanfm ▸ x11vnc ▸ noVNC`, brought up by
`start-display`, which is idempotent per component: re-running it starts only what is
missing. boxd re-runs it for every live desktop on a timer, so a component that crashes
comes back. That matters because the failure is one-sided — x11vnc dying leaves X and
the agent working normally while the user's screen goes dead and stays dead.

The apps a person actually touches are `xfce4-terminal` and `thunar`; `pcmanfm` only
draws the desktop and its icons, and `xterm` stays because the smoke test types into it.
A `plank` dock sits at the bottom with those three launchers, and `picom` composites so
the dock can be translucent rather than an opaque slab — X on its own has no way to blend
windows, since each one owns its pixels on the shared framebuffer.

Compositing forces one other setting: `x11vnc -noxdamage`. x11vnc normally learns what
changed from XDamage, and damage reported against the root window can miss a composited
repaint, which leaves the viewer on a stale frame while X, the agent and the screenshots
all look healthy. Polling the whole framebuffer avoids that; measured with a viewer
attached, it costs the same 2% of a core either way. `vnc-probe` speaks enough RFB to
prove frames are still arriving, and the smoke test runs it.

The clipboard bar under the desktop reads and writes the box's clipboard from outside it:
type something and press `→ box` to have it ready for a Ctrl+V in the desktop, or press
`← box` to pull out whatever is on the box's clipboard (and onto the host's, where the
browser permits it). Inside the box, agents use `box-clip copy` and `box-clip paste`.

`autocutsel` keeps X's two selections — PRIMARY, which middle-click pastes, and CLIPBOARD,
which Ctrl-V pastes — in step, so a copy in one application pastes into another and the
VNC clipboard carries what was actually copied. `xclip` is there for agents that want to
put something on the clipboard from a shell.

Chromium runs under a managed policy that turns off the "unsupported command-line flag"
infobar. The flag in question is `--no-sandbox`, which is deliberate: the container is the
security boundary, and giving Chromium's own sandbox what it needs would mean handing the
container `SYS_ADMIN` or an unconfined seccomp profile. The bar itself covers page content
and returns on every launch, so it is a thing an agent must notice and dismiss forever.

Two settings exist because of how the box is looked at rather than how it works. The
GTK3 file chooser is pre-seeded to 1100x680: unset, it opens at roughly 1124x822 on an
800px-high screen, putting Open and Cancel below the bottom edge where computer-use
cannot reach them, and GTK3 ignores `max-height` on a toplevel so there is no other
lever. And the cursor is set to 24px, because the X11 default is genuinely hard to find
over VNC.

### Windows

`list_windows` returns every window's id, title and geometry; `activate_window` raises one
and gives it focus; `screenshot_window` reads one window's own contents even while another
covers it. Without these the model had to find windows by eye, which fails exactly when it
matters — a dialog behind the browser is invisible in a screenshot, and a window it cannot
see it cannot decide to raise.

Reading a covered window works only because a compositor is running: every window then
renders into its own buffer, so an obscured one still has its pixels.

`click_in_window` completes the pair: a window capture is in the window's own coordinates,
so clicking those numbers on the screen would land somewhere else. It takes them as they
are, raises the window — a click goes to whatever is topmost at that point, whichever
window was meant — and translates. A point outside the window is refused rather than
clamped, because clamping turns "the model read the wrong image" into a mystery click.

### Whose desktop is whose

Each desktop is bound to the agent that owns it, and the box refuses computer or exec
requests for it that do not carry the matching token. This is not theoretical: an agent
with a shell could read `BOXD_TOKEN` from its own environment, name any display, and type
into another agent's screen — which it was demonstrated doing before this existed.

The tokens live on the host, in each agent's directory, and never enter the container.
That asymmetry is the design: host-side callers — the CLI, the web UI, the smoke test —
can always present the right claim, so a person is never locked out of their own box,
while an agent inside cannot produce a claim it was not given. `BOXD_TOKEN` is also
scrubbed from the environment the shell tool hands to commands.

It is an accident guard rather than a security boundary, and worth being clear about why:
agents share a filesystem by design, and the daemon's own `/proc` entry still carries the
token to anything running as the same user. What this removes is the silent case — one
agent quietly disturbing another's work with nothing in either transcript to show it.

### Recording the desktop

A transcript is the agent's account of what it did and a screenshot is one instant;
neither answers "what did it actually do" once the screen has moved on. The `record`
link in the desktop pane starts and stops a recording of the desktop being watched, and
finished files are listed beneath it — the browser plays them directly.

Files land in `/home/box/work/recordings/` on the work volume, so they outlive the
container. 12fps and CRF 30 by default, which is a few KB per second: this shares a CPU
with the agents' browser, and the point is reviewing what happened rather than producing
video. Fragmented MP4, flushed per packet, with a fragment closed every second — a
recorder that gets killed then leaves a file that still plays up to near where it
stopped, instead of an unplayable stub.

### What survives, and what does not

The container is disposable. `box up --recreate` — which is also what upgrading the
image means — throws away its filesystem, so two things that must not be thrown away
live on named volumes instead:

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `agentbox-box-work` | `/home/box/work` | What the agents made: files, notes, output |
| `agentbox-box-config` | `/home/box/.config` | What they logged into: browser profiles, cookies, CLI auth |

Everything else in the container is ephemeral on purpose, so a rebuilt image really
does deliver a fresh box. The config files the image ships — desktop launchers, the
libfm and pcmanfm settings — are re-seeded into the config volume on every start, or a
box created months ago would keep its own copies and never see a fix.

`box down --rm` removes the container but not the volumes. To discard the agents' work
as well: `docker volume rm agentbox-box-work agentbox-box-config`.

On the host, `~/.agentbox/` holds what the container never sees: each agent's
`profile.json`, `conversation.jsonl`, and `memory.md`, plus the box token, `config.json`
and `activity.jsonl`. Those are files on your disk and are unaffected by anything done
to the container.

The file is read once at startup and meant to be edited by hand, so it is read
defensively: a mistyped value falls back to the default and says so in the log rather
than stopping the UI, and unknown keys are ignored so a config written by a later
version still loads. `AGENTBOX_CONFIG` points somewhere else if you need it to.

## The agent model

Each agent is a directory. `profile.json` holds its name and persona, `memory.md`
holds what it chose to remember, `conversation.jsonl` is its transcript. Nothing is
hidden in a database: an agent can read a teammate's profile with the same `bash`
tool it uses for everything else, and so can you with an editor.

Messaging is asynchronous and fire-and-forget. `SendToAgent` delivers a message,
wakes the recipient, and returns an acknowledgement immediately — it never returns a
reply. A reply arrives later as its own message that wakes the sender on a fresh
turn. Because nothing blocks on a response, two agents cannot deadlock waiting for
each other, and the prompt tells them not to trade acknowledgements.

Each agent also gets its own desktop in the box — display `:1`, `:2`, and so on,
assigned at creation and recorded in `profile.json`. This is not tidiness: X
delivers synthetic input to whichever window holds focus, so agents sharing a
display type into each other's windows and screenshot each other's work, and a
human trying to use the screen competes with both. Separate displays make that
impossible rather than merely discouraged, and they are what lets you drive one
agent's desktop while the others keep working. Desktops start on an agent's first
turn, so a box with one active agent does not pay for the rest.

Turns are serialized per agent, so an agent's transcript and profile have exactly one
writer. A `priority` message aborts a running *background* turn so the agent can deal
with a stop-or-supersede instruction — but never a turn the user started, because
yanking that away mid-answer is worse than a few seconds of delay.

There is no router. Which agent handles what, and when to pull in a teammate, is
decided by the models through those tools. What looks like coordination at runtime is
emergent, not encoded.

## Notable implementation details

Most of these are the non-obvious parts — the places where the first try turned out to be
wrong:

- **Coordinate spaces.** Screenshots are scaled to a fixed 1280px width and the model
  works in that space; the box scales every coordinate up to the real framebuffer.
  Resolution is *detected* via `xrandr` at startup, never assumed — a wrong guess
  makes every click silently miss, so detection failure throws instead of falling
  back.
- **WebP header patching.** `ffmpeg` cannot seek in a pipe, so it writes the RIFF and
  VP8 chunk sizes as zero. The image data is fine but every decoder rejects the file.
  Both size fields get patched in memory before the screenshot goes anywhere.
- **Borrowed keycodes for unmapped characters.** `xdotool type` handles a character
  with no key by borrowing a spare keycode and handing it straight back, once per
  character — and an application resolving that keystroke against its stale keymap
  copy drops the character while `xdotool` still exits 0. That is how "Aprenderás"
  arrives as "Aprenders". Instead, every unmapped character in a run is bound up
  front, held for the whole run, and released after, with a settle delay on each side.
- **Settle before capture.** Actions that change the screen mark the batch as needing
  a pause before the final screenshot, so the model does not see a half-drawn frame.
  Typing plain text does not; committing a line does.
- **A window manager is not optional.** Without `xfwm4`, dialogs open unmapped and
  keyboard focus never lands, so typing silently goes nowhere.
- **Prompt caching.** Prompt sections are assembled in a fixed order with one cache
  breakpoint at the end of the system prompt, which covers the tool definitions too.
  Volatile content — the time, the inbound message — lives in the message turns,
  because a byte change in the prefix invalidates everything after it.

## Testing

Three layers, cheapest first.

### 1. Unit tests — no Docker, no X server, no API key

```bash
npm test        # 53 tests, a few seconds
npm run typecheck
```

Covers the parts where a mistake is silent in production: coordinate scaling,
`xrandr` parsing, WebP header patching, keycode-run bounds, shell session state,
the display lease, and the bus semantics (burst collapsing, turn serialization,
priority interrupts, failure isolation, and a two-agent exchange terminating).
The turn-loop tests stub the model, so they also check the wiring that would
otherwise only fail against the live API — that a `tool_use` block reaches
dispatch, that a screenshot returns as an image block, and that `SendToAgent`
really wakes the other agent.

### 2. Smoke test — needs the box, still no API key

```bash
npm run build
npm run agentbox -- box build     # first time only, ~10 min
npm run agentbox -- box up
npm run smoke
```

16 checks against the running container, covering everything unit tests cannot
reach: that screenshots decode as valid WebP with the patched size fields, that a
coordinate sent to the model's space lands where `xdotool getmouselocation` says
it should, that a failed action still returns a screenshot, that an injected
xdotool subcommand in a key name is refused, that `cd` and `export` persist per
agent and do not leak between agents, and that `Aprenderás café 日本語 ÁÉÍ`
arrives byte-perfect in a real application.

Run this after any change to the box image, the daemon, or the CUA layer — those
are the paths that fail quietly.

### 3. The web UI — for hand acceptance testing

```bash
npm run agentbox -- box up
npm run agentbox -- web --provider minimax     # or omit --provider for Claude
```

Then open http://127.0.0.1:7777. Three panes, deliberately: the CLI can show one
agent's turn, but what needs checking by hand is what a transcript cannot convey —
several agents working at once, one handing work to another, and the desktop
changing under them.

- **left** — agents, with a pulsing dot while one is inside a turn. `+` creates one.
- **middle** — the selected agent's conversation, streaming, with each tool call
  and its result inline. A screenshot appears as an image, so you can compare what
  the agent says it saw against what it actually saw.
- **right** — the live box desktop over noVNC, plus an activity feed covering *all*
  agents. `✉ Ada → Bob` lines are how you see delegation happen. Click the desktop
  to give it keyboard focus, or use *open full size* for a whole-window screen.

The desktop is proxied through this server at `/desktop/`, rather than linking to
the container's own port. Docker assigns that port ephemerally, so it changes on
every `box up --recreate` and an already-open tab would silently go blank. One
stable path avoids the whole problem, and keeps the iframe same-origin.

Binds to loopback only and has no authentication: anything that can reach the port
can already drive the agents, so keeping it off the network is the control.

#### An acceptance pass that exercises the real paths

Each of these fails in a different place, so a pass on all five is meaningful.
Verify the effects in the box (`box exec`), not just the agent's account of them —
an agent claiming success is exactly the failure mode worth testing for.

1. **Shell and files.** *"Create ~/work/primes.py that prints the first 10 primes,
   run it, and tell me the output."* Then `box exec 'cat ~/work/primes.py'`.
2. **Shell state.** *"cd into /tmp, then in a separate step tell me the working
   directory."* It must say `/tmp`; a stateless shell would say `/home/box`.
3. **Computer use.** Put something on screen first —
   `box exec 'DISPLAY=:1 setsid box-chrome --kiosk https://example.com &'` — then
   ask *"what text is on the screen?"* Watch it call `computer` in the middle pane,
   and check the screenshot it got matches the noVNC view on the right.
4. **Delegation.** *"Ask Bob with SendToAgent to write ~/work/note.txt containing
   OK, then tell me you asked."* You should see `✉ Ada → Bob` in the feed, Bob's
   dot light up, Bob take its own turn, and the file exist afterwards. Run this
   **twice** — the second round is where a fabricated "Done" used to appear.
5. **Display arbitration.** Ask two agents to use the browser at once. The second
   must be told the desktop is busy and offered other work, not interleave clicks
   with the first.

#### What "wrong" looks like

- An agent describes the screen with no `computer` call in the transcript — it is
  guessing. Check the middle pane for the tool row.
- A file the agent said it wrote is missing. Same class of problem.
- Two agents' keystrokes land in one window — the display lease is not holding.
- `box status` shows a display but screenshots are 1998 bytes every time — that is
  the blank-desktop size, so nothing is actually running on it.

### 4. The agent loop from the CLI — needs credentials

```bash
export ANTHROPIC_API_KEY=...      # or run `ant auth login`, or use --provider minimax
npm run agentbox -- chat
```

Open the desktop URL that `box up` printed in a browser first, so you can watch
what the agent does. Things worth trying:

```
open example.com in the browser and tell me the headline
create a python script in ~/work that prints the first 20 primes, then run it
I need someone to own release notes. Set them up and brief them.
```

The third one exercises the multi-agent path: it should create a teammate and
message it, and you should see `✉ Ada → <name>` in the transcript followed by
that agent taking its own turn.

To check the display lease with real agents, ask two of them to use the browser
at the same time — the second should be told the desktop is busy and given
something else to do, rather than silently interleaving its clicks with the
first's.

### Manual poking

```bash
node dist/cli.js box shot /tmp/screen.webp   # look at the desktop
node dist/cli.js box exec 'ls -la ~/work'    # run something in the box
node dist/cli.js box logs --tail 50          # daemon and desktop startup
node dist/cli.js agents                      # who exists
```

## What this does not do

Documented rather than discovered later: no WebAuthn bridging into the box, no
per-step checkpointing of a turn's side effects (an interrupted turn is resumed with
its last action marked *outcome unknown*, never replayed), and no cluster scheduling —
one box per tenant, one machine. The full boundary lives in `docs/01-requirements.md` §5.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
