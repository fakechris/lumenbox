#!/usr/bin/env bash
# Container entrypoint: bring up the first desktop, then the daemon.
#
# Only display 1 is started here. The rest are created on demand by boxd as agents
# ask for them, so a box with one agent does not pay for four idle desktops.
set -euo pipefail

log() { printf '[box] %s\n' "$*"; }

if [[ -z "${BOXD_TOKEN:-}" ]]; then
  log "FATAL: BOXD_TOKEN is not set. The daemon exposes shell access and refuses"
  log "       to run without a token. Start the box via 'agentbox box up'."
  exit 1
fi

# Display 1 is the default: an agent with no assignment lands here, and it is what
# `box shot` and the smoke test look at.
log "starting the first desktop"
if ! /usr/local/bin/start-display 1; then
  log "FATAL: could not start display 1"
  exit 1
fi

log "starting boxd"
exec node /opt/boxd/boxd.cjs
