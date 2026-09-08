# The chat column, rebuilt: one grammar for everything that appears in it

Status: **design + stage one, 2026-09-08.** Chris, with three screenshots: a finished plan
card that will not go away; a teammate's message wedged between a person's and the agent's
with the same typography; the message toolbar sitting on top of the person's bubble; and the
verdict — "the same information shows up differently in different situations; patching is
making it worse; look at how Grok Bot does bot-to-bot messages and cards, and how Codex folds
work." He is right. docs/40 added verbs to the column without first fixing what the column
*is*. This document fixes that: every item in the column belongs to one of six kinds, each
kind has one appearance, and the live stream and the replay build it through the same code.

## 0. What Grok Bot and Codex do, from the screenshots and the VM read

**Grok Bot** (research/GROKBOT-2026-09-07-TEAM-WORKFLOW.md, and the three shots):

- Two voices only in the flow: the bot (left, grey bubble, sans) and the person (right).
  Everything else is either *under* a bubble or *is a card*.
- **Bot-to-bot, sending side**: the bot's bubble, then a right-aligned footer "Messaged
  ⟶ Involute Ops" with the recipient's avatar. Two recipients: "Messaged ● ● 2 Bots". The
  message text is the bubble above; the footer only says where it went.
- **Bot-to-bot, receiving side**: the incoming text appears in the recipient's chat as a
  bubble from the *sending bot* — its avatar, its name — as if it had spoken in this room.
  The model sees a cue ("this is another assistant, not the user"); the person sees a
  teammate speaking. Several in a row fold to one line: "5 messages with 2 Bots".
- **Cards** are bubbles with a fixed frame: a title row (icon, title, a status pill such as
  `● Done`), a body (one or two lines of the bot's own words), an optional disclosure
  ("Show the command"), and an actions row. Consent: "Allow Grok Bot and all Bots to run
  commands on your local computer?" + host name + "Show the command" + Always allow / Allow
  once / Never. Secret: "MiniMax API key" + one line of use + a masked field + "Save
  securely" + "Stored securely, never shown to your Bot". Computer: "Computer ● Done" + the
  bot's instruction + "Open computer". Cards keep their answered state in the thread.
- **Per-message actions** are a hover menu at the bubble's edge: reactions, Reply, Copy,
  Copy request ID. Nothing is drawn until you hover.
- A `NEW` divider at the first unread message.

**Codex app** (the shot): the agent's work is one folded line, "Worked for 29m 26s ›", above
the answer; the answer is plain prose; a row of five small icons *below* the answer (copy,
thumbs, share, anchor, …) — under, never over. Code blocks carry their own copy.

**The common law**: prose is prose; work is one folded line; anything that needs the person
is a card with a frame and a state; another bot speaking looks like another speaker; the
actions of a message live under it.

## 1. The six kinds, and the one appearance each has

| kind | who | appearance | actions |
|---|---|---|---|
| **person** | you | right-aligned bubble, sans, surface-2 background | under the bubble, right-aligned: copy · md · quote · link · resend |
| **agent** | the agent whose chat this is | left, serif prose, no bubble | under the text, left-aligned: copy · md · quote · link |
| **teammate** | another agent, speaking here | left bubble with that agent's colour dot and name, sans, a `teammate` chip; priority shows `priority`; several in a row fold to "N messages from M teammates ›" | copy · quote |
| **sent** | this agent messaging a teammate | one right-aligned footer line under the agent's prose: "Messaged ⟶ Kai" (text on hover) | open |
| **work** | what the agent did between two things it said | one line: "Worked for 2m 10s · 6 calls ›" — expands to the steps tree that exists today | fold/unfold; copy a result |
| **card** | something waiting on, or answered by, the person | a framed bubble: title row (icon · title · status pill), body, optional "Show the command", actions row; the answered state stays in place | the card's own buttons |

Dividers (day, NEW) and the jump-to-latest pill are furniture, not kinds.

The **plan card** is a card: title "plan · 8/8 done", body the list, folded by itself when
every item is done and openable again; never a block that cannot be closed.

## 2. One renderer

Live events and the replay both produce *entries* of the six kinds; one function draws an
entry. Today the live stream draws bubbles and steps with one set of code and the replay
with another, which is exactly why "the same information shows up differently". Stage one
keeps the two producers but routes both through the same drawing functions (`personMsg`,
`agentMsg`, `teammateMsg`, `sentFooter`, `workFold`, `card`). Stage two removes the second
producer.

## 3. Stage one (built today)

- Toolbars move **under** the message; the person's under the bubble on the right, the
  agent's under the prose on the left. Nothing overlays anything.
- A teammate's message is a **bubble with the teammate's name and colour**, full text,
  sans; a `teammate` chip; priority marked. An outgoing message is a right-aligned
  "Messaged ⟶ name" footer. Runs of three or more incoming fold to one line.
- The **work** fold reads "Worked for … · k calls ›" (duration from the timestamps around
  it) instead of "hide 1 step / working".
- The **plan card** folds itself when complete and can be opened or closed by hand; the
  state is remembered per thread.

## 4. Stage two (next)

- Cards inline in the thread (consent, question, secret, computer) with the Grok frame and
  a kept state; the strip above the chat goes away.
- One producer: the server's display entries carry everything the live stream carries.
- Reply-to: quote lands with a link back to the quoted message.
