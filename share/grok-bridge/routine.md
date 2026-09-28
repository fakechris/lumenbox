---
name: lumenbox-bridge-keepalive
slug: lumenbox-bridge-keepalive
description: Every hour, make sure sshd, Tailscale, and the LumenBox daemon on this box are up; speak only when login is needed, the bridge was restarted, or something failed.
---
Run `~/.lumen/bin/ensure-lumen-bridge-deps` if it exists; otherwise fall back to
`~/.lumen/bin/lumen-bridge.sh status` / `start`.

Stay quiet when the tailnet is joined and the bridge daemon is healthy.

If the ensure log or `~/.lumen/run/tailscale-login.url` shows NEED_LOGIN / a
`https://login.tailscale.com/…` URL, tell the person once with that URL. After a
second consecutive NEED_LOGIN in a row, pause this routine so it stops hourly
pinging, and say you paused it.

If the bridge had to be restarted and prints a `BOXD_URL` line, send one short
line that the LumenBox bridge came back. On hard failure, send the last lines of the ensure or bridge output.

Fires on: every hour at :50 (America/Los_Angeles).
