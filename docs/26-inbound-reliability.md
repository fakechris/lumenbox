<!-- doc: 26-inbound-reliability
     title: Inbound reliability: what a message goes through, and what mature harnesses do
     family: decision
     status: current
     updated: 2026-11-01
-->
# Inbound reliability: what a message goes through, and what mature harnesses do

Status: **written 2026-09-01, after a question sat unanswered in a group for an
hour.** The owner's criticism was the right one: chat-bot networking is a solved
problem with standard shapes, and we had been deriving ours from our own
incidents instead of reading the implementations that already survived them.
This document is the comparison, the gaps it found, and what changed.

## The incident that started it

Three restarts inside an hour (shipping fixes). The SDK logged `socket ready`
on the third. Feishu kept dispatching to a registration that no longer existed.
A question typed at 11:06 was in Feishu's own message list and never reached the
process; the ingress ledger recorded, accurately, that nothing had arrived — and
**nothing-arrived is also what a quiet afternoon looks like**. `liveness.ts` had
predicted this exact shape and set its alarm at two hours, which is right for a
report and far too long for a conversation.

## The reference: OpenClaw (`~/source/claw/openclaw`, read directly)

Two mechanisms there are worth more than the incident that taught us to look.

**A persisted watermark that never passes a pending item**
(`src/telegram/update-offset-store.ts`, `src/telegram/bot.ts:150-190`).
OpenClaw stores Telegram's `lastUpdateId` on disk per account, and — the part
that matters — only advances it *below the smallest update still in flight*:

> We only persist a watermark that is strictly less than the smallest pending
> update_id, so we never write an offset that would skip an update still waiting
> to run.

Our first version of catch-up used "the last thing that arrived" as its floor.
An arrival is recorded the moment the wire hands it over, so a crash between
that record and the durable queue moved the floor *past* a message nobody ever
answered. Fixed by reading the same rule out of our own ledger: the floor is the
oldest arrival with **no fate**, and "already handled" means *settled*, not
merely *seen* (`src/web/server.ts`, `lastInboundFor` / `handledAlready`).

**Catching up on a backlog is not the same as acting on it**
(`src/web/inbound/monitor.ts:235`). OpenClaw's WhatsApp monitor distinguishes
live delivery from history sync and, for history, marks read but **skips
auto-reply**. Our sweep answered everything it recovered — a door down for a day
would have woken up and fired a turn per accumulated message. Now bounded: two
hours (the same span liveness calls "worth doubting"), five per sweep, and
whatever is skipped is counted and named in the log rather than dropped quietly.

**Where we were already equal or ahead**: per-conversation serialisation
(OpenClaw sequentializes by chat/topic; we serialise per agent, which is
stricter when one agent serves several rooms), a single-consumer lock per app id
(`acquireConsumerLock`), durable admission (`inbox.jsonl` replayed on start),
turn resumption (`turns.jsonl`), and owed-delivery recovery (`deliveries.ts` —
the answer is reconstructed from the transcript, so a reply survives the death
of the process that earned it). OpenClaw has no equivalent of that last one that
we found.

## The gap list, and what happened to each

| Gap | Status |
| --- | --- |
| A half-open socket is never detected: `ready` is the SDK's claim, and nothing checks it against the vendor | **Fixed** — catch-up sweep on every connect (f33d13e) |
| A socket that dies without reconnecting is never repaired: the sweep only ran on reconnect | **Fixed** — the sweep also runs on the ten-minute liveness timer, repair before report (4d39cf6) |
| Dedup was memory-only, and memory is empty in exactly the process a redelivery lands in; DingTalk's own comment called a restart re-answering a message "the accepted cost" | **Fixed** — the durable ingress record is consulted before the arrival is written, both adapters (4d39cf6) |
| The sweep's floor could skip a message we crashed underneath | **Fixed** — watermark below the oldest undecided arrival (this commit) |
| An outage's whole backlog would be answered at once | **Fixed** — bounded by age and count, skips stated aloud (this commit) |
| DingTalk has no catch-up sweep — its stream redelivers on reconnect, so the hole is smaller, but it is not closed | **Open**, next |
| Webhook mode is not supported at all. Vendors document retry schedules for HTTP callbacks and no redelivery for websocket clients, which makes webhook the more reliable production shape — at the cost of a public URL | **Open decision**, needs AGENTBOX_PUBLIC_URL and a security pass |
| Liveness is report-only at a two-hour threshold | **Partly addressed** — the sweep now repairs on the same timer; the threshold still governs only the *report* |

## The rule this leaves behind

An inbound path is not "connected"; it is **provably current or not**. Every
door should be able to answer, from durable state, "what is the last thing I
finished with, and what does the vendor say has happened since?" — and answer it
on a timer, not only when something reconnects. Everything else here (dedup
keys, bounded replay, watermarks) follows from taking that question seriously.

Not yet done and worth doing before this is called finished: the same sweep for
DingTalk, and a decision on webhook mode.

## 2026-09-02: two misses after one restart, nine faults under them

A question inside a topic (03:51 UTC) and a top-level post (04:02) both went unanswered
after a web restart. Traced with the ledger and the vendor's own message listing:

| # | Fault | Fix (commits a2c82a8, 59828e5, 7a6c882) |
|---|---|---|
| 1 | Socket after restart reported neither ready nor failed; retry listened only for "failed" | 45 s ready watchdog: close, reopen with backoff, log |
| 2 | Sweep listed the chat container; a topic's replies live in the thread container | Sweep the threads the listing reveals and the ledger heard from (2 h) |
| 3 | Ready classifier matched the HTTP client's "client ready" | Match "ws client ready" only |
| 4 | Vendor `create_time` is ms; age cap multiplied by 1000 and never applied | ms throughout |
| 5 | Clocks two minutes apart | Floor slack 5 min |
| 6 | A p2p arrival from 2026-08-28 with no fate pinned every floor to that day | Floor ignores undecided arrivals older than the window, never older than it |
| 7 | Ascending, one page of 20: with a stale floor, the same 20 handled messages every sweep | Newest-first, paginate to the floor, 50 per page |
| 8 | An arrival that died between arrival and admission sat in the in-memory seen set; sweep skipped it as "seen" | Sweep dedupes on the durable ledger only and re-offers undecided arrivals |
| 9 | Sender-name lookup unbounded, the one await before admission | 5 s timeout, message goes on without the name |
| + | Replayed arrivals stamped at replay time moved the floor past what the cap left | `sentAt` from the wire and from replay; replay in global send order; cap 20 |
| + | Bind codes returned before a fate | Settled as admitted |

The rule that emerges: **arrived without a fate is the signal**, the seen set is not
evidence of anything, and the floor is a send-time watermark below the oldest live
undecided arrival. Every restart still costs a reconnect; the loss is now bounded by
the watchdog (45 s) plus one sweep (≤10 min), and a message in either container inside
two hours is answered.

## 2026-10-15: a correction that arrives while the turn is still working (INV-1189)

Raft's server refuses an agent's send when the conversation has messages the agent has not
read, and hands the draft back. We had no such check, and the claim that steering covered it
did not survive review: channel requests are never steerable (`steerable: false`, by the
INV-611/630 rule that every channel message gets its own tracked turn), steering only runs at
a round boundary, and it is skipped while a turn is finishing.

Measured, not argued — `scenario.test.ts`, "INV-1189: a correction sent …", three moments,
one scripted conversation ("按方案 A 做", then "改成 B"):

| The correction arrives | What the person receives | Did the first turn ever see it? |
|---|---|---|
| while the final answer is being generated | A, then B from its own turn | no |
| between a tool result and the next model call | A, then B from its own turn | no |
| after the answer exists, before it is delivered | A, then B from its own turn | no |

So the gap is real: an answer the person has already overruled is delivered before the
answer to the overruling. What does **not** follow is the obvious fix, folding the new
message into the running turn before it delivers. That is the Nova incident's shape
([handoff-2026-09-22-nova-incident](handoff-2026-09-22-nova-incident.md)): an unrelated
request swallowed into an old task. Any unconditional fold at delivery time reproduces it
whenever an unrelated request happens to land near the end of a turn. The fix has to leave
the new message's own turn alone and only let the first turn know it is about to answer
something the person may already have moved past; that variant is proposed as an amendment
to INV-1189 rather than built against the original wording.

**Step two, built (INV-1189 amendment accepted 2026-10-15).** Before a person-opened turn
delivers its final reply, it checks the queue for channel messages (`steerable: false`) from the
same person in this conversation that arrived at or after its last model request went out (`bus.newerFromPerson`,
which reads and never takes). If there are any, the turn takes one more look: the messages are
shown as a host note ("it will be answered in its own turn — revise or annotate only if this
reply is now wrong"), `tool_choice` is `none`, and any tool call the model makes anyway is
dropped, never run. That is enforced in the loop, because `none` is a request a model can ignore.
The new message is not consumed: it still gets its own tracked turn, so the INV-611/630 rule
holds. The look happens at most once per turn. Steerable messages (the web chat) are not looked
at: steering takes those at round boundaries, and while a turn is finishing R8 leaves them for
the next turn on purpose. One window stays open, and the scenario pins it:
a correction that lands after the answer exists, while it is being sent, cannot be seen by it.


## 2026-11-01: the outbound side — a host push names its purpose (INV-1459)

Everything above is about a message that arrives. The message that leaves had one rule — a
person's own turn answers them — and no rule for the rest: a routine's report, a late answer,
a board card, a digest, a rescue notice, a console relay. Those are the host or an agent
deciding to speak, and the only checks were after the fact (answer review, default shadow) and
by volume (the follow-up budget). Neither asks what the message is *for*, so a result for
unfinished work, an answer nobody is owed, and a question that is not the one on file all
went out.

Now every host-initiated push (`pushToChat`, `tryPushToChat`, `pushQuestionToChat`) carries a
purpose, and `src/host/outbound.ts` reads the world for it before the adapter is touched:

| Purpose | Allowed when |
| --- | --- |
| `result` | the task it reports is in review, done or dropped |
| `attention` | the question it carries is the one pending under that ref — a watched question or a blocked task's card — word for word |
| `answer` | a reply is still owed under that delivery id (`deliveries.jsonl`), which the send then closes |
| `ack` | the message has not been acknowledged before |
| `notice` | always; the host reporting what it did or saw. Counted, not gated |

A refusal is returned to the caller with its reason — `{delivered: false, why}` — and written
to `policy.jsonl` as `reply-refused`, so a prompt that keeps trying to announce an unfinished
draft leaves a trail a person can read. The person-opened turn's own reply is not under this
gate: that is the conversation itself. Answer review stays as the sample after the fact.

What is labelled today: routine and goal reports, the context steward, the follow-up sweep,
digests, question expiries, rescue notices and console relays are `notice`; a late answer
recovered from the ledger is `answer`; a blocked task's card is `attention`. Nothing in the
host sends a `result` yet — the gate is there for the agent-initiated delivery that INV-1462
brings — so today its teeth show on `attention` and `answer`.

### The receipt under each push (INV-1460, same day)

The gate above decides whether a message may go; `src/host/outbox.ts` records whether it did.
Every host push gets a receipt in `~/.agentbox/outbox.jsonl` under an id derived from the chat,
the purpose and the words (a notice adds the day), written before the door is called:

- **The same message is never sent twice.** A second push with the same id is answered
  `{delivered: true, duplicate: true}` and sends nothing — which is what makes a retry safe,
  and why the Feishu door's own "never blindly retry" stays true: it does not, the outbox does.
- **A blink is retried; a verdict is not.** A failed send is counted on the receipt and tried
  again after 5 s, then 10 s, up to three attempts (`src/channels/outbox-sender.ts`). A door's
  answer that the conversation cannot take the message — not found, removed, no permission — is
  `dropped` with its reason, and that id is never queued again. After three failures the receipt
  stays `pending` and appears under *what needs me* as **undeliverable**, with the last error.
- **In order per chat.** Each chat has one chain; a message waits for the one before it,
  retries included, so an acknowledgement never arrives after the result it precedes.
- **A restart finishes the queue.** Pending receipts keep their text, and the server sends them
  again through the door they were for before anything else — the ones past their attempts are
  left for a person.

The deliveries ledger (`deliveries.jsonl`) is unchanged and sits one level up: it knows an
*answer* is owed for a request and rebuilds it from the transcript; the outbox knows whether
the *message* carrying it went. The `answer` purpose reads the first; the receipt records the
second.
