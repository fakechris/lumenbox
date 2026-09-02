# Debugging the box

When your computer acts up — a shell call fails, a screenshot is black or stale, the
browser will not start, the desktop will not render — diagnose it yourself before giving
up, and keep the person posted with a plain status instead of going silent. Everything
below is a real path or command in this box; nothing else exists, so do not invent one.

## Is it up?

- If `bash` returns output, the box is running and its daemon (boxd, port 1337) is healthy.
- If `bash` and `computer` are not offered to you at all, the box is down. The person starts
  it from the web app ("Start the box") or with `agentbox box up`; you cannot.

## Run the self-check first

`box-doctor` is on your PATH. It prints one `[box-doctor] PASS|WARN|FAIL <check>: <detail>`
line per check and a summary, and exits non-zero when anything failed. It checks: display,
window-manager, compositor, input, fonts, file-chooser, chrome, chrome-policy, clipboard,
screenshot, vnc, vnc-ro, novnc, boxd, orchestrator, disk, launchers, work-location.
`box-doctor 2` checks display :2 (a forked desktop). When a page or a click misbehaves for
no clear reason, run it and report the failing check rather than guessing.

## Where the logs are

Every desktop piece logs under `/tmp`, one file per display number `N`:

| What | Log |
|---|---|
| X server | `/tmp/xvfb-N.log` |
| Window manager | `/tmp/xfwm4-N.log` |
| Compositor | `/tmp/picom-N.log` |
| Screen sharing | `/tmp/x11vnc-N.log`, `/tmp/x11vnc-ro-N.log` |
| Browser view of the desktop | `/tmp/novnc-N.log`, `/tmp/novnc-ro-N.log` |
| Dock and desktop | `/tmp/plank-N.log`, `/tmp/pcmanfm-N.log` |
| Clipboard sync | `/tmp/autocutsel-N.log` |
| Process crashes seen by PID 1 | `/tmp/agentbox-crashes.jsonl` |

The primary desktop is display `:1`; `xdpyinfo -display :1` confirms the X server is up.
Read logs with `tail`; do not delete or truncate them.

## Common failures

- **Screenshot black or unchanged.** Check `box-doctor` `display` and `screenshot`. A stale
  X lock after a restart is a known cause; the desktop restarts itself on the next boot.
- **Typing goes nowhere, dialogs never take focus.** No window manager: `box-doctor
  window-manager`. Report it; do not try to start one by hand.
- **Chromium will not start.** Launch it with `box-chrome` (never a raw `chromium` binary:
  the launcher carries the profile, the policy and the debugging port). Then read the
  process list and `/tmp/*.log`. Do not drive GUI apps from the shell with `xdotool`.
- **A page shows a block or consent wall.** That is the site, not the box: use the browser
  tools instead of `WebFetch`, as the prompt says.
- **Disk.** `df -h /home/box/work` — your work directory is the persistent part of this
  box. Installed packages (apt, npm, pip) do not survive an image upgrade; files under
  `/home/box/work` do.

## What you cannot do

You cannot rebuild or recreate the box. If it is wedged, say so plainly with the failing
check, and tell the person the recovery is `agentbox box up --recreate` on their side
(files under `/home/box/work` survive; installed software must be reinstalled).
