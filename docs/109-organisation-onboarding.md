<!-- doc: 109-organisation-onboarding
     title: Joining an organisation: activation, a box and an agent each, the first chat, and what boxes share
     family: spec
     status: current
     domain: organisation-onboarding
     updated: 2026-11-28
-->
# Joining an organisation: activation, a box and an agent each, the first chat, and what boxes share

An organisation runs LumenBox on its own Kubernetes (docs/95 §3). Its people are in a DingTalk or
Feishu organisation. This says what happens, step by step, from the first Admin to a member's
first message, and how boxes that are private to one person share anything at all. It replaces
docs/107: what 107 decided about signing in and leaving stands and is restated here; what it
decided about when a person and their box come to exist is changed (§2).

Decided with Chris on 2026-11-27. §9 says what is built.

## 1. Why a box each

A member's agent works **as that member**: it runs the tools they would run, signed in as them —
the first case being the DingTalk command line, logged in with the member's own account, reading
the member's own data. A credential lives in the box's files. In a box several people share,
every agent runs as one user in one home: one person's login is readable by another person's
agent, and "private agent" is not a boundary (docs/10 S-7). **The box is the boundary.** So a
person whose agent holds their own credentials has a box only they may enter.

The quota already says who that is (docs/36 Scene 4): person, else department, else the
installation default. Quota ≥ 1: a personal box. Quota 0: no box of their own; they are a member
of a shared box and use its agents under a shared identity. For an organisation whose members
all sign in to their own accounts, the default is 1.

## 2. The steps

| | Step | What happens |
|---|---|---|
| o | The first Admin | The server makes a one-use code in a file on the server (24 hours). The operator opens `/bootstrap`, enters it, and signs in through the door: they are the first Admin. The door's app credentials come from the server's environment (the manifest's Secret), so nothing has to be set in a page before anybody can sign in. The Admin is a member like any other: step a applies to them. |
| a | An Admin activates a person | Four things, at once: **(1)** they are on the roster, at the role chosen, holding the door identity the directory gives; **(2)** their personal box is created, if their quota allows one; **(3)** their agent is created in it; **(4)** they are told — the bot writes to them in the door's chat that their assistant is ready, with the address to open. Only an Admin activates; one person, or everybody a department lists at that moment (docs/107's rule, kept). |
| b | The member opens the app or the page | They enter the organisation's address, sign in through the door, and land in the conversation with their own agent. A box still starting shows its progress. The first time, the agent offers the set-up their work needs (§5). Somebody not activated sees "your request is with the Admins" and is on the Admins' list. |
| c | The member's first direct message to the bot | It reaches **their own agent**, with no `@`. A member with quota 0 reaches the shared box's default agent. Somebody the directory lists who is not activated is told their request is with the Admins — the same request, the same list as scanning. Somebody the directory does not list is refused politely. A viewer is told they can watch and not instruct. |
| d | A message in a group | Unchanged for now, and not relied on. When it is built: the bot answers only when addressed, the asker's own agent answers, and the answer says whose assistant it is. |

### What changed from docs/107

docs/107 made an activation a record that became a person only at their first web sign-in. That
kept a rule ("a directory row never creates a person") and cost three things: a box could not be
made before the person signed in, the chat did not know an activated person, and a person who
only ever used chat never arrived. The rule's purpose is kept another way: **the Admin's act
creates the person, not the directory row**, and the identity they hold is one only the vendor
can vouch for — a sign-in or a chat event from that account. Nobody else can present it.

## 3. Activation, exactly

- **The person.** A roster person with the identity `<door>:<subject>` from the directory
  snapshot, the chosen role, and the record of who activated them, when, and from which department.
- **The box.** Created through the member's own creation path, within quota, as soon as the
  person exists. An installation setting chooses "at activation" (the default) or "at first use",
  for an organisation that will not hold a pod for people who never come.
- **Many at once.** A department activation makes the people immediately and queues the boxes: a
  few start at a time, the page shows how many are ready, waiting and failed with the platform's
  reason, and the press says what it will ask of the cluster (people × the box's memory) before
  it is confirmed.
- **The agent.** One, from the organisation's member template if an Admin set one
  (`lumenbox-template/1`), else the built-in assistant. A member adds agents, roles and skills
  of their own afterwards. Not the four-agent starter team: that is a personal installation's.
- **Telling them.** One message through the door to the person, if the vendor lets a bot write
  first; if not, the Admin's page says who has not been told. Never a credential in it.
- **Out of quota, or the box fails.** The person exists and can sign in; the page and the
  Admins' list say why there is no box. Nothing is retried in a loop.
- **A viewer.** On the roster, no box, no agent of their own.

Kept from docs/107 without change: admission is by an Admin and never by being listed; a
department activation is one-off; a sync that no longer lists a person ends the sign-in the
directory gave, keeps their box for the Admins, and holds itself when it would end many at once;
a department cannot be activated as Admins; a sync never removes the last Admin.

## 4. Who a message reaches

- **A direct message** from a roster person goes to their **home agent**: the agent made for
  them at activation, changeable by them. With no home agent (quota 0, a viewer) it goes to the
  door's default agent, which lives in a shared box.
- **`@Name`** names an agent among those in boxes the speaker may enter, their own box first.
  Two members' agents with one name never collide.
- **An agent reaches its person** in the door's chat without having been written to first: the
  route is the person, not the last chat.
- **Role and box membership** are checked as on the page (docs/22): a viewer instructs nobody.

## 5. Tools a member's work needs, and their own sign-ins

The image does not carry every tool an organisation uses, and should not. A tool arrives as a
**skill**: it says how to install the tool and how to sign in. Two rules make that work in a box:

- What must survive an image update lives in the box's kept volumes (the work volume, the
  browser-profile volume). A skill installs there and keeps credentials there; anything else is
  gone at the next update.
- A sign-in is the member's act. The agent asks, shows the link or the code in the conversation
  or hands over the desktop, and never types a password (docs/15). The first conversation offers
  the sign-ins the organisation's skills declare.

## 6. What boxes share

**A box is private; sharing is an act, and it goes through the server.** The server already holds
the roster, the knowledge and the audit. Sharing through it leaves a record of who shared what,
can be limited by person and department, and does not depend on the cluster's storage. A volume
every box can write is what this replaces: it is the shared box's problem again, with
credentials one misplaced file away.

| What | How | State |
|---|---|---|
| Knowledge | The organisation's knowledge (docs/98) lives on the server; every box's agents read it; an item is recalled once a person stands behind it. | Built. To add: a simple way for a member's agent to offer something, and visibility by department |
| Skills | **Organisation skills**: an Admin publishes a skill; the server keeps it and places it, read-only, in every box at start and on change, as a second skill directory. A member's own skill can be offered for promotion and an Admin decides, as knowledge is. | Publishing and placing: built (docs/93 §1a says what read-only means in a box, and the rule for a name both have). Promotion from a member: not built |
| Files and data | An agent publishes a file to the organisation, a department or a person; the server keeps it with its origin; another box's agent fetches what it may see. Built on deliverables. | Not built; detailed when a case needs it |
| A shared box | For people with quota 0 and for an agent that belongs to no one person: a box whose members are everyone or a department, on the cluster. | Designed (docs/36 Scene 4, docs/95 §3); not built for the Kubernetes backend. Later |

## 7. What must hold

- The identity a person is given at activation is exactly the one the door's sign-in and chat
  carry (verified for DingTalk and Feishu in the code; to be verified against a real organisation).
- An activation, a department activation, a box made for somebody, and a skill published to the
  organisation are each audited with who did it.
- Creating boxes for many people cannot exhaust the cluster by accident: queued, bounded, shown.
- An organisation skill cannot be changed from inside a box, and a box's own skill of the same
  name does not silently replace one the organisation requires.
- Nothing here weakens docs/106 §5: sign-in, the token and HTTPS are as that section says.

## 8. Found while writing this (bugs, fixed on their own)

DingTalk messages are not marked as direct or as addressed, so a stranger's direct message is
treated as a guest turn and "answer only when addressed" does nothing there; a door with a room
allow-list refuses every DingTalk message, direct ones included; a viewer who writes to the bot
is told they are not on the list; a stranger's request lives in memory and is lost at a restart;
the first-Admin page names only Feishu and sends the operator to a page the private level no
longer opens with a token.

## 9. Order, and what stands

| Step | State |
|---|---|
| Sign in through a DingTalk door; activation by person or department; leaving; the sync brake (docs/107) | Built (INV-729, INV-2202) |
| A box made at the first page load | Built (INV-2203); kept as `personalBoxAt: "first-use"` |
| 1a. Activation makes the person, the box and the agent; the setting; activations from before become people (home format 2) | Built (INV-2220). The agent is made when its box has started, not at the reservation: an agent needs its box in the registry. The member template is a `config.json` key (`memberTemplate`), not yet a page setting. A third value, `"never"`, is what `autoPersonalBox: false` meant |
| 1b. The page that shows a department's boxes starting and what the press asks of the cluster; telling the person through the door | Not built |
| 2a. A direct message reaches the person's own agent; `@Name` among the speaker's boxes; a person chooses their home agent (`POST /api/me/home-agent`) | Built (INV-2221, `src/host/chat-route.ts`). A person whose box is still starting is told so before the door's default is tried. The page does not yet mark the home agent |
| 2b. An agent reaches its person; a direct message from somebody listed and not activated becomes a request | Built (INV-2221). `src/host/reach-person.ts`: whose an agent is (the one person its box is for, else the one person whose home agent it is), and one sending path to a person through a door they hold — by the direct chat they wrote in, else by the person's own chat key (`src/channels/person-chat.ts`: DingTalk's one-to-one send by user id, Feishu's message to an open_id). An agent's question, an approval it needs and a task's notice go there when no chat asked for the work. A door with a synced directory keeps no knock of its own: somebody it lists has the durable request and is told so, somebody it does not list is told that; `POST /api/channels/approve` on such a request is the activation. A door with no directory behind it, and a single-machine installation, knock as before. The page marks the home agent and changes it |
| 3. The first conversation offers the sign-ins the organisation's skills declare | Not built |
| 4. Organisation skills | The library, publishing by an Admin, placing in every box read-only, the collision rule and the Settings block: built (INV-2222, docs/93 §1a). A member offering a skill for promotion, and a skill declaring a tool and a sign-in: not built |
| 5. The bugs of §8 | Not fixed |
| 6. A shared box on the cluster; a group answered by the asker's agent; files between boxes | Later |
