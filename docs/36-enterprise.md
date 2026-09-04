# The enterprise use case, and the editions that share one core

Status: **design, first version, 2026-09-03.** The owner's directive, twice
over: first the *whole* use case — an enterprise entering, its first user
becoming admin, the org structure imported, boxes orchestrated from it — and
only then the steps; and the edition question — personal is an Electron app
that just runs, enterprise is a server, and what exactly separates, whether
the same Electron can serve enterprise by pointing its split-out half
elsewhere. Written against the tree after the provider-agnostic login landed
(`feat/multiuser-login`); docs/35 stays the model for *who may reach what*,
this file is the *product shapes and the journey*.

## 0. The edition answer, in three sentences

**One core, two shapes, one optional plane.** The core — orchestrator, web
UI, doors, principals, boxes, catalog — is byte-identical in both editions;
the Electron shell is a supervisor around it (three jobs: spawn, window,
tray — `electron/main.cjs`), not a product of its own. A personal edition is
the degenerate case of the multiuser model: one Principal (admin), one box,
`members: everyone` — which is exactly what runs today, needing nothing
turned on. An enterprise edition is *the same core run as a server* with the
multiuser data filled in — doors that log in, a synced directory, boxes with
member sets — plus one thing personal never has: **box hosts elsewhere** and
**credentials in managed surfaces** instead of a laptop's env.

The control plane (docs/08, `src/control`) is neither edition. It is the
*vendor's* plane for hosting many companies, and a single-company enterprise
does not need it — this is the load-bearing simplification: **enterprise ≠
control plane.** Enterprise is one installation with many principals.

And the Electron half of the question: the shell today always spawns a local
server; it gains one mode — **connect to a running installation** (URL +
token, the same bargain `box attach` strikes) — after which the same desktop
app is the personal product *and* the enterprise admin's console. Nothing
splits out of the app; the app learns to point.

## 1. The use case, as one company's first two weeks

Measured-style acceptance on every scene, per the house rule. The company:
纵横科技, 40 people, 6 departments, DingTalk as the org of record, Feishu in
half the company. The names are illustrative; the surfaces named in each
scene are the deliverables.

**Scene 0 — the server exists (IT, one afternoon).** A VM (or a mac mini in
a closet) runs the enterprise deployment unit: one compose file, the core
(`agentbox serve`), TLS terminated in front, `AGENTBOX_PUBLIC_URL` set. On
first start, with no principal on the roster, the server **prints a
bootstrap code** — the same shape as the UI token it already prints, and for
the same reason: the first credential cannot be issued by a login page
nobody can trust yet.

*Accept:* `agentbox serve` comes up with an empty roster and says so in the
log; a bootstrap code exists exactly until redeemed.

**Scene 1 — the first enterprise user becomes admin (the IT lead).** They
open the URL, scan with DingTalk — the OAuth dance from `feat/multiuser-login`
— and, because their identity is linked to nobody, get today's knock page
*plus one field*: the bootstrap code. Entering it links their identity,
creates their Principal as `admin`, and burns the code. The installation is
bootstrapped: every later unlinked login is a plain knock again.

*Accept:* first redemption mints exactly one admin and no second chance at
the code; a second person arriving before Scene 2 gets the knock page
without the field; the operator token still exists beside this (the machine
is still operated by whoever runs it — docs/09's two levels, unchanged).

**Scene 2 — the doors connect (admin, same day).** The settings console's
door section already adds credentials; it gains per door: **login on/off**
and, for the org of record, **directory scopes**. The admin pastes the
DingTalk app's key/secret, enables login, grants contact scopes; ditto the
Feishu app. The console reports what the vendor answered — door connected,
login live, and (Scene 3's input) *which* contact visibility the app
achieved.

*Accept:* a second person can now sign in through a door and is refused as
unlinked (knock) — proving login works before anyone is admitted by it.

**Scene 3 — the org imports (admin, ten minutes later).** The admin presses
"sync" (and the scheduler takes it from there). The directory lands:
6 departments, 40 people, names as the vendor holds them. The admin surface
shows the tree with counts, the visibility mode the app achieved, and the
staleness line. The admin sets the **default role for directory members**
(`driver`) and the **personal-box quota** — the installation default is `0`
or `1`, refinable later per department and per person, because some
companies have no quota to give at all (owner's ruling, 2026-09-03). She
sets the company default to `1`; 客服部, who share machines, get `0`.

*Accept:* every department and person the vendor returns is visible with
counts; a rename on the vendor side appears on the next sync; partial
visibility is labelled and absence-deactivation stays off (docs/35 §3).

**Scene 4 — boxes are orchestrated from the structure (admin, the first
hour).** The admin's box console (multi-box shipped, docs/30) now edits
*membership*, not just endpoints:

- the company box — today's default box, `members: everyone`, both doors
  bound to it, the catalog crews installed into it;
- 研发部's box — `members: department 研发部`, on box host B (an attached
  box: `box attach …`), provisioned because that team's work wants its own
  logins;
- personal boxes — self-provision **within quota**: a member with quota
  left can take one from the catalog page; it is invisible to everyone else
  (docs/18's ruling). The quota comes from the person, else their
  department, else the installation default — the same resolution order in
  both directions, so a department-wide `0` is a real ceiling and a
  per-person `1` is a real exception.

*Accept:* each box's label derives from its resolved member set; a door
bound to the 研发部 box routes there and reaches nothing else; provisioning
a personal box is a member-side action requiring no admin.

**Scene 5 — the company arrives (everyone else, day two).** Two doors in,
both with auto-link: a directory member DMs the bot and is talking (no
approval ceremony — the vendor authenticated them, the directory knows
them); or they open the URL, scan, and see exactly their boxes (the company
box; their own if they made one). First contact opens with the shipped
`[first run]` hello. Attribution starts here: every transcript row, task,
and spend line says who.

*Accept:* a directory member's first DM links and answers; a non-directory
stranger's DM knocks; a web login shows only member boxes and leaks no
existence of others (U3).

**Scene 6 — life with it (the next two weeks).** A transfer between
departments moves a person's reach at the next sync (department box swapped,
schedules in the old box dead-lettered, nothing silent). A departure ends
access the same way; their personal box becomes an operator decision. Spend
ceilings per person and per box bite at the relay. The admin's own seat is
the Electron app in connect-to-server mode — same window, pointing at the
VM. When the admin's laptop is closed, the doors, schedules, and everyone
else's work are untouched: the server was never in the laptop.

*Accept:* U8, U9, U12 from docs/35, plus: killing the admin's shell changes
nothing server-side; the server's restart recovers doors on the shipped
backoff.

**What is deliberately absent from this story:** the vendor (us). No control
plane, no hosted anything — a single company's enterprise runs entirely on
its own metal. The control plane enters only when *we* host many companies,
and then it is docs/08's shape (gateway, allocator, collector — never in the
path of a turn), re-using this same core underneath.

## 2. Bootstrap admin: the mechanism, built from what exists

The invite-code machinery already redeems a code into a Principal
(`invites`, `POST /api/login`); bootstrap is that, pre-minted:

- on first start with an empty roster, the server mints an **admin invite**
  (one, 24h, logged like the UI token — visible to whoever can read the
  server's output, which is the operator, which is the right person);
- the knock page (the one `vendorAuth` renders) grows the code field *only
  while an unredeemed bootstrap invite exists* — after that it is the
  ordinary knock page again;
- redemption links the identity, creates the Principal as `admin`, burns the
  invite, and writes the first audit row of the installation.

No config flag, no "first user is admin" race: the code is the
serialization. (Multica's creator-is-owner reads cleaner in a SaaS signup;
here the installation is brought up by an operator *before* any user
exists, and the code is how the operator hands it over.)

## 3. Edition architecture: what lives where

| Capability | Personal (Electron) | Enterprise (server) | Notes |
| --- | --- | --- | --- |
| Core (orchestrator, web, doors, principals, catalog) | in the Electron child | the deployment unit | byte-identical; no build flag, no fork |
| Box | the first box by default (owner's ruling); optionally **one attached** — the grokbot shape (docs/30) | the first **common box** is part of the deployment unit (ruling); more by attach or provision | multi-box already shipped; the enterprise's boxes are the same records |
| Login / directory / RBAC | present, dormant — one principal, `everyone` | on — the Scene 1–4 data | capabilities gated by *data*, not by edition |
| Model & channel credentials | `~/.agentbox` env / config | the same, plus relay-enforced ceilings | S-5's point; personal never needs it |
| Doors (Feishu/DingTalk sockets) | fine on a laptop that sleeps | the reason the server is a server | a door dies with its host — 24/7 is a server property |
| TLS | not needed (loopback) | required in front (S-2) | deployment, not code |
| Audit / spend attribution | trivially one person | load-bearing | same rows either way |
| Electron shell | spawns the core locally | **connect-to-server mode** (new): URL + token | the one shell change; makes the app the admin console |
| Control plane | never | not needed either — vendor-only (docs/08) | hosting many companies is our plane, not theirs |

**The connect-to-server mode** is the whole answer to "同一个 Electron 行不行":
yes — as the *seat*, not the *server*. The shell gains a target selection
(local spawn, as today, or a remote URL with its token); everything after
that is the web UI it already wraps. Enterprise members need no app at all
(browser or the IM they already have); the app's enterprise value is the
admin's tray, notifications, and the native feel — conveniences, not
dependencies. What the app must *not* become is the enterprise's host: doors,
schedules, and other people's work on an admin's laptop is the failure shape
the server edition exists to prevent.

**The enterprise deployment unit** (Scene 0's compose file) contains: the
core, a TLS terminator, a first box (or zero — attach later), and nothing
else. One machine runs one company. Scaling a company out is multi-box:
more `box attach` rows, more box hosts — the installation stays singular,
which is what keeps identity, roster and audit in one place.

## 4. The step plan, revised from docs/35 §8

Stage 1 (login) is on `feat/multiuser-login`. Ahead, re-ordered around the
use case's scenes so each stage ends with a scene that works end to end:

0. **The server shape + bootstrap** (Scenes 0–1): `agentbox serve` as the
   headless deployment unit (compose file, TLS note, PUBLIC_URL check at
   start); the admin invite and the knock-page field. *This is the next
   stage to build.*
1. **Login per door** — landed; folds its settings toggle (login on/off per
   door, Scene 2) in here.
2. **Directory sync** (Scene 3): adapters, store, admin tree, visibility
   rule, auto-link.
3. **Membership enforced** (Scene 4's authority half): the three bindings,
   admission everywhere, no-leak listings.
4. **Grants to the box** (docs/22 item 6) + cross-box `SendToAgent`
   refused.
5. **Box orchestration surface** (Scene 4's console half): membership
   editing, department binding picker from the synced tree, personal-box
   self-provisioning **within quota** (person → department → installation
   default), box hosts attach flow polished.
6. **Departure + ceilings** (Scene 6): cascade, dead letters, relay refuse.
7. **Electron connect-to-server** (Scene 6's admin seat): target selection
   in the shell; smallest stage, deliberately last — the server must be
   real before the seat points at it.

## 5. Decided by the owner, 2026-09-03

1. **Bootstrap code channel: the log.** Minted and printed on first start,
   beside the UI token it already prints — whoever can read the server's
   output is the operator, and one less handoff step is one less way to
   strand a fresh install.
2. **Personal-box quota is configuration, not a constant.** Installation
   default `0` or `1`; overridable per department and per person, because
   some enterprises have no quota to give and must be able to say so
   company-wide. Resolution order person → department → installation. The
   **personal product defaults to `1`**, and may attach **one additional
   box** — the grokbot shape — which is docs/30's attach, not a new
   mechanism.
3. **The first box exists in both editions.** Enterprise's deployment unit
   carries the first **common box** (Scene 1 lands on a working product);
   personal's first box is the default it already is.
4. **The vendor-hosted plane (docs/08) is later** — nothing in this design
   needs it, and it waits for a real second customer before it earns
   building.

Still open, small: the compose/deployment packaging itself is written when
there is a real VM to measure on — a compose file nobody has run is a
doc-shaped guess, and this codebase does not ship those.
