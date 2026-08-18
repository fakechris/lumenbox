# agentbox

A multi-agent orchestrator with a remote Docker "box" and Linux computer-use.

This is an independent implementation of an architecture described in local research
notes, built around the three parts that make it interesting:

- **Multiple agents** that message each other asynchronously and decide among
  themselves who does what.
- **A remote Docker box**: the agents' computer is a container, which can live on
  another machine.
- **Linux computer-use**: a real X11 desktop driven by `xdotool`, captured with
  `ffmpeg`, and watchable over noVNC.

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
│  boxd :1337   computer / exec / fs                      │
│    └── X11Executor ──▶ xdotool, ffmpeg, xrandr, xmodmap  │
│  Xvfb :1 ──▶ xfwm4 ──▶ x11vnc ──▶ noVNC :6080            │
└─────────────────────────────────────────────────────────┘
```

The host never runs `xdotool` or `ffmpeg` itself. It decides; the box acts.

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

chat [agent] [message]    Talk to an agent; omit the message for a REPL
                          --no-box runs without the box tools
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

## Development

```bash
npm test           # 26 tests, no Docker or X server required
npm run typecheck
npm run build
```

The tests cover the parts where a mistake is silent in production: coordinate
scaling, `xrandr` parsing, WebP header patching, keycode-run bounds, and the bus
semantics (burst collapsing, serialization, priority interrupts, failure isolation,
and a two-agent exchange terminating).

## What this does not do

Documented rather than discovered later: no WebAuthn bridging into the box, no local
context compaction (the API's server-side compaction covers it), one shared display
rather than per-agent window forking, and no cron/routine wakes — though the bus
already has the wake primitive those would build on. See `IMPLEMENTATION_PLAN.md`.
