# The domain model: people, doors, workers, rooms

Status: **draft, fifth version.** v1 lost its invariant to a set nobody can
enumerate; v2 put authority on the door binding and was rejected for it; v3 said
the right three sentences (doors route, boxes authorize, workers are uniform) and
then contradicted the first one in its own entity table; v4 applied both v3
reviews and survived conceptually — its review found no fault with the model,
only with the specification: incarnations missing from durable chat references,
bind not linearized against namespace changes, the grant-migration inventory
incomplete, and a build order whose items 1–4 required a box id item 5 was
postponing. v5 was those four fixes; its review confirmed the ordering fix and
found five implementation-level leaks (delivery recovery, identity-link
migration timing, PolicyGate approvals, door-scoped document credentials,
caller-less initiators), all absorbed here as the **sixth version**. The review
history is the argument for every decision below; this file states the results.

## 0. The principles

There are exactly **two gates**, and no third layer:

> **The outer gate is the installation's.** May this identity drive this system at
> all; may it administer it. This is today's `Principal.role` and allow-list, and
> it stays — it answers "are you one of us", not "what may you reach".
>
> **The inner gate is the box's.** A box is *the* unit of authority: what its
> holder may reach is what everything inside it may reach. Nothing between the two
> gates — not a channel, not an agent — carries a permission set of its own.
>
> **Workers are uniform inside a box.** Two agents in one box may differ in
> prompt, model, and division of labour; they may never differ in what they are
> *allowed* to reach. What must be uniform is **confidentiality**: an agent that
> can reach a secret its colleague cannot is a modelling error. Withholding a tool
> to shape labour is allowed — and the moment a withheld tool is the only thing
> between an agent and a secret, the secret is in the wrong box.

And one rule about holders, which dissolves a question that misled three versions:

> **A box's authority belongs to a set of users — and "private"/"shared" are
> descriptions of that set's size, not types.** One member: the box is that
> person's, exclusively. Every principal: shared with everyone. A subset — a
> department, a team: shared with exactly that subset. One concept, three
> cardinalities, one admission check. "公司飞书" was never an entity: the only
> question any new door raises is whether its people get the *same* authority as
> an existing box or an *isolated* one — same → a second door on that box;
> isolated → by definition, another box with a different member set. No
> enterprise/personal distinction exists to encode.

## 1. The entities

| Entity | Holds | Against today's tree (`3e8c8b8`) |
| --- | --- | --- |
| **Principal** (person) | `{id, name, role, identities[]}` | Exists. `role` is the outer gate only. |
| **Identity** (address) | `<channelId>:<vendor subject>`, and on the Principal side the link carries the channel **incarnation** it was bound under | Exists as plain strings; the incarnation on the link is new — see §4. |
| **Channel** (door) | `{id, name, type, credentials, incarnation, boxId, defaultAgent}` | Does not exist — one hardcoded singleton per type. |
| **Box** (room) | `{id, name, members}` where members is `everyone` \| a set of Principal ids | Partially exists as `config.boxes[name] = {access, group?}` keyed by reusable name; `access` becomes a *derived* description of `members` (one → private, all → shared), not a stored class. Note: `access: "private"` today is a label with no mechanism (`PRIVATE_IS_ENFORCED === false`); a box marked private **runs as shared** until docs/18 steps 4–8 land. |
| **Agent** (worker) | name, description, `displayIndex`, `boxId`, provider/model, tools-as-labour | Exists minus `boxId`. §3 lists what the uniformity principle retires. |

```
Principal ─1..n─ Identity ─minted by─ Channel ─routes into─▶ Box ◀─houses─ Agent
   outer gate                          (door:                (room: the inner
   (role)                              no authority)          gate, the ONE
                                                              authority point)
```

`defaultAgent` must name an agent whose `boxId` is the channel's `boxId` — a door
pointing at another room's worker is a schema error, not a runtime surprise.

## 2. Doors route; boxes authorize

Arriving through a door bound to box B makes B *reachable*; it grants nothing.
Authority is **one check at every admission point**, against B's own record:

> outer gate passed ∧ `principal ∈ B.members`

(`everyone` admits any principal the outer gate passed.) The same resolver serves
doors, the web and the VNC upgrade — docs/18 §5's "one session resolver", given
its data. A private box, a department box and the common box run the same check
on differently sized sets; there are no per-cardinality mechanisms to diverge.

Cardinality notes, where today's reality bites:

- **One member.** Bind on such a box may only link a new identity to that member
  — it must never mint a new Principal. The measured near-miss: on 2026-08-29 an
  enterprise switch produced a fresh DingTalk identity for a person who was
  already the linked driver; a one-click approval that pushes a new driver row
  instead of linking would leave the owner locked out of their own box forever.
- **`everyone`.** Today's box, named honestly.
- **An enumerated subset** (a department, a team). **Not deliverable in build
  items 1–4**: today knock/bind writes an installation-wide driver, so until
  bind can write box membership, an enumerated set degrades to `everyone` and
  must say so. This is the standing gap both v3 reviews found (a door rebound to
  a box handed out installation-wide keys); it is why 5–6 are blocked, and it is
  recorded here rather than papered over.

**Caller-less work.** Schedules, restart recovery and audit runs arrive at the
box with no admitted principal, so the membership check as written has nobody to
check — failing open would let a removed member's automation keep running,
failing closed would break every schedule. The rule: such work is **created by an
admitted principal and admitted later as the box's own** — its durable record
carries `boxId` plus the creating principal, and at fire/recovery time it is
revalidated: creator still `∈ members` → runs with the box's authority; creator
gone → a reported dead letter, never a silent run and never a silent drop. The
admission acceptance matrix (§7 item 6) includes these initiators, not only the
interactive surfaces.

**Routing.** The door's `defaultAgent` answers unaddressed messages — falling back
to the box's only agent, an error when ambiguous, never `registry.list()[0]`.
`@Name` and the roster verb resolve against the box's agents: what a door shows
and what it routes is the box's list, always.

**What a second door delivers, said plainly**: a second door on today's box is
*the same authority through another entrance* — same workers, same roster; either
door reaches every agent in the box. That is not a limitation but the definition
of "same box". A door whose people need isolated authority needs its own box, and
build items 1–4 cannot produce one; see §7.

## 3. What uniformity retires, and where the holes still are

- **Per-agent `visibility`** ("who may drive this agent") — retired. This
  **overrides docs/09 §3.2**, which kept it as accident-guard and attribution;
  that section is superseded, not silently reinterpreted. `ownerUserId` survives
  only as attribution (whose creation is this), never as a gate. Note the live
  violation: web authorization **denies today** on `visibility` plus
  `ownerUserId` (`src/web/auth.ts`), so two Principals in one box already get
  different drive decisions — retiring the field means removing that check, not
  just the schema.
- **Per-agent scope/secret grants** — retired as a design subject. Today
  `RunOnHost` authorizes secrets off the calling agent's mutable `scopeId`
  (`src/host/tools.ts`), so two agents in one box demonstrably differ in secret
  reach: the uniformity principle is **false in the running system** until grant
  subjects move from agent to box, fail-closed, with a test that every agent in a
  box gets identical secret decisions.
- **Per-chat scope bindings** (`scope <name>` on a chatKey) — same shape, one
  layer over: two doors into one box binding different scopes recreates door-level
  authority. Retired with the above; until then, a known hole.
- **Per-agent `tools`** — kept, as labour shaping under §0's confidentiality rule.
- **PolicyGate approvals** — the inventory's easy miss: approval fingerprints
  hash the agent id, and *standing* and *session* grants persist and replay with
  it (`src/host/policy.ts`), so the same caller's identical `RunOnHost` action
  can be allowed for agent A and refused for agent B in one box. Decided default:
  **reusable grants (session, standing) are box-subject** authority and migrate
  like the rest; a **`once` approval is consent to one action, not authority** —
  it re-asks per occurrence, so it cannot create standing unequal reach, and the
  acceptance test proves that by including policy decisions in its matrix.
- **Document reading is a box capability, not a door property.** A per-channel
  doc reader authorizes with that app's credentials, so two doors on one box
  would give the same worker different document reach depending on ingress —
  doors selecting authority, exactly what this model forbids. The box names its
  document-reading credential (default: the grandfathered channel's); which door
  a link arrived through is irrelevant to whether it can be read.

## 4. Names are labels; ids are identity; incarnations revoke

- **Box**: opaque `id`; agents and channels bind to it. Destroying a box retires
  the id forever — a new box under the same display name is a new id and inherits
  nothing (class, token, agents, schedules die with it). No generation counter on
  boxes: id retirement already provides the guarantee, and a second mechanism
  with the same job would just be a second thing to get wrong.
- **Channel**: immutable `id` mints identities and chatKeys. `name` is a display
  alias; renaming touches nothing persistent. The existing singletons are
  grandfathered as ids `feishu` / `dingtalk` / `telegram`, so every recorded
  chatKey, allow-list entry, scope binding, digest, schedule and conversation
  mapping keeps working.
- **Incarnation, precisely.** Two different events were one field in v3:
  - **Secret rotation** (same app, new secret): vendor subjects are unchanged and
    identities must survive. No incarnation bump.
  - **Namespace replacement** (different app, different tenant, different bot
    under the same door): vendor subjects may collide without meaning the same
    person. Bump the channel's `incarnation`, and the stamp is checked wherever a
    vendor-scoped string is durable, not only on people:
  - **Identity uniqueness is `(channelId, incarnation, vendorSubject)`.** A link
    from an older incarnation no longer resolves — mechanically, because the
    resolver compares, not because a config field changed somewhere else.
    Relinking is ordinary knock/bind, **linearized**: a knock records the
    incarnation it was observed under, and the eventual approval commits
    only if that incarnation is still current and no current link exists for the
    subject — compare-and-set, so a knock from the old tenant approved after the
    switch stamps nothing into the new one, and two concurrent binds cannot
    create competing links. (Today a pending knock carries only the plain
    identity string and duplicate identities resolve last-write-wins; both are
    what this rule replaces.)
  - **Chat references carry the stamp too.** Schedules, digests, conversation
    mappings and transcript references persist chatKeys today as raw
    `feishu:oc_x` strings, and outbound delivery picks its adapter by prefix —
    so after a replacement, an old timer would post into whichever tenant now
    holds the door, and colliding vendor chat ids would resume the old tenant's
    conversation history. Every durable chat reference is therefore an
    incarnation-stamped ChatRef, resolved fail-closed against the channel's
    current incarnation: stale → a reported dead letter, never a delivery to
    whoever holds the door now. Conversation identity is incarnation-scoped for
    the same reason. Legacy records migrate into the grandfathered incarnation
    explicitly.

## 5. The audience statement is derived from the members

The permanent label (docs/18 §3.1) derives from the box's `members` — the set
admission actually checks — not from doors and not from free text:

- one member: named for that person (and until enforcement lands, labelled
  未生效, exactly as `access.test.ts` already pins).
- `everyone`: "anyone this installation admits, through any door of this box or
  the web" — doors listed as illustration, never as the boundary, because web,
  MCP and invite codes admit people no door ever saw.
- an enumerated subset: name the set (the department, the team) — only once
  membership is enforced; degraded honestly to the `everyone` wording until then.

A door's vendor-side population (which groups a Feishu app is in) changes with no
event here and can never be the label's source. Free text may decorate; it may
never narrow.

## 6. One normative document

This file is normative for the domain model. **docs/18 must be amended in the
same change that implements any of this** — it currently specifies immutable
`boxName` on the agent and classes under `config.boxes[name]`, which is the
name-reuse bug §4 exists to kill, and its `classifyBox` lookup is keyed by a URL
in attached deployments (handoff claims review #1), which `boxId` must also fix.
Until that amendment lands, implementers follow *this* file's §4 and treat
docs/18's naming as superseded. Migration from `boxName`/`config.boxes[name]` is
specified with the amendment: fail closed on ambiguous or missing mappings.

Also out of scope here, unchanged: docs/09's control-plane tenancy is a different
level and this installation-level model does not bridge to it; `SendToAgent`
across boxes stays docs/18 §5's open decision (doors no longer produce the
oracle; agent-to-agent still can); harness initiators (schedules, MCP, web
prompt, restart) still carry no box context and are docs/18 step-5 work; where
second-app credentials live is a docs/15 decision before build.

## 7. Build items

The v4 review caught an ordering bug here: items 1–4 required `boxId` relations
that item 5 was postponing, so an implementation would have had to ship an
intermediate format needing exactly the ambiguous migration §6 forbids. Fixed:
the box's *identity* arrives first; its *membership machinery* stays late.

1. **The grandfathered box, first.** Mint the opaque id for today's box; backfill
   `boxId` onto every agent and (as they are created) channel records;
   `defaultAgent ∈ door's box` validated from day one; the docs/18 amendment
   (§6) lands in this same change. Membership stays `everyone` — no new
   authorization, only identity.
2. Channel records with immutable ids and incarnations; registration loop
   replacing the env singletons (grandfathered rows for feishu/dingtalk/telegram).
   **This item is one atomic namespace-safety migration**, because shipping
   incarnations without it is worse than not shipping them:
   - incarnation-stamped ChatRefs for **every** durable chat address — schedules,
     digests, conversations, **and delivery/transcript records** (`deliveries.ts`
     stores a raw chatKey that restart recovery sends through; crash → namespace
     replacement → recovery must produce a reported dead letter, and that exact
     sequence is a test);
   - Principal identity links backfilled into the grandfathered incarnation, with
     storage-level `(channelId, incarnation, vendorSubject)` uniqueness and the
     §4 CAS applied to **every** identity writer — knock, bind, invite, and the
     bulk principal editor, which today accepts identity arrays outside knock/bind;
   - namespace replacement and new binds are disabled until the migration
     completes; legacy plain-string records fail closed, not last-write-wins.
3. Prefix parameterization: hardcoded `feishu:` sites (15+ in `feishu.ts`, log
   lines included; dingtalk and telegram equivalents) become `${channelId}:`.
4. Per-door routing: `defaultAgent`, box-roster `@Name`, roster verb, unknown-`@`
   correction from the same list. Document reading becomes the box capability of
   §3 — the box's configured doc credential serves every door, replacing the
   orchestrator singleton; a per-channel reader lookup is exactly the
   door-selects-authority bug and is not the implementation.
5. The `members` set on the box record; bind writing box membership (and
   link-only, never mint, on single-member boxes); the knock/bind CAS of §4.
6. **Grant subjects to the box — by inventory, not by category.** The shipped
   authorization subjects are: `visibility`/`ownerUserId` in web auth, vault
   grants naming `agent:<id>`, `principal:<id>` and `*`, agent `scopeId`,
   chat-scope bindings, and **PolicyGate session/standing approvals** (§3's
   decided default: reusable grants move to box subject, `once` stays consent).
   Each migrates to a box subject or is removed; anything ambiguous **fails
   closed** pending operator assignment. The acceptance test is a full matrix:
   every agent in a box must yield identical drive, secret **and policy**
   decisions for every admitted caller, across channel, web, MCP and VNC
   admission paths, and for the caller-less initiators of §2 (schedules,
   restart/resume, audit).

**1–4 deliver: a second door into today's box** — same authority, another
entrance, `defaultAgent` of its own, on a box that already has a real id. **5–6
deliver isolated authority** (a box whose member set is not `everyone`); they
must not start until the §2 membership gap, the §4 incarnation semantics, and
the §6 amendment are implemented together, in that combination.

**Decided by the owner, 2026-08-29: 5–6 are deferred until multiuser exists.**
The ruling, in full: a private box is not the vault comparison and not a broker —
it is a *special-made box*, usable by exactly one person and **invisible to
everyone else** (stronger than a label: the others don't see it at all). There
are no department boxes as a concept of their own; when multiuser arrives, other
boxes follow department-level authority. And until there is a multiuser
mechanism, none of it is buildable honestly — **today every box is shared, and
says so**, which items 1–4 already made true. This answers the v4 reviewer's
"docs/18 has no user" gate: the user is the owner, the use case is a one-person
box, and the schedule is "with multiuser, not before".
