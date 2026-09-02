# Many boxes, one host: the multi-box mode

Status: **design, first version, 2026-09-02**, written the day the second box appeared.
Today one lumenbox installation drives one box. As of this afternoon there are two: the
Docker box on this laptop, and a drop-in on Grok Bot's own VM (`scripts/attach-grok.sh`,
docs in that script's header) — reached by a second orchestrator with its own state directory
(`~/.agentbox-grok`), because the first one cannot hold two. That is two installations, not
one installation with two boxes. This document is what "one with two" should be, built on
what docs/22 already decided and what today's attach taught.

## Status, 2026-09-02 (evening)

Stages A and B shipped on `feat/multi-box` (built on `feat/bot-templates` + `feat/grok-takeover`):

- **The list** — `src/box/boxes.ts` (`boxes.json` beside the agents, migrated from `box.json`
  keeping the own id; a list without this installation's box is refused, never adopted).
  `AgentRegistry`: `listBoxes/defaultBox/boxById/boxOf/agentsIn/attachBox/detachBox`; `create`
  takes `boxId` (absent = the own box) and `update` still has no such field; desktops are
  allocated per box from that box's floor. Detach is refused while agents live there.
- **The orchestrator** — `boxClients` by id, `boxFor(agent)`, `boxClient(agentId?)`,
  `skillsFor(boxId)`, desktops keyed `boxId:index`, the memory mirror written to the agent's
  box, the scheduler's `due()`/`listeners()` a union over boxes with `boxId` on each entry and
  `defaultAgent(boxId)` = that box's first agent; `connectBox()` connects the own box then
  every attached one on its own (one down costs only its agents). `attachBox`/`detachBox`
  live, `boxStatus()` for the panel.
- **The surface** — `/desktop/b/<boxId>/<index>/…` proxied to that box with its token
  (`desktopRouteOf`); `/api/state` carries `boxes` and each agent's `boxId`/`boxName`/desktop
  path; `POST /api/agents` and template import take `boxId`; `GET /api/boxes`,
  `POST /api/boxes/attach|detach`; screenshot/record/clipboard routes use the agent's box;
  starter skills are seeded per box. CLI `box attach <name> <url> --token-file F
  [--display-floor N]`, `box detach`, `box list` (through the running server when it has the
  route, else straight into the record). The new-agent dialog has a Box field, chosen once
  and read-only afterwards; agent rows show the box when there is more than one.
- **`attach-grok.sh`** registers the VM as box `grok` (floor 10) with this installation and no
  longer starts a second orchestrator.
- Tests: `src/box/boxes.test.ts`, `src/host/multi-box.test.ts` (two fake boxes: files, skills,
  desktops and memory follow the agent's box; a schedule on the attached box runs as its
  agent; detach with residents refused). 1045 green.

**Stage D (control plane), same night, ahead of C at Chris's call.** `box.role` (`primary` |
`attached`; guarded `alter table` for databases from before, and the one-live-box index became
one-live-*primary*-box); `upsertAttachedBox/attachedBoxesOf/retireAttachedBox`; the collector
probes primaries only and mirrors what each reports at `GET /api/boxes` — an attached row per
entry with the primary's `connected` as its health, retired when no longer listed; the admin
surface gained `GET /api/admin/boxes`, `POST /api/admin/boxes/attach|detach`, which go
*through* the tenant's primary (`/api/boxes/attach` with its UI token) and leave the row,
owner-only and audited. The URL an admin gives is as the primary's container reaches the box
(`host.docker.internal:13370` for a tunnel on the control host). Tests in
`src/control/multi-box.test.ts`.

Not done: Stage C (`TransferFile`, the wake line naming the box).
What still assumes one box: the chat inbox/outbox and file routes read the own box (a door
is bound to a box by record but the server does not route its files by it yet), `agentbox
box up/down/status` are the Docker box's, and skill provenance is keyed by slug alone.

## 0. What today taught, as constraints

- **A box is somebody's.** Grok's VM had displays :1..:5, noVNC 6080/6081, daemons on
  1337..1340 and Chrome debug ports 9222+N before we arrived. Ours live at :10 and up, on
  ports derived from that, and a display that is up without our marker is refused, not adopted
  (`attach-grok.sh`). A multi-box host must carry that per box: a **display floor**, a **work
  dir**, and a **token**, not one global of each.
- **A box brings its own logins.** The drop-in's Chrome is seeded from `~/chrome-profile`, so
  agents there act with the logins Grok's bot made. That is docs/22's inner gate in the
  concrete: *what its holder may reach is what everything inside it may reach.* The VM box and
  the laptop box are different authorities, so they are different boxes — never one box with
  two addresses.
- **Two hosts on one state directory collide** (docs/17). The second orchestrator exists only
  because `~/.agentbox` is one registry with one box record. The multi-box mode is what
  retires the second orchestrator.
- **The doors cannot be duplicated.** Feishu and DingTalk deliver each event to one
  connection per app id; the second host's attempt was refused by the guard. A door belongs to
  one box (docs/22 §2: `Channel.boxId`), and the host that holds the door must be the one that
  reaches that box.

## 1. The model

Nothing new conceptually; docs/22 already has it. What changes is that the shapes it drew
become plural in the code:

| Entity | Today | Multi-box |
| --- | --- | --- |
| Box record | `agents/box.json`, exactly one, written from the provisioner | `agents/boxes.json`: a list; each `{ id, name, provisioner: "docker"\|"attached"\|"compose", endpoint?, tokenRef, displayFloor, workDir, members, seeded }` |
| `AgentProfile.boxId` | stamped from the one record, immutable | unchanged — already the right field; new agents choose a box at creation, the default being the installation's first box |
| `Orchestrator.box` | one `BoxClient \| undefined` | `boxes: Map<boxId, BoxClient>`; `boxFor(agent)` by `profile.boxId`; every place that read `this.box` reads it through the agent |
| Displays | `readyDisplays: Set<index>`; `registry.displayIndexFor(agent)` from one floor | keyed by box: `Set<"boxId:index">`; the floor is the box record's; `displayIndexFor` allocates within the agent's box |
| Skills | `SkillCache(() => this.box)` — one directory | one cache per box; the prompt shows an agent its own box's skills; the scheduler's `due()` is the union, each skill tagged with its box and run by an agent of that box |
| Memory mirror | written to the one box | written to the agent's box (`~/work/memory/<agent>/`); shared-memory shards mirrored to every box, since team memory is the installation's |
| Starter skills, catalog seeding | once, on connect | once per box, with the `.seeded` marker per box (already per directory) |
| Channels (doors) | `ChannelRecord.boxId` exists, one value in practice | the router uses it: an inbound message admits into that box and wakes that box's default agent |
| Web UI | one desktop iframe per agent through `/desktop/<index>/` | `/desktop/<boxId>/<index>/`, boxd proxied per box; a box column on the agent row; box status per box in the state panel |
| CLI | `box up/down/status` for the Docker box | `box attach <name> <url> --token-file …`, `box detach`, `box list`; `box up` stays the Docker one |

Two rules carried from docs/22 without change:

- **Workers are uniform inside a box.** An agent on the VM box holds Grok's logins by being
  there; an agent on the laptop box does not. Moving an agent between boxes is not a field
  edit — `boxId` stays immutable — it is create-on-the-other-box, and a template (docs/29) is
  exactly the vehicle: pack on box A, import on box B, the new bot installs itself there.
- **A door routes, a box authorizes.** The Feishu door bound to the laptop box cannot be
  pointed at the VM box's agent by a schema edit; `defaultAgent` must be an agent of the door's
  box (docs/22 §1), and the check is at admission.

## 2. Crossing between boxes

Agents already message each other through the host (`AgentBus`), so a Rex on the VM and an
Ada on the laptop can talk today the moment they share a registry. What they cannot share is
a filesystem. Three primitives, all host-mediated, all explicit:

1. **`SendToAgent`** — unchanged; the bus is host-side. The wake prompt gains one line naming
   the sender's box when it differs, so an agent knows the file path it was handed is not on
   its own machine.
2. **`TransferFile`** (new tool) — `{ from: path, to: path, agent: name }`: the host downloads
   from the caller's box (`downloadFile`, confined to its work dir) and uploads into the target
   agent's box (`uploadFile`, same confinement), records it in the transcript of both, and
   the auto-review classifier sees it as an outbound write (it leaves a box). Size-capped
   like every box call. This is Grok's `CopyToBox`/`CopyFromBox`, host-side.
3. **`Delegate`/`Fork`** — stay within the caller's box; a fork is a conversation, not a
   machine.

Not provided on purpose: a shared volume, a sync daemon, or an agent that "has" two boxes.
Each of those is a second authority hiding inside one worker.

## 3. Provisioners, per box

The provisioner interface already exists (`src/box/provisioner.ts`: `docker`, `attached`,
`kubernetes`). A box record names its kind and the provisioner is built from the record
rather than from the environment:

- `docker` — today's local box; unchanged.
- `attached` — an endpoint and a token; the VM drop-in is this. `attach-grok.sh` writes the
  record (`box attach grok http://127.0.0.1:13370 --token-file ~/.agentbox-grok/box-token
  --display-floor 10`) instead of exporting `AGENTBOX_BOXD_URL`. The tunnel stays the script's
  job; the host only knows the address.
- `compose` — the control plane's, one per tenant today (partial unique index in
  `store.ts`). Multi-box per tenant is the same list on the control plane's side: a tenant
  with two boxes proxies by a box parameter in the path, and the gateway's `boxFor(tenantId)`
  becomes `boxFor(tenantId, boxId)`. Not in the first stage.

`AGENTBOX_BOXD_URL` / `AGENTBOX_TOKEN` remain as a one-box shortcut that synthesises a record
named `attached`, so nothing that works today stops working.

## 4. Stages

**Stage A — the list.** `boxes.json` with migration from `box.json` (the existing record
becomes the first entry, `displayFloor` 1, `workDir /home/box/work`); `Orchestrator.boxes`
and `boxFor(agent)`; displays, skills cache, memory mirror, seeding keyed by box; scheduler
union. Criteria: every existing test passes with one box; a two-box test with two fake
clients shows an agent's `write_file` landing in its own box, its skills index listing only
its box's skills, and a scheduled skill on box B running as an agent of box B.

**Stage B — attach and see.** `box attach/detach/list`; the web UI's box column and
`/desktop/<boxId>/<index>/`; create-agent dialog chooses a box; `attach-grok.sh` writes a
record and stops starting a second orchestrator. Criteria: the VM box appears beside the
Docker box in one UI, Ada on the VM and Ada-on-laptop each drive their own screen, the Feishu
door keeps working on the laptop box.

**Stage C — crossing.** `TransferFile`; the wake line naming the box; auto-review treats a
transfer as outbound. Criteria: a file moved VM → laptop appears in the target's work dir
with both transcripts recording it; a transfer outside a work dir is refused by the daemon.

**Stage D — the control plane.** Multiple boxes per tenant; the gateway's box parameter;
admin routes to add an attached box to a tenant. After there is a second real tenant that
needs it.

## 5. What is deliberately not in this

- An agent on two boxes at once. A worker is uniform inside a box (docs/22); the same worker
  in two rooms is two authorities.
- Moving an agent's transcript between boxes. The transcript is host-side already; what
  moves with a template is the recipe, and what stays is history.
- Any automatic failover between boxes. A box that is unreachable is reported (`box status`,
  the state panel) and its agents wait; choosing another machine for someone's work is a
  person's decision.
