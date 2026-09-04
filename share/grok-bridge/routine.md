---
name: lumenbox-bridge-keepalive
slug: lumenbox-bridge-keepalive
description: Every hour, make sure the LumenBox daemon on this box is running; say something only when it had to be restarted or could not be.
---
Run `~/.lumen/bin/lumen-bridge.sh status`. If it reports the daemon up, do nothing and say
nothing. Otherwise run `~/.lumen/bin/lumen-bridge.sh start`; if that prints a `BOXD_URL` line,
tell the person in one line that the LumenBox bridge was restarted after the box came back; if
it fails, send them the last lines of its output.

Fires on: every hour.
