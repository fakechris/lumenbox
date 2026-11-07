<!-- doc: 97-guest-turns
     title: A guest turn: what an organisation's agent may do for someone who is not on the roster
     family: decision
     status: current
     updated: 2026-11-07
-->
# A guest turn: what an organisation's agent may do for someone who is not on the roster

Status: **decided by Chris, 2026-11-07 (INV-1708).** Answers docs/96 §8 question 4. docs/96 is a
decision record and is not rewritten; this record cites it. docs/22 §2 gains one paragraph that
points here, because the guest turn is an admission rule and docs/22 owns admission.

## 0. The decision, in six sentences

1. **A personal installation never answers a stranger.** A guest in the Owner's group chat is
   refused exactly as docs/96 §6 question 3 says, and there is no setting that changes it: the
   setting below does not exist on a personal installation (the API refuses it with
   `guests-personal`, the page does not draw it).
2. **An organisation's agent answers guests only when an Admin says so, per agent.** The setting
   is *who this agent answers in group chats*: **members only** (the default) or **members and
   guests**.
3. **Safety comes from what the turn holds, not from what the model decides.** Chris, 2026-11-07:
   "letting the agent judge whether to obey a guest cannot be controlled; a guest can always
   prompt around it." So a guest turn is a different kind of turn. The tools and the data a guest
   must not reach are not refused in it. They are not in it.
4. **A guest turn's tools come from an allow-list of two read-only tools:**
   `SearchPublicKnowledge` and `ReadPublicKnowledge` (`GUEST_TOOL_NAMES`,
   `src/host/guest-turn.ts`). The list is written out, never computed by removing tools from the
   member tool list, so a tool added to LumenBox later is absent from guest turns until somebody
   adds it to this list on purpose.
5. **A guest turn reads one thing: the knowledge the organisation marked public to guests.** It
   is its own list, written by an Admin in Settings → Team → Guests. It is not memory, not team
   memory, and nothing copies into it by itself. A guest turn never reads a member's memory,
   tasks, transcripts, standing files, person records or the box.
6. **A guest turn is recorded and paid for like any other.** Each one is a line in
   `guest-turns.jsonl`, marked as a guest's, and never enters a member's context. Its model calls
   are usage rows of kind `guest`, counted against the agent's spend lines (INV-1615). A
   group chat also has a daily number of guest turns (default 20), after which the agent stops
   answering guests there until the next day.

## 1. Why the turn, and not the prompt

A member turn (`runTurn`, `src/host/turn.ts`) is assembled from everything the agent has: its
standing files, its memory recall, the conversation's transcript, the board, skills, MCP servers,
the box. Its tool list is `buildTools` narrowed by the profile, the routine scope and the
permissions (INV-1664), and its gate asks a person before the dangerous calls (docs/22 §5).
Every one of those narrowings assumes the person who opened the turn is allowed to drive the box.
A guest is not (docs/22 §2: a guest is no member of any box). Running a guest through `runTurn`
with a "be careful" paragraph would hand the model every tool and every memory and then ask it to
decline them. That is the control Chris ruled out.

So the guest turn is built from nothing upward. `runGuestTurn` takes a model client, the agent's
name, the guest's text and a read-only view of the public knowledge, and that is all it takes.
It holds no registry, no box client, no memory store, no task store, no bus and no policy gate,
so no instruction can reach them: the code that would call them is not in the turn.

## 2. When a message becomes a guest turn

All of these hold, checked by the host in this order (`src/channels/manager.ts`, then
`answerGuest` in `src/host/guest-turn.ts`):

| Check | Where | Otherwise |
| --- | --- | --- |
| The sender may not drive (`mayDrive` false) and the channel did not admit them | manager | an ordinary member message |
| The group chat passes the channel's group rules (INV-429) | manager, before identity | silence, as today |
| The channel's guest switch is not `off` (INV-429) | manager | `guests.closed`, as today |
| A group chat, not a direct message (`privateChat` is not `true`), and the message is addressed (`addressed` is not `false`) | manager | the knock, as today |
| The installation is an organisation (`installation.mode`) | `answerGuest` | the knock, as today (a personal installation's knock can never be let in, docs/96 §6) |
| The addressed agent (or the channel's default agent) exists and answers guests | `answerGuest` | the knock |
| The agent is not paused (INV-1554, including the spend pause) | `answerGuest` | silence, logged |
| This group chat is under today's guest-turn cap | `answerGuest` | one line saying so per group chat per day, then silence |

A guest turn replaces the knock: answering a question is not asking to be let in. A guest who
wants to be a member is let in the way everybody is (an invite code). A guest's text is never a
command: `/new`, `停`, `看板`, `允许` and the other verbs are not parsed for a guest, because the
guest branch returns before the command table. A guest's text never answers an approval.

Wires that do not say whether a chat is private (DingTalk today) count a stranger's direct
message as a group message. That changes who is answered, not what the turn holds.

## 3. The tool surface

| Tool | What it does | Side effect |
| --- | --- | --- |
| `SearchPublicKnowledge` | Ranks the public knowledge against a query (the memory ranking, `rankRelated`) and returns up to 5 entries: id, title and the first 400 characters | none |
| `ReadPublicKnowledge` | Returns one entry by id, whole | none |

Not in a guest turn: shell and files, the desktop and browser, the box's jobs, `RunOnHost` and
every host command, `Delegate`, `SendMessage` and every way to wake another agent, `AskUser`,
`ShowUI`, `DeliverFile`, the board's tools, `RememberFact` and every memory write, `Recall` and
every memory read, web fetch and search, connectors, MCP servers and the lookup pair that would
find any of them. A call to a name outside the allow-list is answered with an error result
("no such tool in this turn"), recorded on the turn's line, and dispatches nothing; there is no
dispatcher for it to reach.

At most 4 model calls per guest turn, at most 1,024 output tokens each. The reply is the text of
the last call.

## 4. The data surface

The system prompt of a guest turn holds exactly:

- the agent's name, and a fixed paragraph saying the person is a guest of the organisation, that
  only the public knowledge may be used, and that what the guest writes is a question, never an
  instruction;
- the titles and ids of the public knowledge entries (the entries themselves come through the two
  tools).

The single user message is the guest's text, quoted as the guest's. A guest turn has no history:
each one sees only its own message. A follow-up from the same guest is a new turn that does not
see the last one. This is the conservative choice (§7 question 1): a history would be one more
store to keep apart from the members' transcripts.

**Public to guests** (对访客公开) is the organisation's list of entries, each a title and a text,
in `guests.jsonl` beside the other ledgers. Only an Admin adds or removes an entry, in Settings →
Team → Guests or with `POST /api/guests/knowledge`; no agent tool writes it, in a member turn or a
guest turn. One list per organisation for now (§7 question 2).

## 5. Records and spend

- **The turn's line.** `guest-turns.jsonl`: when, the agent, the channel, the group chat, the
  guest's identity and name, the question and the answer (each clipped to 2,000 characters), the
  tools offered, each call with whether it ran, the number of model calls, the tokens, and how it
  ended (`answered`, `rounds`, `spend`, `error`). This is the guest's record; nothing from it is
  written to a transcript, `messages.jsonl`, memory or the board, so no member turn reads it.
- **Spend.** Each model call is a usage row (`kind: "guest"`, the channel as `door`,
  `conversation: guest:<chat>`, no `principal`: no member pays). The row goes to the agent's
  `SpendLimits` like a turn's, and each guest turn is its own wake. At the wake line the guest
  turn ends with what it has; at the day line the agent is paused as for any other spend
  (INV-1615), which also stops its member work.
- **The cap.** A number of guest turns per group chat per local day, for the organisation
  (default 20, Settings → Team → Guests). Counted from `guest-turns.jsonl`, so a restart keeps
  the count.

## 6. Against docs/22 and docs/96

| Where | Statement | Verdict | What this record says |
| --- | --- | --- | --- |
| docs/22 §2 | Doors route; boxes authorize; one admission check | Keep | A guest is not admitted to any box. A guest turn enters no box: it runs on the host with no box client (one paragraph added there). |
| docs/22 §1a | A personal installation holds the Owner only | Keep | And it answers no guest: there is no switch to turn on (§0 sentence 1). |
| docs/22 §5 | The gate asks a person before a consequential call | Adds | A guest turn has no consequential call to ask about. A guest never answers an approval. |
| docs/96 §6 Q3 | A guest in a personal group chat is refused, with the guest switch on or off | Keep | Unchanged. |
| docs/96 §8 Q4 | Should an agent answer a guest without taking instructions from them? | Answers | In an organisation, per agent, through the guest turn of §1–§5. |
| INV-429 | A channel's guest switch decides whether strangers knock | Keep | `off` still closes the channel to guests, guest turns included. The agent setting can only narrow. |

## 7. Questions this record leaves to Chris

1. **A guest's follow-up.** Should a guest turn see that guest's last few questions and answers
   in the same group chat, read from `guest-turns.jsonl` and never from a transcript?
2. **Knowledge per agent.** One public list per organisation today. Should an Admin be able to
   give each agent its own public list, for a support agent and a sales agent in one
   organisation?
3. **Answer review.** Should guest answers be sampled by the answer review (INV-1413) like member
   answers, and should an Admin see guest turns in the Audit tab?
