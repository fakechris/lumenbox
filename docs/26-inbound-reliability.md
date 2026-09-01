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
