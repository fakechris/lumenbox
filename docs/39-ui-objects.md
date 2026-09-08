# The objects a person can see: box, agent, template

Status: **design, first version, 2026-09-08.** Written after two days of watching Grok Bot's
team flow (research/GROKBOT-2026-09-07-TEAM-WORKFLOW.md) and Chris's three observations on
2026-09-08: no need for agents in different boxes to talk to each other yet; two boxes
should look like two of the same thing, side by side; and after building templates
(docs/29) there is no place in the UI to *stamp one into a box* — "I want a designer bot in
the Grok box that creates a series of dev bots, and I cannot find where to start that."

The last point is the real one. The product has four objects a person needs to hold in
their head — a box, an agent, a template, and the work — and the page shows one of them
(agents) as a list, hides one in Settings (boxes), hides one in a textarea (templates), and
shows the last as a tab. This document says what each object is *to a person*, where it
lives on the page, what a person can do to it there, and in what order a new person meets
them. It changes the page; it does not change the host's model, which already has all four.

## 0. The mental model, in one paragraph

**A box is a computer.** It has a desktop, files, a shell, and the engines installed on it.
**An agent lives in exactly one box.** It has a persona, a chat, a memory, and the tools that
box gives it. **A template is a saved agent** — persona, skills, routines, conventions, never
history, never people — that can be stamped into any box to make a new agent. **Work** is
the board: tasks with contracts, proposals a person commits, evidence a reviewer reads.
Doors (Feishu, DingTalk, Telegram) are how people reach agents; they belong to a box.

Everything below follows from "an agent lives in exactly one box".

## 1. Boxes are tabs, and each tab is the same page

Today the page is one sidebar of every agent in every box, a desktop pane for the selected
agent, and boxes as a settings field. Two boxes read as one long list with a hidden
property on each row.

**Proposed:** a box bar across the top of the page, one tab per box (`Docker box`,
`Grok VM`), plus `+ box`. Selecting a tab shows that box's page, and every box's page has the
same structure:

```
[ Docker box ] [ Grok VM ] [ + box ]
┌──────────────┬──────────────────────────────────────┐
│ Agents   [+] │  Desktop · Files · Tasks · Automations │
│  Ada         │                                        │
│  Bob         │   (the selected agent's desktop, or    │
│  Mia         │    the box's own desktop when none)    │
│              │                                        │
│ Templates    │                                        │
│ Doors        │                                        │
│ Box          │                                        │
└──────────────┴──────────────────────────────────────┘
```

- The agents list is the box's agents only. `+` creates an agent **in this box** (§3).
- `Templates` opens the shelf (§2) with "stamp into this box" as its primary action.
- `Doors` lists the channels that reach this box, with the group rule (docs/11 item 7) and
  the default agent, moved out of Settings.
- `Box` is the box's own card: kind (docker / attached at 100.114.30.43), the image contract
  (engines carried, docs/11 item 11f), displays in use, engines installed on demand, disk,
  and the three actions a box has — restart, recreate from image, detach.
- The Tasks tab shows the box's board. Work is per box because agents are.

**Cross-box interaction is deferred**, and the UI says so by not offering it: an agent's
`SendToAgent` lists teammates in its own box; the roster verb in a door shows the box's
agents. The bus is per installation today, so nothing has to be torn down — the tool's
offered targets are filtered by box, and a message to an agent in another box is refused
with "they live in a different box". When a scenario appears that needs a courier between
boxes, it is a courier, not a loophole.

## 2. Templates have a shelf, and the shelf's verb is "stamp"

docs/29 built the file, the export skill, the import route and the share link. What it did
not build is a place. Today a template is reached by pressing `+` and pasting JSON into a
textarea labelled "Or import a template", and a shared template by opening a link that lands
on the same dialog. Nobody discovers that.

**Proposed:** `Templates` in the sidebar opens a shelf with three rows:

1. **Mine** — templates exported from agents here (docs/29 §4), newest version each, with
   the agent it came from and "N stamped".
2. **Shared with me** — imported by link, with the author's name.
3. **Catalog** — the built-in experts and crews (catalog.ts), shown the same way, because to
   a person they are templates that happen to ship with the app.

Every card has one primary button, **Stamp into `<this box>`**, and a secondary menu: stamp
into another box, preview (what is inside: persona, skills, routines, conventions), share,
download. Stamping asks one thing — the new agent's name, prefilled from the template — and
runs the docs/29 §5 import turn. The new agent appears in this box's list with "created from
the template X by Y" on its card (the field exists: `importedFrom`).

The `+` next to Agents becomes a three-way dialog that is really the shelf with a fourth
option: **blank** (name and a four-part persona: ONLY job / Anti-jobs / Voice / Wake, docs/11
batch one), **from the catalog**, **from my templates**, **paste or link**.

## 3. The team designer is a template, and it ships in the catalog

What Chris wanted to do in the Grok box — "a designer bot that creates a series of dev
bots" — is Grok's dr eggbot. Ours is a catalog entry, **Team designer**, whose persona is:
interview the person about the goal in at most three questions; propose two to four
agents, each with a four-part persona and a lane; wait for the person's yes; create them
with `CreateAgent` in this box; create the first tasks as *proposals* (docs/11 batch one)
that the person commits; then step back and only act when a lane is empty or two agents
collide. It never does the work itself (its anti-job). Its first-run cue (docs/11 batch one)
starts the interview at once when the persona names a goal.

This is one catalog file plus the persona text; the mechanisms it uses all exist. It is
also the answer to "where do I start a team": stamp Team designer into the box, tell it
what the team is for.

## 4. A new person meets the objects in this order

First run today shows the page with one starter team and no explanation. Proposed: a
**Set up** card at the top of the page that stays until its four steps are done, then
folds into the Box card.

1. **A computer for the agents** — create the Docker box, or attach one (the Grok VM path
   from docs/35). Done when a box answers `/health`.
2. **Your first agent** — stamp one from the catalog (Team designer is first in the row),
   or keep the starter team. Done when an agent has had one turn.
3. **A door** (optional) — connect Feishu, DingTalk or Telegram to this box, set the group
   rule. Skippable; the card says the page itself is a door.
4. **First work** — give the agent a task from the Tasks tab or say it in chat. Done when a
   task reaches review.

Each step names the object it introduces, in the words of §0, so the vocabulary is learned
by doing rather than read.

## 5. Object cards: what a person can know by looking

Hovering or opening any object shows a card with the same shape: what it is, where it
lives, what it can do, what it came from.

- **Box**: kind and address; image contract (engines baked in), engines installed on
  demand with versions; displays in use; disk; doors attached; agents living here.
- **Agent**: the four persona parts; tool tier; the box it lives in; created from which
  template by whom; last turn; what it is waiting on (a consent, a secret, a hand-back,
  a review) — the cards from docs/11 batch two surface here too, not only in the consent
  strip.
- **Template**: name, author, version; what is inside (persona, skills, routines,
  conventions); which boxes it has been stamped into; the share link if published.
- **Task**: the contract fields; proposed / committed; evidence; who checked what.

## 6. What changes in code, staged

**Stage A — boxes as tabs, agents per box (M).** `app-html.ts`: box bar from `/api/boxes`;
sidebar filtered by `boxId`; `+` creates into the selected box (`POST /api/agents` gains
`boxId`, which the registry already records as box ownership); Doors and Box panels lift
the existing Settings fields. `tools.ts`: `SendToAgent` targets and the door roster
filtered by box. No host model change.

**Stage B — the shelf and stamping (M).** `GET /api/templates/shelf` joins mine, shared,
catalog; `POST /api/templates/stamp {templateId|catalogSlug, boxId, name}` wraps the
existing import and catalog-install routes; the shelf panel and the three-way `+` dialog
in `app-html.ts`; `importedFrom` on the agent card.

**Stage C — Team designer and Set up (S/M).** One catalog entry; the Set up card driven by
four facts the server already knows (a box answered, an agent had a turn, a door is
configured, a task reached review); object cards.

Stage A first, because it is the frame the other two hang in, and because it is the one
Chris named twice.

## 7. Not in this design

- Agents talking across boxes (§1). Deferred until a scenario needs it.
- Moving an agent between boxes. An agent is created into a box; to have it elsewhere,
  stamp its template there.
- Feishu and DingTalk versions of the shelf. The shelf is a page thing; a door gets "stamp
  X" as a verb later if it is wanted.
