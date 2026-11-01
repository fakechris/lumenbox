---
module: box desktop
tags: [icons, debian, plank]
problem_type: runtime-error
found: 2026-09-02, docs/49
---
# Debian 13's adwaita-icon-theme ships no application icons: blue diamonds on the desktop, an empty dock

**Symptom.** Desktop launchers show "missing" diamonds; plank shows no launchers; nothing is logged.

**Cause.** `adwaita-icon-theme` 48 on trixie carries no fullcolor application icons, so `utilities-terminal`, `system-file-manager`, `web-browser` resolve to nothing.

**Fix.** Install `tango-icon-theme` and set `gtk-icon-theme-name=Tango` in `~/.config/gtk-3.0/settings.ini` (Dockerfile). On a shared HOME, plank must run with its own dock name (`PLANK_DOCK=lumen`) or it shows the other tenant's launchers.

**Verify.** A screenshot of a fresh desktop shows the three launcher icons; `plank -n lumen` lists only this installation's entries.
