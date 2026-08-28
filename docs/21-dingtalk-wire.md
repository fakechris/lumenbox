# The DingTalk wire

Stream mode in, three roads out — text, cards, files — and what each costs.
The code lives in `src/channels/dingtalk.ts`; this is the operator-facing half:
what to configure, what to build once in the console, and what the wire still
cannot say.

## Configuration

| Variable | Required | What it turns on |
| --- | --- | --- |
| `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` | yes | the app credentials everything else rides on |
| `DINGTALK_CARD_TEMPLATE_ID` | no | consent requests as an interactive card with three buttons; without it approvals run on the text verbs |
| `DINGTALK_TASK_CARD_TEMPLATE_ID` | no | long tasks as a progress card rewritten in place; without it they get the plain ack line |

Both templates are built once in the DingTalk card console against the same app
(the approval card in this deployment came from the 审批模板 preset). Template
ids look like `73370521-….schema`.

## The task card template's variable contract

A task template binds variables from `taskVarsFor`; all values arrive as strings:

| Variable | Meaning |
| --- | --- |
| `title` | the instruction, first line |
| `agentName` | who is doing it (empty for the default agent) |
| `requesterLabel` | who asked |
| `status` | `queued` \| `working` \| `done` \| `failed` |
| `action` | the current one-line action; blank before start and when finished |
| `ahead` | how many requests are queued ahead; blank otherwise |
| `taskId` / `taskUrl` | board id and workshop link, when the task has one |

A variable the state does not carry is sent **empty, not omitted**, so a template
that binds it re-renders a blank instead of keeping a stale line alive.

Updates ride `PUT /v1.0/card/instances` with the instance's `outTrackId`; the
manager rate-limits them. Group cards land in `dtv1.card//IM_GROUP.<conversationId>`.
A direct session's robot space names a person, not a room — there is no
`IM_GROUP` analogue — so its card addresses who asked, taken from the identity the
manager hands over (the sender of the message that started the task), else the
last sender on record. When neither exists the manager falls back to the text ack
line; in practice that line is nearly unreachable, because a card is always a
reaction to a message that just refreshed the record — the fallback is defensive,
not a path a person normally sees.

## Outbound media, without a public URL

Files and images go up through the legacy `media/upload` endpoint for a
`mediaId`, then out as robot messages: `sampleFile`
(`{mediaId, fileName, fileType}`) and `sampleImageMsg` (`{photoURL}` — the image
key reads the id out of `photoURL`, verified against production usage elsewhere).
Caps follow the endpoint's own buckets: 10 MB images, 20 MB files; past one the
send refuses loudly and the file stays in the chat's outbox. Media has no webhook
road — a session webhook carries neither files nor uploaded keys — so these always
ride the robot REST APIs, which need only the access token the adapter already has.

## Deliver-once guarantees, and the seam left open

The business `msgId` dedupe catches redeliveries across reconnects. It cannot
catch a sender's client retrying a send, because the retry mints a fresh msgId —
observed as one paste arriving as two admitted frames 0.9 seconds apart, the
prompt written into the transcript twice. A second net keys on the words: same
room, same collapsed whitespace, inside ten seconds → the later copy is dropped
and logged. The price is deliberate: a person who genuinely repeats a line inside
the window loses the repeat.
