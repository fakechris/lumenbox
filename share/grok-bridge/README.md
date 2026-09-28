# LumenBox Bridge — a Grok Bot template

What a Grok Bot needs to prepare its own box for LumenBox (docs/35): `SKILL.md` (the skill, in
Grok's dialect), `routine.md` (the hourly keep-alive), `recipe.json` (the whole template in
Grok's recipe shape). The installer they call is `lumen-bridge.sh`, published with every
drop-in release at `https://github.com/fakechris/lumenbox/releases/latest/download/lumen-bridge.sh`.
Publishing steps are in docs/35.

## Box boot recovery (`box/`)

Grok Bot's Update Computer keeps `~/.lumen` but wipes apt packages and `/var/lib/tailscale`.
Without recovery scripts, each rebuild forces a fresh Tailscale login and creates a new node
(`cursor-1`, `cursor-2`, …) with a new `100.x` IP.

Scripts under `share/grok-bridge/box/`:

| File | Role |
|------|------|
| `ensure-sshd` | Install/start OpenSSH on :22 |
| `ensure-tailscale` | Install/start Tailscale; hostname default `cursor`. Backs up `/var/lib/tailscale` into `~/.lumen/tailscale-state/` after join and restores it before re-login so hostname + IP stay stable. Optional auth key: `~/.lumen/tailscale-authkey`. |
| `ensure-lumen-bridge-deps` | sshd → Tailscale → `lumen-bridge.sh start` |
| `BOOT-RECOVERY.md` | Short operator notes for the box |

After `lumen-bridge.sh install`, copy these into `~/.lumen/bin/` (and `BOOT-RECOVERY.md` into `~/.lumen/`). The hourly keepalive should run `ensure-lumen-bridge-deps`.

If MagicDNS still becomes `cursor-N`, delete offline `cursor` / `cursor-N` stubs in the Tailscale admin so the restored node can keep the name `cursor`.

Published: https://x.ai/bot/U8xEPyVxQHL_JznVhVotB (2026-09-04).
