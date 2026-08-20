# Tenancy: teams, users, and who may drive which agent

Written before it is built, and marked where it is a design claim rather than a measured one.

## 1. The decision this document makes

**A tenant is a team, not a person.** One tenant, one box, many people.

That sentence is the whole design, and everything below is a consequence of it. The alternative —
a tenant is a person — was rejected for a specific reason worth stating, because it looks like the
simpler choice until you follow it through.

Agents inside one box talk to each other in-process: same memory, same filesystem, same scheduler
([03-architecture.md](03-architecture.md) §3.2). That is why messaging between them is a function
call rather than a protocol. If a tenant were one person, then two colleagues whose agents need to
work together would be in two containers, and agent-to-agent messaging would have to cross a
boundary. Crossing it means one of two things:

- **The control plane routes messages.** But a message to another agent *wakes a turn*, so this puts
  the control plane in the path of a turn — the one thing the whole architecture is built to avoid
  ([08-control-plane.md](08-control-plane.md) §1). It would also make it a message broker: holding
  messages, retrying, de-duplicating. That is a different product.
- **Boxes talk to each other directly.** Which means giving the container we deliberately do not
  trust an inbound channel and an identity.

Making the tenant a team avoids both. Colleagues share a box, their agents keep talking in-process,
and nothing new is in the turn path. What it costs is that the box must now know *which person* is
driving it, which is the rest of this document.

Cross-*organisation* sharing is a separate feature with a separate shape (§7). It is deliberately not
"the same thing but wider".

## 2. What already supports this, and what does not

Worth separating, because the amount of work here is much smaller than it first appears.

**Already true.** Agents in one box are isolated from each other structurally: each has its own
X display, and each presents an owner token that the box checks before touching that desktop
([04-design.md](04-design.md)). Two people driving two different agents in one box already cannot
disturb each other's screens. That isolation was built for a different reason and turns out to be
exactly what multi-user-per-box needs.

**Not true yet.** Three things:

1. **The box has no idea who is asking.** Its UI has one token; anyone holding it can drive
   everything. There is no notion of a person, so nothing can be attributed and nothing can be
   refused.
2. **The store has no users.** A tenant has a name and a quota, and that is all.
3. **Nothing expresses "this agent belongs to Alice".** Agents have a name, a persona and a display
   index, and no owner.

## 3. Model

```
tenant  (a team; one box, one set of volumes, one quota, one bill)
  └── user     (a person who signs in)
        └── membership  (this person's role in this tenant)
  └── agent    (lives in the box; optionally owned by a user)
```

A user may belong to more than one tenant — a contractor working with two teams is the ordinary
case, not an exotic one. Signing in therefore selects a tenant as well as authenticating, and the
session carries both.

### 3.1 Roles

Three, because two is not enough and four is a system nobody can explain.

| Role | May | May not |
| --- | --- | --- |
| **owner** | everything below, plus manage members and quota, and destroy the box | — |
| **member** | create agents; drive their own and shared agents; read the activity feed | manage members, destroy the box |
| **viewer** | watch: read transcripts, watch desktops, read the feed | drive anything, create anything |

`viewer` exists because the product's central promise is "watch and take over", and there is a real
need to let someone watch *without* the ability to take over — a reviewer, an auditor, a customer.

### 3.2 Agent ownership and sharing

An agent has an optional `ownerUserId` and a `visibility`:

| `visibility` | Who may drive it | Who may watch it |
| --- | --- | --- |
| `private` | its owner | its owner |
| `shared` | any member of the tenant | any member or viewer |

Default `shared`, because the reason to make the tenant a team is that agents work together, and a
default of `private` would mean every collaboration starts with a permissions change. An agent with
no owner — one created before this existed, or by an automation — is `shared`.

**A private agent is not a security boundary.** Everyone in the tenant shares a box, a filesystem,
and passwordless sudo inside it; a determined member can read another member's agent transcript from
a shell. `private` prevents accidents and answers "whose agent is this", which is what it is for.
Said plainly here rather than implied, because a permission that reads like a boundary and is not
one is worse than no permission at all. A real boundary between two people means two tenants and
two boxes.

## 4. How the box learns who is asking

The gateway already authenticates the person and holds the box's credential
([08-control-plane.md](08-control-plane.md) §5). It gains one job: telling the box who this is.

```
person → gateway ── verifies signed session → (tenant, user, role)
                 ── injects Authorization: Bearer <box ui token>
                 ── injects X-Agentbox-User: <userId>
                            X-Agentbox-Role: <role>
```

Two rules make this safe, and both are the kind of thing that is silently wrong if missed:

1. **The gateway strips those headers from the incoming request before setting them.** A client that
   sends `X-Agentbox-Role: owner` must not have it forwarded. This is the same rule that already
   applies to `Authorization` and the `agentbox_ui` cookie, and for the same reason.
2. **The box only trusts them when they arrive with a valid UI token.** The token is the proof that
   the request came through the gateway. A box reachable directly — a developer's laptop, a
   misconfigured publish — would otherwise accept any claimed identity.

The box does not learn the tenant's name, and does not need it. It learns a user id, which is
opaque, and a role.

**Consequence to accept:** the box trusts the gateway completely. That is a real dependency, and it
is the same one that already exists for the UI token. If the gateway is compromised, every box is.
The alternative — the box verifying a signed assertion itself — is better and is deliberately
deferred; the seam for it is that the box reads identity in one place.

## 5. What the box does with it

- **Attribution.** Every activity entry, transcript entry and audit row records the user who caused
  it. Today a transcript says "the user said"; with more than one person that is not a fact anyone
  can use. This is the part with value even before any permission is enforced.
- **Authorisation.** Driving an agent — prompting, aborting, changing its persona, deleting it —
  checks the role and the agent's visibility. Watching does not.
- **Refusal is explicit.** A refused action says which role would be needed. A permission system
  that returns a blank 403 generates a support conversation every time.

## 6. Admin surface

Kept as an API from the start, with a UI deliberately deferred (§8):

```
GET    /api/admin/tenant                 name, quota, box state, spend
GET    /api/admin/users                  members and roles
POST   /api/admin/users                  invite: {email|username, role}
PATCH  /api/admin/users/:id              change role
DELETE /api/admin/users/:id              remove from this tenant
GET    /api/admin/audit?since=<seq>      who did what
POST   /api/admin/box/restart            restart, keeping volumes
POST   /api/admin/box/destroy            volumes too; requires owner + confirmation
```

Decisions:

- **`owner` only, checked in one place.** Not per-handler, which is how one handler ends up missing
  the check.
- **On the control plane, not in the box.** These are questions about tenancy, and the box has no
  concept of a tenant. Putting them in the box would require teaching it one — which §4 explicitly
  avoids.
- **Every mutation writes an audit row** before it acts, including the ones that then fail. "Who
  tried" is a question asked after incidents as often as "who did".
- **Cursor-paginated audit**, by sequence and not by time, for the same reason usage is
  ([05-data.md](05-data.md) §2.4).

## 7. Cross-tenant sharing, later

Sketched to fix the shape now, because the wrong shape here would be expensive to undo. **Not
built, and not verified.**

An agent in tenant A doing work for someone in tenant B is not "the same thing but wider". It needs:

- **A durable queue per recipient, and boxes that pull from it.** The box must keep its property of
  never accepting an inbound connection, so it polls for work addressed to it. The control plane
  holds the queue; it does not route synchronously, so it is still not in the path of a turn.
- **At-least-once delivery, therefore de-duplication.** A poll that hands out work must not delete
  it until the recipient confirms it was durably handled; a crash mid-handling has to re-deliver.
  Which means the receiving side needs to recognise work it has already done.
- **An explicit, revocable grant**, audited on both sides, naming what may be asked and by whom.
- **Deliberate limits on what crosses.** A shared agent should expose a narrow ability, not a
  desktop and a shell.

The control plane's role is broker of *authorisation* and holder of the *queue* — never the carrier
of a synchronous message.

## 8. Why there is no admin UI yet

An admin UI is worth building when there is more than one operator, and today there is one. The
scripts already cover the operator's jobs, including things a hastily-built UI would not: running
`box-doctor` inside a box, and printing the size of each volume before asking whether to delete it.

An admin UI is also a second authorisation surface, with its own session handling and its own audit
requirements, and adding one before the permission model is settled would fix the model into the
shape of the UI rather than the other way round.

So: the API comes first (§6), and the UI becomes a thin shell over it. The signals that it is time
are a second operator, a non-engineer operator, or the need to edit a permission matrix — which is
the one job a command line does badly.

## 9. Order of work

1. ~~**Users, memberships and roles in the store**~~, and a session that carries (user, tenant,
   role). **Done.**
2. ~~**Identity injection**~~, with the stripping rule and the trust rule, and attribution in the
   box. **Done.**
3. ~~**Enforcement**~~: agent ownership, visibility, and role checks on driving. **Done.**
4. ~~**Admin API**~~, owner-only, audited. **Done.**
5. **Cross-tenant sharing**, if it is ever actually wanted. Not built.

## 10. What was built, and what it cost

Verified against a real box with three people in one tenant:

- Three sign-ins, one container. `alice` became owner and the others members, because somebody has
  to be able to invite the second person and a tenant whose only member cannot manage it is a dead
  end. Signing in again never changes an existing role — an owner demoting themselves by
  reconnecting would be a locked-out tenant.
- A member asking an owner's question got 403 with a message naming what would allow it, and the
  attempt was audited. "Who tried" is asked after an incident as often as "who did".
- A viewer read `/api/state` (200) and was refused `POST /api/agents` and `POST /api/prompt` (403).
- A viewer sending `X-Agentbox-Role: owner` was still refused: the gateway strips those headers off
  the incoming request before setting its own. This is the rule that fails silently if forgotten.
- Demoting the only owner was refused with 409 and an explanation, not a generic error.

Two consequences worth stating rather than discovering:

**A role change takes effect at the next sign-in.** The role travels in the signed cookie rather than
being looked up per request. The trade was deliberate: looking it up costs a store read on every
request, and the alternative shape — trusting the cookie for *identity* and the store for
*privilege* — invites the bug where one is checked and the other is not. What must be immediate is
suspension, and tenant and user state *are* checked on every request. The API says so in its
response rather than leaving it to be found out.

**An unrecognised role reads as the least privilege, not the most.** Three cases, and conflating the
last two would be a privilege escalation: no header at all means nobody is asserting anything, which
is the direct single-user case and has always been able to do everything; a recognised role is what
the gateway sends; an *unrecognised* one means something upstream is wrong, and the answer there is
`viewer`. The first draft of that code returned `owner` for the third case while its own comment
claimed otherwise.
