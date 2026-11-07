<!-- doc: 95-two-installations
     title: Two installations side by side: a personal one that is its Owner's alone, an organisation that is a server
     family: decision
     status: current
     updated: 2026-11-06
-->
# Two installations side by side: a personal one that is its Owner's alone, an organisation that is a server

Status: **decided by Chris, 2026-11-06 ("route B"; INV-1687, this record INV-1688).** It
replaces two ideas that were current until today: that a personal installation is *the
degenerate case of the multiuser model* (docs/36 §0), and that a desktop installation becomes
an organisation when a second person is let in (docs/36 §2 and docs/22 §1a, as amended by
INV-1685 the same day). Nothing in the code is removed by this record. INV-1689 removes the
conversion path, INV-1690 connects the app to an organisation, INV-1691 adds the first level of
the sidebar, and INV-1692 allocates an organisation's boxes on Kubernetes.

## 0. The decision, in five sentences

1. **There are two kinds of installation, and neither turns into the other.** A *personal
   installation* belongs to its Owner (机主) alone. An *organisation installation* is a server
   whose people are Admins (管理员), drivers and viewers.
2. **A personal installation never adds a second person.** Its boxes run on the Owner's own
   computer (Docker) or on a VM the Owner runs (the Grok Bot box is the example). Its
   credentials, routines and records stay on that computer. To work with someone else, the
   Owner joins or creates an organisation.
3. **An organisation installation is one server, and its boxes are allocated on Kubernetes.**
   The shared agents, credentials, routines and records live on that server and nowhere else.
4. **The desktop app is a client of several installations at once.** The first level is the
   installation: personal, then each organisation. The second level is that installation's
   boxes and agents. Each connection has its own identity and its own token, and an
   organisation's token is kept in the operating system's keychain.
5. **The boundary is closed by default, and the only way across is the side door.** A personal
   agent hands work to an organisation through that organisation's MCP endpoint (docs/33 §8),
   with a token the organisation issued to that person. The work runs as that person's
   identity in the organisation and is recorded there.

The control plane (docs/08) is neither kind. It is the vendor's plane for hosting many
companies. A single company's organisation is a server plus Kubernetes box allocation, and
needs no control plane. The person who manages a hosted tenant is an *account holder*
(账户持有人), the glossary's word (docs/glossary.md decision 4).

## 1. Why: what the one-model reading got wrong

docs/36 §0 (`docs/36-enterprise.md:21-37`) answered the edition question with one data model:
a personal edition is "one Principal (admin), one box, `members: everyone`", and an
enterprise is "the same core run as a server with the multiuser data filled in". That answer is
right about the **code** and stays right: the core is byte-identical, a roster with one
Principal is an ordinary roster, and the two gates of docs/22 §0 work at both sizes.

It was wrong about the **installation**, in three ways that INV-1685 made visible:

- **"Degenerate" invites growth.** If the personal shape is a small multiuser shape, then
  adding a second person is a small step. INV-1685 built exactly that step:
  `guardRoster` refuses a second person with `OwnerConversionRequired`
  (`src/host/installation.ts:59-64`), and `convertToOrganisation` flips the mode on a person's
  yes (`src/host/installation.ts:129-140`, served as `POST /api/installation/convert`,
  `src/web/installation-routes.ts:14`). The result is a multi-person installation whose doors,
  routines and other people's work run on somebody's laptop — the failure shape docs/36 §3
  says the server exists to prevent (`docs/36-enterprise.md:198-200`).
- **What is personal leaks when the roster grows.** The Owner's model keys, the Grok Bot login
  in the VM box, their memory and their records were put there by one person for one person.
  A conversion hands all of it to the organisation's Admins by a roster write. No permission
  check can undo that, because docs/22 §0 says what a box holds is what everyone in it may
  reach.
- **The app could point at one place only.** docs/36 §0 gave the shell one new mode, "connect
  to a running installation" (`docs/36-enterprise.md:39-43`), so the app was *either* the
  personal product *or* an organisation's console. A person who has both — their own computer
  and their company — needs both at once, in one window.

Route B keeps the one core and draws the line one level up: what an installation *is* is
fixed when it is made.

## 2. The personal installation

| | |
| --- | --- |
| Who | The Owner, alone. `installation.mode` is `single-machine`; the Owner is `local:owner` with role `admin` (`src/host/installation.ts:26-38`, docs/22 §1a). |
| Made by | The desktop app's first start: the Electron shell starts `agentbox web --desktop` (`electron/main.cjs:142-144`), and `ensureOwner` creates the Owner on an empty roster (`src/host/installation.ts:103-122`). Unchanged by this record. |
| Boxes | The local Docker box, and VMs the Owner runs, joined with `box attach` (docs/30 §3, the `attached` provisioner). The Grok Bot box is this shape. |
| Credentials, routines, records | On this computer, under `~/.agentbox`, as today. Nothing is copied to an organisation. |
| Channels | The Owner's own IM apps may be connected. A channel admits only the Owner: there is nobody else on the roster to admit. |
| Adding a person | Refused, always. Every entry point — invite code, adding by hand, approving a knock, directory import — answers that this installation has one person, and points to joining or creating an organisation. INV-1689 makes the refusal the only answer and removes the conversion. |

"Personal box" keeps its docs/36 §1 Scene 4 meaning: a box *inside an organisation* whose
member set is one person. It is not a personal installation, and it lives on the
organisation's server under the organisation's records.

## 3. The organisation installation

| | |
| --- | --- |
| Who | Admins, drivers and viewers: the roles of docs/22 §0's outer gate. No Owner: `installation.mode` is `organisation` (or absent, `src/host/installation.ts:48-56`). |
| Made by | A server start: `agentbox web` without `--desktop`. The first Admin redeems the bootstrap code (docs/36 §1 Scenes 0–1, §2). Unchanged. |
| Boxes | Allocated on Kubernetes, one pod per box (INV-1692), reusing the allocator docs/08 §4.2 describes — not a second implementation. The common box, department boxes and personal boxes of docs/36 §1 Scene 4 are all such boxes. Box membership is docs/22 §2's inner gate, unchanged. |
| Shared things | Agents, channel and model credentials, routines, memory and records live on the server. |
| Reached from | A browser, the IM channels, the side door, or the desktop app as one of its connections (§4). Nothing an organisation owns runs on, or is stored on, a member's computer. |

## 4. The app is a client of several installations

- **Two levels.** The first level lists installations: personal first, then each organisation
  by name. Selecting one shows its boxes and agents, its tasks and its Settings, and nothing
  from any other installation. A summary line may say that another installation has N items
  that need the person; the items themselves are read inside that installation (INV-1691).
- **The personal installation is always local.** The shell keeps spawning it, as
  `electron/main.cjs:142-147` does today. Its UI token stays where it is, in
  `~/.agentbox/ui-token` (`electron/ui-auth.cjs`), because it belongs to the server on this
  computer.
- **An organisation is a connection, not a process.** Joining one stores its name, its address
  and the person's identity there. Nothing is started locally for it. The session token the
  organisation issued is kept in the operating system's keychain (macOS Keychain first) — never
  in page storage (`localStorage`), and never under `~/.agentbox`. Leaving an organisation
  deletes the connection and its token on this computer; the organisation's Admins revoke it on
  theirs (INV-1690).
- **One identity per connection.** A person who is the Owner at home and a driver at work is two
  Principals in two rosters, with nothing linking them. Each installation's two gates (docs/22
  §0) decide only about its own Principals.

## 5. Crossing the boundary: the side door only

Default: closed. A personal agent cannot see an organisation's boxes, agents, memory or
records, and an organisation cannot see anything in a personal installation.

To hand work to an organisation, the person asks that organisation for an MCP token (Settings →
Mine → Your MCP tokens, on the organisation's server; tokens are per Principal,
`src/web/mcp-tokens.ts:60-71`). The personal agent calls the organisation's `/mcp` with it:
`assign_task`, `task_status`, `fetch_deliverable` and the rest of docs/33 §8's ten tools. This is
the same mechanism INV-1668's skill pack teaches Claude Code and Codex (`agentbox skill
install`). Consequences, all already true of the side door:

- the task runs as the person's Principal *in the organisation*, under that organisation's
  roles, box membership and approvals;
- the task, its reply and its deliverables are recorded in the organisation;
- the token is the organisation's to revoke, and revoking it ends the crossing.

Not provided, on purpose: a shared filesystem between installations, an agent that belongs to
two installations, copying a credential from one to the other, or a single task list across
installations. Each would be a second authority hiding inside one agent, the same reason
docs/30 §2 gives for boxes.

## 6. The organisation and the control plane

| | Organisation installation | Control plane (docs/08) |
| --- | --- | --- |
| For | One company | The vendor, hosting many companies |
| Is | One server running the core, plus Kubernetes allocating its boxes | Gateway, allocator, store, collector; never in the path of a turn (docs/08 §1) |
| Unit of allocation | One box (INV-1692) | One tenant: one live box per tenant (docs/08 §6) |
| Top person | Admin (管理员) | Account holder (账户持有人); the code value stays `owner` (`src/control`) |

docs/08's Kubernetes allocator is **built and verified against a fake API server, not a real
cluster** (`docs/08-control-plane.md:126`). INV-1692 is the first use that must be verified on
a real one.

## 7. Statement by statement: what stands, what is revised, what is void

*Keep*: true as written. *Revise*: the idea stands, the text changes (applied in the same
commit as this record; for docs/36, a decision record, as a dated note beside the statement).
*Void*: no longer true; the note says so and points here. Line numbers are the files at
`3c0f8e3`, before the notes and revisions this record adds.

| Where | Statement | Verdict | What changes |
| --- | --- | --- | --- |
| docs/36 §0 (`:21-24`) | One core, byte-identical in both shapes; the shell is a supervisor | Keep | — |
| docs/36 §0 (`:24-29`) | A personal edition is the degenerate case of the multiuser model | Void | A personal installation is its own shape, fixed for life (§0 here). The records are the same kind; the roster never grows. |
| docs/36 §0 (`:29-32`) | Enterprise = the same core as a server, plus box hosts elsewhere and managed credentials | Revise | Box hosts are Kubernetes-allocated boxes (§3). |
| docs/36 §0 (`:34-37`) | The control plane is neither edition; a single company does not need it | Keep | Sharpened in §6: organisation = server + Kubernetes box allocation. |
| docs/36 §0 (`:39-43`) | The shell gains one mode, connect to a running installation; the app is the personal product *and* the admin's console | Revise | Not a mode: the app holds the personal installation and any number of organisation connections at once, for every member, not only Admins (§4). |
| docs/36 §1 Scenes 0–3, 5 | Server start, bootstrap, channels, directory sync, the company arriving | Keep | — |
| docs/36 §1 Scene 4 (`:106-108`) | 研发部's box on box host B, an attached box | Revise | Allocated on Kubernetes (§3). Personal boxes within quota stay: they are organisation boxes with one member (§2). |
| docs/36 §1 Scene 6 (`:136-139`) | The admin's seat is the app in connect-to-server mode | Revise | The admin's app connects to the organisation beside their personal installation (§4). |
| docs/36 §1 (`:145-149`) | A single company runs on its own metal; no control plane | Keep | Its metal includes its Kubernetes cluster. |
| docs/36 §2 (`:153-166`) | The bootstrap code is the server's first-Admin path | Keep | — |
| docs/36 §2 (`:168-171`) | The desktop's first start creates the Owner; the shell passes `--desktop` | Keep | — |
| docs/36 §2 (`:172-174`) | A desktop installation that lets a second person in converts into an organisation | Void | Never converts (§2). INV-1689 removes `POST /api/installation/convert` and the dialog. |
| docs/36 §3 rows: core, credentials, channels, TLS, audit, control plane | What lives where | Keep | — |
| docs/36 §3 row: box | Personal: first box plus one attached; enterprise: more by attach or provision | Revise | Personal unchanged; organisation boxes by Kubernetes. |
| docs/36 §3 row: login / directory / RBAC | Present but dormant on personal; gated by data, not edition | Revise | On a personal installation, other people are refused by construction, not dormant. |
| docs/36 §3 row: Electron shell, and `:192-200` | Connect-to-server mode; the app is the seat, never the host | Revise | Several connections at once (§4); "never the host" is kept and strengthened: an organisation connection starts nothing locally. |
| docs/36 §3 (`:202-206`) | Deployment unit; scaling out is more `box attach` rows | Revise | Scaling out is more Kubernetes-allocated boxes; the installation stays singular (kept). |
| docs/36 §4 stage 5 | Box hosts attach flow polished | Revise | Kubernetes allocation (INV-1692). |
| docs/36 §4 stage 7 | Electron connect-to-server, a target selection | Revise | Connections (INV-1690) and the first level (INV-1691). |
| docs/36 §5, §6 | Owner's 2026-09-03 rulings; the six-lens baseline | Keep | §5.2's personal default of one box plus one attached box is this record's personal shape. |
| docs/22 §0 (`:24-41`) | Two gates, no third layer | Keep | Each installation has its own two gates. |
| docs/22 §0 (`:52-53`) | No enterprise/personal distinction exists to encode | Revise | True of boxes; the installation has two kinds (§0 here). |
| docs/22 §1 (`:57-63`) | The entities | Revise | One sentence: a Principal belongs to one installation. |
| docs/22 §1a (`:80-88`) | The mode field, not a fourth role | Keep | `single-machine` is the personal installation. |
| docs/22 §1a (`:89-98`) | Who creates the Owner; the unsigned operator is the Owner | Keep | — |
| docs/22 §1a (`:99-105`) | The conversion | Void | The code still converts until INV-1689 lands; the section says so. |
| docs/22 §4 (`:253-…`) | Ids are identity; incarnations revoke | Revise | A bullet: identities are per installation, and the side-door token is the only crossing. |
| docs/08 (`:10-13`) | "Design for the multi-user system: many people, each with a box" | Revise | The vendor's plane for hosting many companies; one company is an organisation installation. |
| docs/08 §1–§3, §5–§9 | Never in the turn path; components; tenant as the unit | Keep | — |
| docs/08 §4.2 (`:126-138`) | Kubernetes allocator: built, fake API only | Keep | Plus: an organisation's per-box allocation reuses it (INV-1692). |
| docs/02 §5 (`:136-143`) | Personal = degenerate case; a company adds boxes by attach | Revise | The two kinds of installation; Kubernetes for the organisation. |
| docs/glossary.md decision 4 | Admin: a server, or a desktop that let a second person in | Revise | Admin is an organisation's; adds the installation row. |
| docs/manual (README, channels) | Letting a second person in asks first, then converts | Unchanged here | They describe what the app does today; INV-1689 changes the behaviour and these pages together. |

## 8. Questions this record leaves to Chris

1. **Desktop installations that already hold several people.** A roster with no
   `installation` field reads as `organisation` (`src/host/installation.ts:48-51`), so a desktop
   that let people in before INV-1685 is today an organisation running on a laptop. INV-1689
   keeps such installations as they are. Should they be told to move to a server, and is there
   a migration?
2. **May an organisation attach a box?** This record says an organisation's boxes are allocated
   on Kubernetes. Whether `box attach` stays available to an organisation, for a VM the company
   already runs, is not decided here.
3. **Group chats in a personal installation.** The Owner's agent may sit in an IM group with
   other people who are not on the roster. Whether it answers them as guests is unchanged by
   this record and still governed by the channel's group rule.
