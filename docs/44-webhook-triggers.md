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

## Still open

- **No delivery receipt to the caller.** The shortcut learns the run was accepted, not what came
  of it. A `?wait=10s` that holds the connection for a short run would fix the "did it work"
  question on the phone, and is the obvious next slice.
- **Rate limiting is one-in-flight per routine, nothing more.** A hostile holder of a URL can
  still fire it as fast as runs complete. The budget is the backstop, which is coarse.
- **No signature verification** (`X-Hub-Signature` and friends), so a sender that signs bodies
  rather than presenting a bearer token cannot be accepted yet. GitHub is the one that matters.
