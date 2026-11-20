<!-- doc: 101-speaking-unprompted
     title: Speaking unprompted: what a member says to a person nobody asked it to say
     family: spec
     status: current
     domain: unprompted-speech
     updated: 2026-11-20
-->
# 101. Speaking unprompted: what a member says to a person nobody asked it to say

2026-11-20 (INV-1928). This document owns one question: when a member or the host says something
to a person that the person did not just ask for, **how many** of those go out, **whether** anybody
is there to read them, and **when** each one lands. Three pieces of work answered a third each
(INV-1576 and INV-535 the count, INV-741 the audience, INV-1853 the door a member has mid-turn) and
no page said how they fit. The moment — the subject of §4 — had no rule at all.

A reply to what a person asked is not this document's subject: it is the conversation
([docs/99](99-user-work.md) §3), and nothing here stands in its way.

## 1. What counts

A message is *unprompted* when no person is waiting on it:

- a routine's result reported into a chat, and a heartbeat's;
- a notice from the host about what it did or saw: a task's status line, a rescue, a follow-up
  on work that has gone stale, a daily digest, a routine paused because nobody writes any more;
- a `Tell` from a turn nobody is waiting on — a wake, a routine, a finished job.

It is *not* unprompted when a person is owed it or needs it: the reply to their message, the
acknowledgement of it, a question put to them, a request for their approval, a draft they approved,
a `Tell` on a turn they started and are waiting on (they are there, and asked), an operator's own
line typed into the console.

## 2. How many

Unchanged by this document, and owned by the code that counts: each member has a daily allowance
of unprompted messages (`push-budget.ts`), each room a daily allowance of the host's own
(`follow-up-budget.ts`). Past the allowance a message is held for the room's digest. What needs a
person is never held.

## 3. Whether anybody is there

Unchanged: when no person has written to a box for a week, its routines pause and say so once
(`routine-idle.ts`, INV-741).

## 4. When: the conversation is quiet first

An unprompted message does not land in the middle of an exchange.

1. **The check.** Before an unprompted message goes into a conversation, the host looks at that
   conversation. If a person wrote there within the window (3 minutes unless set), or a member is
   in the middle of a turn that answers a person there, the message waits in a queue. It goes when
   neither is true any more.
2. **Order.** Messages for one conversation leave in the order they were queued, word for word.
   A message that arrives while others wait goes after them, even if the conversation is quiet
   by then.
3. **What restarts the wait is a person writing, and nothing else.** A member's reply, a member's
   own unprompted message, a routine's prompt, a teammate's message and a host notice do not.
   "A person wrote" is read from the record the host keeps of who each message was from
   (`heard-record.ts`); nothing in this rule decides it again.
4. **The wait is capped.** After 30 minutes (unless set) a message goes whatever the conversation
   is doing. Waiting never becomes losing: the queue is a file, a restart keeps it, and a message
   leaves it only when the door that carries it has taken it. The doors' own receipts keep it from
   arriving twice.
5. **What cannot wait does not.** Everything §1 lists as not unprompted goes at once. So does an
   unprompted message marked urgent — by policy: what its sender flagged as needing a person (a
   goal's verdict awaiting acceptance), a question's text and its expiry, work that is stuck on the
   person; or by the person: the kinds of notice they listed in the config as never waiting.
6. **A member may take its message back, or reword it.** Something that waits can be overtaken:
   the member's reply to the person says it first, or a later fact makes it wrong. The member is
   told the name its `Tell` waits under and may withdraw it or put new words in its place, where
   it stood in the order. In a live conversation that is how an unprompted line becomes part of
   the answer instead of a second message after it.
7. **One rule, every door.** A chat (Feishu, DingTalk, Telegram) and the page follow the same
   rule from the same queue. The decision is one function (`quietVerdict`, `quiet-delivery.ts`);
   every push into a chat passes the queue at the one sender all of them leave by, and `Tell` asks
   it in its own admission (`admitTell`), because a `Tell` also goes to the page.

What this section leaves alone: a routine's reply inside its own conversation on the page is that
conversation's record, not a message into somebody else's exchange, and is written as it always was.

## 5. What a person's feedback changes

When a person says an unprompted message came at a bad time, what a member learns is about
**time**: that kind of thing goes later, or at another hour. It does not learn silence. A member
stops sending a kind of message only when the person says outright not to be told about that kind.
The member's prompt says so in the paragraph about `Tell`.

Deriving such rules from reactions without being told is not built, and is not decided here.

## 6. Settings

| Setting (`config.json`) | Default | Meaning |
| --- | --- | --- |
| `quiet.minutes` | 3 | How long a conversation has been without a person's message before it is quiet. `0` turns the waiting off. |
| `quiet.capMinutes` | 30 | The longest a message waits. |
| `quiet.urgent` | none | Kinds of notice that never wait, by the leading words of what the notice is about as the log prints it (`"rescued"`, `"report from"`). |

## 7. What this document refuses

- A second place that decides when an unprompted message goes. A new door asks the queue.
- A second test of "is this a person". The heard record answers.
- Dropping a message because the conversation stayed busy.
- Reading "not now" as "never".
