---
module: box display
tags: [xvfb, permissions, docker]
problem_type: runtime-error
found: 2026-08-18, docs/49
---
# Non-root Xvfb cannot create /tmp/.X11-unix, and a root-run box breaks later

**Symptom.** Xvfb fails to start as the box user with no useful message; or the box runs as root and the browser profile breaks later with a permissions error that looks like a browser bug.

**Cause.** Xvfb cannot create the socket directory itself when it is not root. A container that never switches `USER` runs the agent as root, so every file it creates is root-owned.

**Fix.** Create `/tmp/.X11-unix` with mode 1777 in the Dockerfile; switch to the box user before starting displays. Also: Xvfb reports a refresh rate of `0.00` in `xrandr`; a parser that requires `rate > 0` must fall back to 60.

**Verify.** `ls -ld /tmp/.X11-unix` shows `drwxrwxrwt`; `id -u` inside the box is not 0; the browser profile directory is owned by the box user.
