<!-- doc: 96-box-hosts
     title: Where a box runs is a second axis: personal machine, personal + organisation, organisation node
     family: decision
     status: current
     updated: 2026-11-06
-->
# Where a box runs is a second axis: personal machine, personal + organisation, organisation node

Status: **decided by Chris, 2026-11-06 and 2026-11-07 (INV-1687 route B; this record
INV-1695).** docs/95 drew one line, between two kinds of *installation*: who decides, and where
the records and credentials live. It did not say which machine provides a box to which
installation, and that is where the personal / organisation boundary actually runs on a
person's desk. This record adds that second axis. It does not rewrite docs/95, which is a
decision record. It cites docs/95, answers the three questions docs/95 §8 left open (§6), and
lists what it keeps or revises in docs/95, docs/30 and docs/22 (§7). Nothing in the code
changes with this record. INV-1696 builds the first-run choice, INV-1697 builds the
organisation node, and INV-1698 merges one person's channel identities into the Owner.

## 0. The decision, in six sentences

1. **Two axes, not one.** The *installation* axis says who decides (personal: the Owner;
   organisation: its Admins; docs/95 §0). The *box host* axis says where a box runs: this
   computer's Docker, a VM, a Kubernetes pod, or a machine's native environment. A person reads
   the box host as the **machine** (机器) the box runs on (docs/glossary.md).
2. **Every box belongs to exactly one installation**, whatever machine it runs on, and that
   installation's roster and box membership decide who may use it (docs/22 §0 and §2: the
   two gates). A machine never splits one box between two installations.
3. **A personal installation never provides a box to an organisation.** Its boxes are its
   Owner's. To use an organisation's boxes, the Owner works inside the organisation, as their
   Principal there, or through the organisation's side door (docs/95 §5, docs/33 §8).
4. **The first run asks what this machine is for, and offers three answers:** a personal
   machine (个人的机器), personal + organisation (个人 + 组织), or an organisation node
   (组织的节点). The answer decides whether a personal installation is made here and whose the
   local boxes are (§3).
5. **An organisation node is a machine the organisation owns.** It has LumenBox installed, no
   personal installation, and no personal activity. Every box on it — Docker, or the machine's
   native environment — is attached to the organisation and managed by it.
6. **A machine's native environment is a kind of box.** It is the `host` box kind that exists
   today (INV-438). An organisation gets one only on an organisation node, and it follows the
   rules of every box: its channels, stopping it, revoking it and its records are the box's.

## 1. Why: what docs/95 left implicit

docs/95 fixed the installation and assumed the rest. Four facts in the tree show that the box
host is a separate question, and that nothing answers it yet:

- **The code already has four box hosts.** `BoxKind` is `"docker" | "attached" | "host"`
  (`src/box/boxes.ts:21`); a server adds Kubernetes pods through `KubernetesBoxDriver`
  (`src/box/kubernetes-box.ts:43`, INV-1692). `host` is a machine's own environment: `agentbox
  host up <name>` starts the box daemon headless on loopback, with the granted directories as
  its only roots (`src/cli.ts:633`, `src/boxd/headless.ts:1-12`).
- **One host axis is already enforced, by accident of the backend.** A desktop installation
  cannot use Kubernetes: `provisionedBoxDriver` refuses `AGENTBOX_BOX_BACKEND=kubernetes` when
  the process is the desktop app (`src/box/kubernetes-box.ts:95`). The rest of the axis is
  enforced nowhere.
- **Any machine can give a box to any installation that hands it a code.** `agentbox box
  connect --control <installation> --code lbx-…` registers the machine's daemon as a box there
  (`src/cli.ts:582`, `POST /api/boxes/register` at `src/web/server.ts:3220`; docs/30,
  "Connection codes"). The code is checked against the installation that minted it. Nothing
  asks whose machine it is. A personal computer running `host up` and `box connect` against an
  organisation would hand the organisation a shell on the Owner's own disk, beside the Owner's
  model keys and logins. docs/95 §1 refused that exact leak for a roster write. This record
  refuses it for a box.
- **"The person's own machine" means the orchestrator's machine.** `RunOnHost` runs a command
  "on the machine LumenBox runs on, outside your box" (`src/host/host-runner.ts:1-2`,
  `src/host/tools.ts:1865`). On a personal machine that is the Owner's computer. An
  organisation's orchestrator runs as `hostd` in a pod (`deploy/kubernetes/control-plane.yaml:82`),
  so the organisation's `RunOnHost` would run in that pod and reach no machine the organisation
  owns. The organisation needs a box on that machine, not a host command.

## 2. The two axes

Rows are box hosts and columns are installations. Each cell says whether a box of that host may
belong to that installation.

| Box host (what a person reads) | Code | Personal installation | Organisation installation |
| --- | --- | --- | --- |
| **this computer** (本机) — Docker | `kind: "docker"`, `src/box/docker.ts` | Yes: the default box, made on the first run | Only on an organisation node (§4) |
| **a VM** — joined with `box attach` or a connection code | `kind: "attached"`, `attachedBox` (`src/box/boxes.ts:114`); `docker/box/lumen-bridge.sh` prepares one | Yes: a VM the Owner runs (the Grok Bot box) | Yes: a VM the organisation runs (§6, Q2) |
| **the organisation's cluster** — a Kubernetes pod | `KubernetesBoxDriver`, `AGENTBOX_BOX_BACKEND=kubernetes` | No: refused on the desktop (`src/box/kubernetes-box.ts:95`) | Yes: the default and preferred host (docs/95 §3, INV-1692) |
| **native environment** (原生环境) — the machine itself, without a container | `kind: "host"`, `agentbox host up`, `box connect --kind host` | As today: `host up` on the Owner's own computer (INV-438), beside `RunOnHost` | Only on an organisation node (§5) |

Two rules hold in every cell:

- **A box has one installation.** It is in that installation's `boxes.json`, its members are
  that roster's Principals (`BoxEntry.members`, `src/box/boxes.ts:23-39`), and its records are
  written there. A box listed in two installations would be two authorities on one machine:
  the reason docs/30 §2 gives for refusing an agent with two boxes.
- **A machine's owner decides which installation its boxes join.** The Owner's computer and the
  Owner's VMs join the personal installation. The organisation's machines and VMs, and its
  cluster, join the organisation. Nobody else's machine joins either.

## 3. The first run: three answers, and what each puts on this machine

INV-1696 asks on the first run, before anything is created. Each answer is one sentence of what
this machine holds and whose it is.

| Answer | On this machine, and whose it is |
| --- | --- |
| **Personal machine** (个人的机器) | A personal installation and its Docker box, both the Owner's; nothing here belongs to an organisation. |
| **Personal + organisation** (个人 + 组织) | The same personal installation and Docker box, the Owner's alone, plus a connection to an organisation that runs elsewhere; the local boxes are never offered to the organisation. |
| **Organisation node** (组织的节点) | No personal installation; LumenBox runs as a node of one organisation, and every box here (Docker or the native environment) is that organisation's. |

What each answer makes:

- **Personal machine.** Today's first run, unchanged: the shell starts `agentbox web --desktop`
  (`electron/main.cjs:142-144`), `ensureOwner` makes the Owner (`src/host/installation.ts`,
  docs/22 §1a), and the Docker box is the first entry of `boxes.json`. The Owner may attach
  VMs they run and may start a native environment with `host up`.
- **Personal + organisation.** The personal installation is made exactly as above. Then the
  app joins an organisation (INV-1690): the connection holds the organisation's name, its
  address and the person's identity there, with its token in the keychain (docs/95 §4).
  Joining starts nothing local for the organisation and registers no box with it. The
  person's work for the organisation runs in the organisation's boxes, on its cluster or its
  nodes.
- **Organisation node.** No `principals.json` with an Owner is written, and no channel, model
  key, routine or memory is set up. The machine is given the organisation's address and a node
  credential the organisation issued (INV-1697), and registers its boxes with the
  organisation (§4).

Changing the answer later (INV-1696): a personal machine may become personal + organisation by
adding a connection, and back by removing it. A personal installation and an organisation node
never turn into each other, for the reason docs/95 §0 gives for installations: what was put on
the machine for one person must not change owners by a setting.

## 4. The organisation node

| | |
| --- | --- |
| Owned by | The organisation. It is the organisation's hardware or a machine it rents; no person's account, logins or data are on it. |
| Runs | The box daemon for each of its boxes, and the node's own process that registers them and reconnects them. It runs no installation: no roster, no channels, no routines, no records. The organisation's server drives its boxes, as it drives a pod. |
| Boxes | A Docker box from the same image as a personal machine's, and/or the machine's native environment (§5). Each is a box of the organisation, with members the organisation's Admins set (docs/22 §2). |
| Joins by | A node credential an Admin issues in the organisation (INV-1697). It builds on what docs/30 "Connection codes" already does: a one-time code bound to one installation, redeemed into a long-lived credential kept on the runner. The new part is that the credential names a *node*, so the organisation can list a node's boxes and revoke the node. |
| Revoked by | An Admin, in the organisation. Revoking the node cuts off every box on it, as `POST /api/boxes/revoke` does for one box today (docs/30): its tools answer that the box is not running, and a reconnect is refused. |
| Reached by | The organisation's server, over a network path the node and the server share. Today's native environment listens only on loopback (`BOXD_BIND: "127.0.0.1"` in `cmdHostUp`, `src/cli.ts:633`), and lumen-bridge puts an attached VM on a tailnet (`docker/box/lumen-bridge.sh`). INV-1697 chooses the path; this record requires only that the node opens nothing to anyone but its organisation. |
| Not on it | A personal installation; another organisation's boxes; a person's channel; anything a person put there for themselves. |

"No personal activity" is a rule about the machine, not a rule against a person sitting at it.
Someone at the organisation's Mac uses it as the organisation's member: through the
organisation's app connection, browser or channels, as their Principal in the organisation, and
under its approvals and records.

## 5. The native environment as a box

The organisation node's native environment is the `host` box kind that INV-438 built, reached
the way an attached box is. It is not `RunOnHost`, which is the orchestrator's own machine
(§1).

| | `RunOnHost` (the orchestrator's machine) | Native environment box (`kind: "host"`) |
| --- | --- | --- |
| Where it runs | The machine the orchestrator runs on (`src/host/host-runner.ts`) | The machine the box daemon runs on, headless (`src/boxd/headless.ts`) |
| Whose | The installation that runs there: on a personal machine, the Owner's | The installation the box is attached to: on a node, the organisation's |
| What it reaches | A configured working directory, under the OS sandbox (`src/host/host-sandbox.ts`) | The granted directories only; anything outside them is refused (`src/boxd/headless.ts`) |
| Approval | Every command asks (`src/host/tool-permissions.ts:157`; tier `credential`, `src/host/side-effects.ts:112`) | Every write is reviewed as "writes on the person's own machine" (`src/host/turn.ts:3285`); the defaults stay conservative (INV-1697) |
| Desktop | — | None: the desktop routes answer 409, and no display is started (`src/host/orchestrator.ts:1463`) |
| Authority | Outside every box: an operator's decision, off by default | The box's own, by docs/22 §0: what it reaches, every agent in it reaches |

Its rules are the box rules, with no exceptions:

- **Channels.** A channel routes into this box like any other (docs/22 §2). Arriving through it
  grants nothing; membership is checked at admission.
- **Stopping and revoking.** Stopping the node's process stops the box. Revoking the box or the
  node cuts it off (§4). An unreachable box is reported and its agents wait. Nothing fails over
  to another machine (docs/30 §5).
- **Taking over.** A person steps in by stopping or redirecting the turn, as on every box. A
  native environment has no desktop to take over in this version (§8, question 2).
- **Records.** Every command and write is recorded in the organisation, under the agent and the
  person who asked. The node keeps no records of its own.
- **Uniformity.** Agents in the native environment box all reach the same directories. A
  directory only some of them may touch belongs in another box (docs/22 §0).

On a **personal machine** nothing changes: the Owner keeps `RunOnHost` and may run `host up`
for a native environment box of the personal installation (INV-438). That box is the Owner's,
and §0 sentence 3 forbids registering it with an organisation.

## 6. docs/95 §8: the three questions, answered

1. **Desktop installations that already hold several people.** On the machine that raised the
   question, Chris's own, the six Principals in `principals.json` were one person: Chris, seen
   through several Feishu apps (Feishu issues a user id per app), DingTalk and the web. So the
   desktop is a personal installation whose Owner was split across identities, not an
   organisation on a laptop. INV-1698 merges such identities into the Owner, after a preview
   and on the person's yes, and links later bindings from new channels to the Owner. A desktop
   that really let other people in stays an organisation, as INV-1689 left it (§8, question 1).
2. **May an organisation attach a box?** Yes. An organisation may `box attach` a VM it runs.
   Kubernetes stays the default and preferred host (docs/95 §3). The VM is the organisation's
   machine by §2's second rule, and so is an organisation node. A VM a member runs for
   themselves is a personal machine, and its boxes stay personal.
3. **Group chats in a personal installation.** Intended, as Chris confirmed. People in a group
   chat with the Owner's agent who are not on the roster are **guests**. They are not people of
   the installation, hold no role, and can never be let in: letting a knock in is refused on a
   personal installation (docs/22 §1a; `requireOrganisation`, `src/host/principals.ts:230`).
   What the agent does with a guest's message is the channel's guest switch and group rule
   (INV-429). With guests off, the channel answers `guests.closed`
   (`src/channels/manager.ts:1313`); otherwise the sender is told they are not registered. A
   guest's message never approves anything.

## 7. Against docs/95, docs/30 and docs/22

*Keep*: true as written. *Adds*: true as written, and this record adds the box host side.
*Revise*: the idea stands and the detail changes. *Answers*: an open question settled here.

| Where | Statement | Verdict | What this record says |
| --- | --- | --- | --- |
| docs/95 §0.1 | Two kinds of installation; neither turns into the other | Keep | It is the first axis (§2). The box host is the second. |
| docs/95 §0.2, §2 "Boxes" | A personal installation's boxes are local Docker and VMs the Owner runs | Adds | Also the Owner's native environment (`host up`, INV-438). None of them is ever offered to an organisation (§0 sentence 3). |
| docs/95 §0.3, §3 "Boxes" | An organisation's boxes are allocated on Kubernetes | Revise | Kubernetes is the default and preferred host. An organisation may also attach a VM it runs, and its nodes provide Docker and native environment boxes (§2, §4). |
| docs/95 §0.4, §4 | The app is a client of several installations; an organisation is a connection, not a process | Keep | "Personal + organisation" is that shape, chosen on the first run (§3). Joining registers no local box. |
| docs/95 §0.5, §5 | The only crossing is the side door | Keep | A personal installation reaches an organisation's node boxes only through the organisation, as the person's Principal there (docs/33 §8). |
| docs/95 §3 "Reached from" | Nothing an organisation owns runs on a member's computer | Keep | An organisation node is not a member's computer: the organisation owns it, and nothing personal runs on it (§4). |
| docs/95 §8 Q1–Q3 | Left to Chris | Answers | §6. |
| docs/30 §0 | A box is somebody's; a box brings its own logins | Keep | That "somebody" is the installation that owns the machine (§2). |
| docs/30 §1 | `boxes.json` is a list of boxes, each with a kind | Adds | The kinds are box hosts. Every entry belongs to the one installation whose `boxes.json` it is in. |
| docs/30 §2, §5 | No shared volume, no agent on two boxes, no automatic failover | Keep | They apply to a node's boxes too (§5). |
| docs/30 §3 | Provisioners: `docker`, `attached`, `compose` (and `kubernetes`) | Revise | The `host` kind (INV-438) is a provisioner the section did not list. It is a native environment box, and in an organisation it appears only on a node. |
| docs/30 "Connection codes" | A machine elsewhere becomes a box by a one-time code and keeps a runner credential | Revise | The mechanism stays. In an organisation it is how a node or an organisation's VM joins (INV-1697). A personal installation's machine never redeems an organisation's code. |
| docs/22 §0 | Two gates; a box is the unit of authority | Keep | A native environment box is a box: what it reaches, every agent in it reaches (§5). |
| docs/22 §0 (`:52-58`) | The personal/organisation distinction lives at the installation | Keep | The box host does not add a third gate. It decides which installation a box joins, and that installation's gates apply. |
| docs/22 §1 | A Principal belongs to one installation's roster | Adds | So does a box (one sentence added there). |
| docs/22 §1a | `single-machine` is the personal installation; it never adds a person | Keep | "Personal machine" and "personal + organisation" both make one. An organisation node makes none. |
| docs/22 §2 | Doors route; boxes authorize; one admission check | Keep | It applies unchanged to a node's boxes (§5). |

## 8. Questions this record leaves to Chris

1. **A desktop that really holds other people.** After INV-1698, a desktop roster may still hold
   people who are not the Owner, if it let them in before INV-1685. It stays an organisation
   running on a laptop. Should the app tell it to move to a server, and is there a migration?
2. **A native environment with a screen.** INV-1697's example is an organisation's Mac that runs
   business desktop apps. Today's native environment has no desktop and no `computer` tool
   (INV-438). Should a node's native environment also expose the machine's screen? That would
   be a new capability with its own approvals, not a setting.
3. **Refusing a personal machine's box at the organisation.** §0 sentence 3 is a rule today, not
   a check: any machine with an organisation's connection code can register a box. Should the
   organisation accept boxes only from a node credential or an Admin's `box attach`, and
   should the CLI refuse `box connect` to an organisation from a machine whose answer is
   "personal + organisation"? This record assumes both, for INV-1697.
