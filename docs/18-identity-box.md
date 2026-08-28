# Identity boxes: a box that belongs to one person (v3)

Status: **design, replacing v1 and v2 — both rejected by adversarial review** (nine fatals,
then eleven, with zero of the first nine genuinely closed: see
[reviews/2026-08-28](reviews/2026-08-28-identity-box.md) and
[reviews/2026-08-29](reviews/2026-08-29-identity-box-v2.md)). v3 is not a refinement of
them. It removes the requirement that made them impossible.

## 0. The whole design

**An identity box is an ordinary box that belongs to one person.** Full desktop, full
browser, the same image the team box runs. What makes it an identity box is not what has
been taken out of it — it is who can reach it:

> **One box, one person. Nobody else, and no other person's agent, can reach it. The
> agents working in it know whose it is.**

That is the entire security claim, and unlike v1's and v2's it is a property of the
container boundary, which we have, rather than of a fence inside a container, which the
reviews proved we cannot build.

## 1. Why v1 and v2 failed, in one sentence

Both tried to protect a person **from their own agent**, inside the box, and every
mechanism for doing that was refuted:

- v1: "one `login_private` flag at the capture choke point." There is no choke point —
  x11vnc reads the framebuffer in its own process, the executor screenshots after every
  action batch, browser "snapshots" are CDP DOM reads that include input values, and a
  clipboard *write* contains a read.
- v2: "centralise, then prohibit the raw primitives." Refuted by a file already in this
  repository: `docker/box/vnc-probe` opens an RFB socket and reads the whole framebuffer
  in Python, spelling none of the prohibited strings. And the deeper reason it could never
  work — `start-display` runs Xvfb with **access control off** and the socket directory is
  **1777**, so any process that can speak X11 or RFB reads pixels. *The proposal enumerated
  spellings; the threat is authority.*

The mistake underneath both, stated plainly so it is not repeated: **each control was put
where it was convenient to write, not where the effect happens.** And the requirement
itself was imported, not chosen. Protecting a person from the agent that works for them is
a multi-tenant problem, and an identity box is single-tenant by definition.

The v2 attempt to escape by locking the browser down — no extensions, no devtools, no
`file:`, kiosk — was worse than the problem: it removed the capability the box exists for.
A browser an agent cannot really drive is not a smaller identity box, it is not one.

## 2. What container isolation gives, verified

Not asserted. Checked against the code and the running installation on 2026-08-29:

| Property | How | Status |
| --- | --- | --- |
| Separate storage | Volumes are named per container (`<name>-work`, `<name>-config`) | ✅ `src/box/docker.ts` |
| No privilege escape | No `--privileged`, no `--cap-add`, no docker socket mounted | ✅ `runArguments()` |
| Separate X, separate processes | A container per box | ✅ by construction |
| Daemon not reachable from the LAN | Published to `127.0.0.1` only | ✅ fixed 2026-08-28, verified from the LAN address |
| Desktop socket authenticated | boxd's WebSocket upgrade authorises before doing anything | ✅ fixed 2026-08-28, verified from a neighbour container (401) |
| **Its own key** | One token per container, legacy file readable only by the default box | ✅ fixed 2026-08-29 |

What container isolation does **not** give, and no version of this document should claim:

- **The host reaches every box.** It proxies the desktops; it holds every token. The host
  process is fully trusted and that is not a gap to close, it is where the trust lives.
- **A network path between containers may exist.** Measured on Docker 29/OrbStack:
  per-container networks do *not* isolate there. The boundary is the daemon's
  authentication, not the topology — which is why the token change above is load-bearing
  rather than tidy.

## 3. The two requirements that remain

The reviews' twenty findings collapse to these once the intra-container fence is dropped.
Both were fatal in v2 and both stay fatal here — they are now the whole design.

### 3.1 Only this person and their agents can reach this box

- **Its own token** (done). A key per box, so reaching one box is not reaching the fleet.
- **A signed principal session, checked identically on the HTTP page and the RFB upgrade.**
  Today `callerOf` treats an unauthenticated direct caller as owner, the role gate treats a
  missing `userId` as admin, and the WebSocket upgrade path does not read the web-session
  identity at all. In a single-user installation that is merely loose; the moment a second
  person has a box it means **anyone who reaches the port is everyone**. Review's words,
  still true: *reachability is not ownership.*
- **A route that names the box.** The desktop URL is `/desktop/<display>/` — a display
  index with no box in it. With two boxes there is nothing in the request that says which.

### 3.2 An agent, and its memory, belong to a box

The agent working in Chris's box learns things about Chris. Our memory is per *agent*
(`~/.agentbox/agents/<id>/memory.jsonl`), so the same agent working in two people's boxes
would carry one person's memory into the other's prompt — the exact failure a person
noticed in a competitor and asked about: *"a new bot already knew where I work."*

So: an agent belongs to one box, and its memory is written and read inside it. Not a
filter over a shared store — a filter is a rule someone can get wrong, and a directory that
is not there cannot leak.

## 4. Takeover login, without the architecture

The person logs in with their own hands on their own box's screen. What protects the
password is not a capture fence:

- **No turn is running.** An agent screenshots when it *calls the computer tool*. When it
  is blocked waiting for the person, it is calling nothing. This is free and it is most of
  the protection.
- **The recorder pauses.** One process, ours, started and stopped by us. A single
  controllable path, not an inventory that must be complete.

**The residual risk, stated so it is chosen rather than omitted:** the agents in your box
can see what is on your screen, including what you typed, because it is your box and they
work in it. If a turn is running while you type, that screen can reach a model provider.
This is the deal a person makes with a human assistant they hand their laptop to, and the
product should say so in those words rather than implying a guarantee the machinery does
not make.

Two consequences worth writing down rather than discovering: **do not put an agent on a
screen you would not show it**, and the archive of an identity box's config volume contains
that person's logins (`BACKUP_CARRIES` already says this for the team box; it becomes
per-person here).

## 5. What is left of the team box

Everything above is about identity boxes. The team box is a **shared** desktop and none of
it applies: any process there that can speak X11 or RFB reads any agent's screen, because
access control is off and the socket directory is 1777. That is true today, independent of
this design, and it means the team box is not an environment that can promise anything
about the content of its screens. It belongs in the security backlog on its own, and it
should not be described to a customer as if the recordings were tamper-evident.

## 6. Build order

1. **Signed principal session on both the page and the RFB upgrade**, and a desktop route
   that names `{principal, box, display}`. This is §3.1 and it is the only real gate.
2. **Provision a second box**, per person, with its own token and volumes. Mechanically
   this is `BoxManager` with a different container name — the machinery exists, the control
   plane already does it, the single-host path now mints per-box keys.
3. **Agents and memory scoped to a box** (§3.2).
4. **Recorder pause during login**, plus the visible red state, because a person should be
   able to see that it stopped rather than trust that it did.
5. **Task-scoped file transfer** between an identity box and the team box: a host-mediated
   copy of named files, logged. Not a mount.

No leases, no epochs, no capture inventory, no fencing protocol, no second image, no
browser policy. Those were the machinery of protecting a person from their own agent, and
that requirement is gone.

## 7. What this gives up, honestly

- **An agent that must use a login without being able to see the credential** is not
  possible here. Broker-shaped injection — the secret never enters the container, a
  placeholder is swapped at an egress proxy, which five independent systems converged on —
  remains the answer for that case, and it is a *different feature* for a different
  threat, not a phase of this one.
- **Revocation is coarse**: stop the box, rotate its token, or delete it. There is no
  mid-action fence, because there is no lease.
- **The person's own agent is trusted.** If that is wrong for a particular account, the
  answer is not to put that account in a box.
