# Architecture

## 1. Shape

Three parts, one contract between them.

```
┌──────────────────────────────┐        ┌───────────────────────────────────────────┐
│ Orchestrator                 │        │ Box (one container)                       │
│  turn loop                   │        │                                           │
│  agent bus                   │  HTTP  │  boxd ── desktop 1 ── Xvfb wm compositor  │
│  registry                    │ ─────► │   │        (agent A)   vnc novnc dock     │
│  provider                    │ bearer │   ├──── desktop 2 …                       │
│  web UI ──────► browser      │        │   ├──── shell sessions                    │
└──────────────────────────────┘        │   ├──── files, recordings, clipboard      │
         ▲                              │   └──── egress proxy ──┐                  │
         │                              └────────────────────────┼──────────────────┘
    Relay (user's network) ◄─────────────────────────────────────┘
```

The contract is **plain JSON over HTTP with a bearer token, plus one WebSocket for the
screen**. Everything else is an implementation detail on one side or the other. That is what
makes the orchestrator indifferent to whether the box is a local container, a container on
another machine, or a pod.

## 2. Components

| Component | Runs as | Owns |
| --- | --- | --- |
| **boxd** | `box` in the container | Desktops, input, capture, shell, files, recording, clipboard, egress proxy, health |
| **Orchestrator** | outside, or `hostd` in the container | Turn loop, tool dispatch, agent registry, messaging, prompts, transcripts |
| **Web UI** | with the orchestrator | The three panes, the desktop proxy, activity |
| **Relay** | on the user's machine | Opening the box's outbound connections from the user's network |
| **box-init** | PID 1 | Reaping orphans and recording how they died |
| **Entrypoint** | root, drops privileges | Bringing up desktops and supervising the services |

Inside the orchestrator, five things that are worth naming separately because each answers a
different question and each has its own failure mode:

| Part | Question it answers | Fails by |
| --- | --- | --- |
| **Compaction** | Does this conversation still fit? | Summarising away the objective, or refusing a turn that could have run |
| **Policy gate** | May this happen at all? | Refusing silently, or allowing because a check was added in one place and not another |
| **Memory** | What is still true from before? | Growing until it costs more than the conversation |
| **Skills + scheduler** | Has this been done before, and is it due? | Firing twice, or piling runs on each other |
| **Rememberer** | What did that exchange teach? | Inventing something on an exchange that taught nothing |

And outside the box, the control plane, whose defining property is what it does *not* do:

| Part | Owns |
| --- | --- |
| **Store** | Tenants, people, memberships, boxes, tokens, usage, health, audit |
| **Allocator** | Creating, finding, restarting and destroying a tenant's box |
| **Gateway** | Authenticating a person and proxying them to their box, credential withheld |
| **Collector** | Pulling health and usage out of every box |
| **Model relay** | Holding the provider key so no box has to, and measuring spend where it passes |

**The control plane is never in the path of a turn.** It allocates, authenticates, meters and
reaps; a running turn does not touch it, which is what lets it be restarted or briefly broken
without stopping work already happening. Anything that would put it in that path — proxying tool
calls, holding conversation state, brokering agent messages — is out of scope by design and not by
omission.

## 3. Topologies

The same image, two arrangements.

### 3.1 Driven from outside

The orchestrator runs where the developer's editor is; boxd is reached over the box's published
port. State lives in the user's home directory. This is the development shape, and the shape
the CLI is built for.

### 3.2 Self-contained

The orchestrator runs in the container as `hostd`, reaches boxd over loopback, and publishes
the UI. Nothing outside the container runs any of this code. State lives on a volume. This is
the shape a deployment uses, because the only thing a user needs is a browser.

Two users in the container, not one:

- `box` — the agent: its shell, desktop and browser. Everything it creates must be box-owned.
- `hostd` — the orchestrator: transcripts, desktop-owner tokens, the model credential.

The split keeps the orchestrator's state out of the agent's way. It is not a security
boundary: `box` has passwordless `sudo`, so an agent that goes looking can read `hostd`'s
files. The boundary is the container. The split exists so that the seam is already in the right
place for the day the model credential moves behind a relay.

## 4. Where a box comes from

The orchestrator needs a URL and a token. A **provisioner** answers that, and optionally owns
the box's lifecycle:

| Kind | Selected by | Lifecycle |
| --- | --- | --- |
| `docker` | default | creates, starts, stops a container |
| `attached` | `AGENTBOX_BOXD_URL` | none — someone else runs the box |
| `kubernetes` | not implemented | a pod from a control plane, reached through a Service |

`attached` is what proves the seam: the whole test suite and the entire UI run in a process
with no `docker` on its `PATH`.

## 5. Isolation model

Four boundaries, from strongest to weakest, and it matters that they are named in that order.

1. **The container.** The only real one. The agent has `sudo` inside it and is expected to
   install things. Nothing in the box should be anything its owner would not hand to the model.
2. **The desktop.** One X display per agent — separate server, separate window manager,
   separate compositor, separate VNC. Synthetic input is delivered by display, so two agents
   cannot type into each other's windows. Structural, not conventional.
3. **Desktop ownership.** A desktop is bound to an agent, and boxd refuses computer or exec
   requests for it that carry another agent's token. Tokens live outside the container. This
   prevents the accident, not a determined agent.
4. **Shell environment.** Credentials the agent has no use for are removed from the environment
   its commands inherit. Same class as (3).

## 6. Failure model

What is expected to fail, and what happens.

| Failure | Response |
| --- | --- |
| A desktop component dies | boxd restarts it on its next pass |
| A component dies repeatedly | Backed off, then abandoned and reported as degraded |
| The compositor flaps | Abandoned permanently; the desktop runs without it |
| boxd or the orchestrator dies | Restarted in place by the entrypoint, with backoff |
| Either cannot stay up | The container exits and the restart policy takes over |
| An unsupervised process dies | Recorded by PID 1, aggregated by signature |
| The box is unreachable | The turn loop reports it; agents keep reasoning without tools |
| The model API fails | The turn fails and says so; the transcript keeps what happened |
| The relay is down | The browser fails to connect rather than leaking direct |

The principle: **restart the smallest thing that can be restarted, abandon what cannot be
kept alive, and never recycle a container to recover a process.** The container holds the
desktops, the browser sessions and whatever an agent is in the middle of.

## 7. Seams left open

Named because a seam that is not named is a decision that gets made by accident. Four of the five
that were here have since been closed; they are listed as closed rather than deleted, because a
document that quietly loses its own open questions cannot be checked against.

**Closed:**

- ~~Identity~~ — people, memberships and three roles, with the session carrying all three
  ([09-tenancy.md](09-tenancy.md)).
- ~~Tenancy~~ — a tenant is a team, one box each, and the box is told which person is asking.
- ~~Credential custody~~ — the model relay holds the key and no box receives one
  ([08-control-plane.md](08-control-plane.md) §7).
- ~~Fleet telemetry~~ — the collector pulls health and usage into the store, with a cursor.

**Still open:**

- **Box provisioning beyond one host.** The allocator interface exists and `compose` is proven
  against real containers; the Kubernetes implementation does not exist and cannot be verified
  here.
- **Retrieval.** Memory recall and history search are lexical. The seam is one function
  (`selectRelevant`), and the falsifiable trigger for replacing it is written down
  ([05-data.md](05-data.md) §7).
- **Verification of an action's effect.** Provenance makes a claim checkable and nothing checks it.
  The reviewer agent can now read a colleague's history and reproduce a step, which is a person-
  shaped answer rather than a mechanism.
- **Anything on the person's own machine.** No local shell, filesystem or keychain. Three
  capabilities genuinely need it; each needs a local agent, which would be the largest attack
  surface here.
- **A second execution surface.** Everything visual goes through X11 and pixels. An accessibility-
  tree executor would be far more deterministic inside a browser at the cost of only working
  there, and is a second surface rather than a replacement.

## 8. Why these choices

**HTTP and JSON, not RPC.** Both ends are ours, there is no wire compatibility to preserve, and
every debugging tool speaks it. The one binary path — the screen — is a raw socket join after
an ordinary WebSocket handshake.

**A desktop per agent, not a window router.** Routing windows on a shared display leaves focus
contended, and focus is what synthetic input follows. Separate displays cost a few processes
each and make a whole class of corruption impossible.

**The filesystem as the database.** Agents are directories; conversations are append-only
files. The agent can read its teammates' profiles with the same shell it uses for everything
else, and so can a person with an editor. See [05-data.md](05-data.md) for what this costs.

**Polling capture, not damage tracking.** Screen capture reads the whole framebuffer; VNC
polls rather than trusting damage events. Under a compositor, damage misses composited
repaints, and the failure is a stale screen that looks healthy. Measured: the cost is not
distinguishable from zero.

**The agent's work runs behind the desktop.** One CPU allowance, two workloads: the desktop's
latency is felt directly, the agent's throughput is not. A nice value costs nothing while the
box is idle.
