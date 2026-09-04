---
name: lumenbox-bridge
description: >-
  Prepare this box so the person's LumenBox can drive it too: check what is here, join their
  Tailscale network with SSH on, install the LumenBox box daemon on a desktop of our own, and
  tell them exactly how to connect from their laptop. Run it when they ask to "connect
  LumenBox", "接入 LumenBox", or on a new bot's first turn.
---
# Bridge this box to LumenBox

The person wants LumenBox — their own agent team, on their laptop — to work inside this box
beside you. Nothing of yours changes: your desktops (:1 to :9), your daemons and your files stay
as they are; LumenBox gets a desktop of its own at :10 and its own small daemon, reached only
over the person's private Tailscale network. Everything you run is one script, `lumen-bridge.sh`,
and every step of it can be run again safely.

**Start on your own.** If you were just created from the LumenBox Bridge template and have
finished setting yourself up (skill installed, routine saved, memories written), do not stop
to ask what to do next and do not ask whether to enable the routine: say one line — "Setting
myself up is done; now preparing this box for LumenBox" — and go straight to step 1 in the same
turn. The person chose this template for exactly this; waiting for them to ask is the one thing
they did not want.

Work through the steps in order, one short SendMessage per step so they can follow, and stop
where the script tells you the person has something to do. Never paste the token into the chat
unless they ask for it by name — the connect hint shows them how to read it over SSH instead.

## 1. Look before touching anything

Get the installer and run its check:

```
mkdir -p ~/.lumen/bin && curl -fsSL https://github.com/fakechris/lumenbox/releases/latest/download/lumen-bridge.sh -o ~/.lumen/bin/lumen-bridge.sh && chmod +x ~/.lumen/bin/lumen-bridge.sh
~/.lumen/bin/lumen-bridge.sh check
```

Tell them in two or three lines what it found: whether Tailscale is already here, whether the
daemon is already installed, and whether anything is in the way (a display :10 that is not ours,
no node 22, no sudo). If the daemon is already up and joined, skip to step 4 — they are only
missing the connection instructions.

## 2. Join their Tailscale network

Ask with a question widget before this one: "Join this box to your Tailscale network (with
Tailscale SSH on)?" — Yes / Not now. It installs software with sudo and changes how the box is
reachable, so it is theirs to say. A question widget ends your turn; run the command on the next.

```
~/.lumen/bin/lumen-bridge.sh tailscale
```

It prints a line `LOGIN_URL https://login.tailscale.com/…` and then waits. Send them that URL
with one line of explanation: open it, sign in with their Tailscale account (a free personal
account is enough; if they have none, the same page creates one), and approve the box. On their
laptop they need the Tailscale app signed in to the same account — say so once. The script waits
up to ten minutes; when it prints `TAILSCALE_IP …` tell them the box is on their network as
`lumenbox-…`. If it times out, say so and offer to run the step again when they are ready.

## 3. Install the LumenBox daemon

```
~/.lumen/bin/lumen-bridge.sh install
```

It downloads the daemon, mints a token (kept in `~/.lumen/token`, never printed), starts a
desktop of our own at :10 and the daemon on the box's Tailscale address, and a keep-alive. It
ends with `BOXD_URL http://…:13370`. Report that address. If it fails, show the last lines of
its output and stop — do not improvise around an install error; the person can bring it to the
LumenBox project with that output.

## 4. Tell them how to connect

```
~/.lumen/bin/lumen-bridge.sh connect-hint
```

Send the hint as it is: how to read the token over Tailscale SSH from their laptop, and the two
ways to attach (the LumenBox Settings → Boxes form, or the one-line command). Then say what they
will see: a box named `grok` in LumenBox, where they create an agent whose desktop is :10 here.
Finish with one sentence: their LumenBox agents and you share the files under `~/work`, and
nothing else of yours is touched.

## 5. Turn the keep-alive on, and what happens after a reboot

This box has no service manager, so after a restart the daemon is down until something starts
it. The routine `lumenbox-bridge-keepalive` that came with this template does that every hour —
but a routine imported from a template arrives **paused**. Enable it now, without asking (the
person asked for the bridge; a bridge that dies at the first reboot is not one), and say in one
line that you did. If the person later says LumenBox lost the box, run
`~/.lumen/bin/lumen-bridge.sh start` yourself and report the `BOXD_URL` line.

## What to say when asked

- "Where is the token?" — `~/.lumen/bin/lumen-bridge.sh token` prints it; say it protects only
  this daemon, which only their own Tailscale devices can reach, and that reading it over SSH
  keeps it out of this chat.
- "Is it safe?" — LumenBox reaches this box only through their private Tailscale network, on a
  desktop and a port of its own; the host's own desktops and daemons are untouched; removing
  it is `pkill -f lumen/bin/boxd.cjs` and deleting `~/.lumen`.
