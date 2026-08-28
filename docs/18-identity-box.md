# Boxes that say what they are (v4)

Status: **design, fourth version.** v1 and v2 were rejected (nine fatals, then eleven,
none closed). v3 was rejected with six — but for the first time three problems were
**genuinely closed**, one of them "closed by architecture removal", so the direction is
right and this version continues it rather than restarting.

Reviews: [v1](reviews/2026-08-28-identity-box.md),
[v2](reviews/2026-08-29-identity-box-v2.md), [v3](reviews/2026-08-29-identity-box-v3.md).

## 0. The idea

Every earlier version tried to give one kind of box a privacy property it could not have.
v4 stops doing that. Instead:

> **A box declares what it is, and what it promises follows from that.**
>
> - A **private box** belongs to one person. Login state lives here. Everything inside it
>   is trusted with that person's data — including the agents, the model provider, and any
>   process in the container.
> - A **shared box** belongs to a group, a tenant, or everyone. It promises **nothing**
>   about privacy between the people who can reach it, and it says so where they can read
>   it. Nothing is forbidden there; it is simply not private, and it never pretends to be.

The second class is not a lesser box; it is the honest name for the box we already run.
`docs/09` reached the same conclusion one level down and said it plainly: *"a private agent
is not a security boundary… a real boundary between two people means two tenants and two
boxes."* v4 raises that from agents to boxes and puts it in front of the person.

**Why this unlocks the design.** v3's reviewer offered a choice for the login problem:
build a box-wide fail-closed fence over every turn, schedule, agent, VNC path and recorder
— *or* stop promising privacy there at all. Two classes let us take **one answer per class**
instead of one answer for both: the fence in a private box, where it is achievable because
it only has to close the ordinary paths for one window; and in a shared box, no promise and
a permanent label, because the alternative — enforcement — is not achievable in an open
system and the attempt makes it worse (§3.1).

## 1. The two classes

| | **Private** | **Shared** |
| --- | --- | --- |
| Access | one principal | a group, the tenant, or everyone |
| Login state | expected; the point of the box | **persists like anywhere else, and is visible to everyone with access.** Not wiped: agents log into things to do their work, and a box that silently forgot would break that. The label says who else can see it |
| Typing a password on its screen | supported, behind the takeover state (§3) | **not refused — labelled.** See §3.1: refusing is not achievable and the attempt would be self-defeating |
| Recording | pauses during takeover | ordinary |
| Between the people who can reach it | not applicable — there is one | **no boundary at all**, stated: shell, filesystem, screens and archives are common |
| Reassignment | revoke-and-wipe (§4) | membership change only |

A box's class is a property of the box, recorded with it, not a setting on a page nobody
reads. It is rendered wherever somebody is working in the box, permanently — see §3.1 for
why permanent rather than at the moment it matters.

**Today's box is shared.** Saying that is the whole of what has to change for it to be
honest — no new mechanism, and it retires the finding that the team box "cannot promise
anything about its screens": it never promised, and now it says so.

## 2. What is verified, what is default, what is work

The v3 reviewer's most useful correction: a *default* is not an *invariant*, and the table
had them mixed. Corrected, as of 2026-08-29:

| Property | Status |
| --- | --- |
| Volumes are per container | **Invariant** — named from the container (`src/box/docker.ts`) |
| No `--privileged`, `--cap-add`, docker socket | **Invariant** in the managed launcher |
| Daemon published to loopback | **Default, and the deviation is loud** — `AGENTBOX_BOXD_PUBLISH_ADDRESS` still reopens it, but publishing anywhere but loopback now warns with what it exposes. Still not an invariant: an escape hatch that warns is an escape hatch |
| boxd desktop upgrade authenticated | **Closed** for the host hop (`src/boxd/main.ts`, test at `src/boxd/upgrade-auth.test.ts`) |
| One token per box | **Closed** — attach mode no longer falls back to the local box's key (it was sending this machine's box token to whatever URL was configured); `AGENTBOX_TOKEN` still overrides globally, and now says so out loud when it does |
| Archives carry logins | **True and now said** (`BACKUP_CARRIES`); authorization and deletion of archives are undesigned |
| Container-to-container network isolation | **Does not hold** on Docker 29/OrbStack, measured. The boundary is the daemon's authentication, not the topology |

Both "partial" rows are closed as of 2026-08-28 (step 1 below); the private-box claim
rested on them.

## 3. The takeover state — the one fence, and only for private boxes

v3 claimed password protection was nearly free because "the agent is blocked waiting". That
was wrong and I found it before the review did: `AskUser` **ends the turn** (it returns
"Your turn ends here"), so the agent is not blocked — the slot is *free*, and the reviewer
enumerated what can walk into it: a scheduled routine (now agent-authorable), the audit
reviewer, a second conversation for the same agent (the bus's exclusivity key is
agent-plus-conversation), a display lease that is re-entrant by agent id and knows nothing
about a human being present, and a recorder that has **no pause operation at all**.

So: **one box-wide state, fail-closed, consulted at every admission point.**

- Turn admission (foreground, background, scheduled, audit)
- The scheduler, before it fires
- Display lease acquisition
- The computer service, before executing a batch
- The VNC upgrade, for anyone who is not the owner
- The recorder, which needs a real pause/resume (today it can only start and stop, and an
  ffmpeg it started can outlive the daemon)

**Why this one is buildable when v1's and v2's were not.** Those had to catch *every* path
that could turn the framebuffer into bytes, and could not: X access control is off, the
socket directory is 1777, and `docker/box/vnc-probe` reads the whole framebuffer in Python
without touching anything we control. This fence does not try. It closes the **ordinary**
paths for the **duration of a window**, and the residual — an agent that deliberately runs
its own reader — is accepted, because in a private box that agent is yours. A check point,
not an inventory.

### 3.1 A shared box labels; it does not refuse

An earlier draft of this document said a shared box would "refuse secret entry". It cannot,
and trying would be worse than not trying.

**It cannot.** A person types through noVNC into X, into whatever is focused. To refuse
password entry we would have to either parse RFB key events — building a keylogger in order
to prevent keylogging, which defeats its own purpose — or watch for a focused password field
over CDP, which sees only our browser, misses the terminal, misses every other application,
and misses paste entirely.

**And trying would be worse.** A guard that fires only when we happen to be looking teaches
people to rely on it, and then does not fire. **An intermittent warning is worse than a
permanent label**, because the label is true every time somebody looks at it.

This is the same lesson as the capture fences that killed v1 and v2, arriving from the other
direction: this is an open system by design — a real desktop, a real shell, a real browser —
and enforcement inside it has holes everywhere. Building a permission system able to close
them would cost more complexity than the product it is protecting. So a shared box states
what it is, persistently and where the work happens, and then trusts the person:

> **这是一台共享的箱子。<group> 里的人都能打开它的屏幕、读它的文件和命令历史,备份也会带走你在这里登录过的东西。在这里登录任何账号,等于替他们一起登录。**

Where it appears: the desktop header while the screen is open, the box list, and the box's
own page. Not a modal, not a one-time acknowledgement — those are read once and dismissed
forever. A label that is always there is read whenever it matters.

## 4. Ownership, and what changing it costs

The review's first question, which no earlier version asked: *what durable authority says
principal P owns box B now, and what revokes the old world before B is reassigned?*

A box record carries its class and its access. Changing either is a lifecycle operation,
not an edit:

- **private → private (someone else)**: revoke-and-wipe. Rotate the token, kill live
  sessions and tunnels, drain queued turns, destroy the config volume, delete archives or
  hand them to the departing owner. Anything less hands over a browser that is still logged
  into somebody.
- **private → shared**: the same wipe. What was one person's is about to be visible to a
  group, and "we told them" is not a substitute for removing it.
- **shared → private**: wipe as well; the incoming owner should not inherit a group's
  leftovers, and the group should not lose their things silently.
- **membership change inside a group**: no wipe; that is what shared means.

## 5. What is still hard, named rather than buried

**Agents belong to a box** — the review's third question and the largest piece. Today the
registry is global: `STARTER_TEAM` creation, `Fork`, `Delegate`, `SendToAgent`, shared
memory, transcripts, the inbox, schedules and usage all carry an agent id with no box in
it. An agent that worked in two people's private boxes would carry one person's memory into
the other's prompt — the exact failure a person noticed in a competitor product and asked
about. This is not a memory-directory change; it is a lineage that some component has to
refuse when it is missing or mismatched. **It is the reason private boxes are not shippable
this week.**

**One session resolver.** HTTP and the RFB upgrade resolve identity differently today
(`callerOf` treats an unauthenticated direct caller as owner; the upgrade path does not read
the web session at all), and the desktop route names a display index with no box in it.
Private boxes need one revocable resolver used by all three surfaces. Shared boxes need it
less urgently — everyone who can reach them may drive them — which is another reason the
shared class ships first.

## 6. Build order

1. ~~**Close the two "partial" rows** (§2)~~ — **done 2026-08-28.** Attach mode refuses
   rather than reaching for the local box's token, and the publish-address override warns.
2. ~~**Give a box a class and record it**~~ — **done 2026-08-28.** `config.boxes[name]`
   holds `{ access, group? }`; `classifyBox` resolves it, defaulting to `shared`, and a
   malformed entry is treated as shared *and* warned about rather than dropped. The
   running boxes are marked `shared`.
3. ~~**Label a shared box where the work happens**~~ (§3.1) — **done 2026-08-28.** A
   permanent badge in the desktop header, the sentence above the screen itself, and a
   paragraph in the agent's own prompt, because the agent is who gets asked "can anyone
   else see this?" mid-task. No refusal, no modal, nothing to click through.

   Not yet done, and small: the box list (there is one box, so there is no list) and the
   settings dialog's box section.
4. **One session resolver** across page, API and RFB, with a route that names the box.
5. **Box lineage on agents and their state** (§5), and the refusal when it is missing.
6. **The takeover state** (§3) plus a real recorder pause.
7. **Private box provisioning**: a second box per person. Mechanically this is `BoxManager`
   with another container name; the machinery exists.
8. **Reassignment as revoke-and-wipe** (§4).

Steps 1–3 are done and make the product truthful. Steps 4–8 are what private boxes cost,
and they should be estimated after 1–3 rather than now.

## 7. The trust model, as a product statement

The reviewer's sharpest line was that v3 "makes the stronger privacy claim while adopting
the weaker trust model". The fix is not a stronger claim; it is to state the model where
people can read it.

**In a private box**, these are trusted with everything you do there: the agents working in
it, the model provider they call, and every process in the container. A prompt injection
that reaches an agent reaches your box. This is the deal you make with an assistant you hand
your laptop to, and the product should use those words rather than implying a guarantee the
machinery does not make.

**In a shared box**, add: everyone who can reach it. Your screen, your files, your shell
history and your archives are theirs too. Don't log in to anything you would not hand them.
Nothing stops you — this is a real computer and we are not going to pretend otherwise — which
is exactly why the label is permanent rather than a warning you dismiss.

**Not offered by either class**: an agent that can *use* a credential without being able to
*see* it. That is broker-shaped injection — the secret never enters the container, a
placeholder is swapped at an egress proxy, which five independent systems converged on — and
it is a different feature for a different threat, not a later phase of this one.
