# agentbox

A multi-agent orchestrator with a remote Docker "box" and Linux computer-use.

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

Documented rather than discovered later: no WebAuthn bridging into the box, no local
context compaction (the API's server-side compaction covers it), one shared display
rather than per-agent window forking, and no cron/routine wakes — though the bus
already has the wake primitive those would build on. See `IMPLEMENTATION_PLAN.md`.
