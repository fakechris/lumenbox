# Box boot recovery (survives Update Computer)

Home is synced; apt packages are not. On every boot/rebuild:

1. `~/.config/autostart/*.desktop` runs `ensure-sshd` + `ensure-lumen-bridge-deps`
2. Hourly routine `lumenbox-bridge-keepalive` re-checks the same chain

Scripts (all under `~/.lumen/bin/`):
- `ensure-sshd` — install/start OpenSSH on :22
- `ensure-tailscale` — install/start Tailscale; hostname default `cursor`
  - Persists node identity in `~/.lumen/tailscale-state/` (backup after join, restore before re-login) so hostname and 100.x IP stay stable across Update Computer
  - Fully automatic join: put a reusable auth key in `~/.lumen/tailscale-authkey`
  - Otherwise writes login URL to `~/.lumen/run/tailscale-login.url`
- `ensure-lumen-bridge-deps` — sshd → Tailscale → `lumen-bridge.sh start`
- `lumen-bridge.sh` — box daemon on :10 / port 13370

Stable access: prefer `ssh box@cursor` (MagicDNS). If admin still has offline `cursor` / `cursor-N` stubs, delete them so the restored node can keep the name `cursor`. With state restore, the IP should not change across rebuilds.
