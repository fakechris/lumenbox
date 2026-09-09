# 44 · Webhook triggers

*2026-09-09. A URL per routine, so anything that can make an HTTP request can set an agent
working. Companion to the skills/routines mechanism (a routine is a skill file).*

## What was missing

Three ways to start work existed: a person typing, a timer (`schedule:`), and a chat message
(`trigger: message`). There was a fourth door in the MCP face — `assign_task` — but it speaks
JSON-RPC, which a phone cannot.

The shape that was missing is the one every automation tool on earth already speaks: **POST a
body to a URL with a header**. An iOS Shortcut on a share sheet, a Zapier step, a GitHub Action,
a button on a page, a cron on another machine. Without it, "I saw something on my phone and want
it filed" cannot be built, however capable the agent behind it is.

## The mechanism

A routine declares it:

```
---
name: File it
description: reads whatever arrives and writes it into the knowledge base
trigger: webhook
agent: Ada
deliver: feishu:oc_...      # optional, for a chat that should hear the result
---
1. Read what arrived. It is a link, or a note, or a share sheet payload.
2. ...
```

The host mints a URL and a secret the first time it sees the routine, and shows them in
Settings → Automations, with a Copy button that gives you a working `curl`. The URL never
changes; the secret can be rotated without changing it, so a leak does not mean rebuilding the
shortcut on your phone.

```
POST https://your-host/hooks/<id>
Authorization: Bearer lmbxhook_...
<any body>
```

The body arrives in the routine's turn verbatim, fenced, and labelled as data — whoever holds
the URL can put any words in it, and the prompt says so plainly rather than hoping.

## The decisions

**Per routine, not per installation.** A secret that goes into a phone will end up in a
screenshot. The blast radius has to be one routine.

**The secret is not in the skill file.** Skill files live in the box: readable by every agent,
copied into templates, shared with whoever the box is shared with. It lives in
`~/.agentbox/webhooks.json`, mode 600, which is the only place it exists.

**202, immediately.** The caller is a phone on a train or a CI step with a two-second timeout.
The work is started and the response says "accepted" — which is the truth. What happened is in
the app, where the person is.

**Refusals are uniform.** A wrong secret and an id that does not exist answer identically, so
the endpoint cannot be used to find out what runs on this machine. Only the ledger knows which
it was.

**A second press is refused, not queued.** A shortcut pressed twice on a train is the same
content twice. The reason comes back as a 409 rather than a 500, so the sender is told.

**64 KB.** Beyond that it is a file transfer, which is not what a trigger is for. Send a link.

**GET does nothing.** A link preview, a crawler, or a browser opening the URL out of curiosity
must not start work.

**Same rails as everything else.** The turn runs through the ordinary path: the routine's agent,
the policy gate, the budget, the pause switch, the automations list, the same records. A webhook
routine that is paused does not fire, and a box over budget stops rather than draining.

## Reaching it from a phone

The URL points at whatever this installation is reachable at. On a laptop that is
`127.0.0.1:7777`, which a phone on mobile data cannot reach. Set `AGENTBOX_PUBLIC_URL` to an
address that resolves from outside — a tunnel, or a host on your network — and the page shows
that instead. Until then, the automations page says plainly that the URLs are local.

## Waiting for the answer

`?wait=<seconds>` (up to 55) holds the connection until the routine finishes and returns what it
said:

```
POST /hooks/<id>?wait=30
→ 200 {"done":true,"said":"Filed at /home/box/work/inbox/2026-09-09-webhook.md"}
```

A shortcut can then show the result instead of trusting that something happened. If the routine
outlives the wait the answer is `202 {"done":false}` — the work is not cancelled, and the run is
in the app. Without the parameter nothing changes: `202` immediately, which is right for a phone
on a train.

## Signed bodies

GitHub, Stripe and everything shaped like them do not send the secret; they sign the body with it.
Both are accepted: `Authorization: Bearer <secret>`, or an HMAC-SHA256 of the raw body in
`X-Hub-Signature-256` (also `X-Signature-256`, `X-Lumenbox-Signature`), with or without the
`sha256=` prefix. The routine's own secret is the shared secret, so a GitHub webhook needs no
proxy in between. The body is compared as received — re-serialising JSON breaks every signature,
which is why the handler keeps the raw text and authenticates after reading it.

## How often

Thirty calls per ten minutes per routine, on top of one run in flight. Over that is `429` with a
`Retry-After`. The counter is in memory, so a restart forgives — the right side to err on for
something whose real backstop is the budget. What this stops is the pathological case: a
misconfigured shortcut, a retrying CI job, or somebody with the URL firing it until the month's
spend is gone.

## Still open

- **No replay window.** A signed body proves who sent it, not when. A sender that replays a
  captured request is accepted until the rate limit bites. Stripe-style timestamp checking is the
  fix, and needs the sender to provide one.
- **One secret per routine, no second one during rotation.** Rotating breaks anything still using
  the old secret at that instant; two live secrets with an overlap window would make rotation
  free.
