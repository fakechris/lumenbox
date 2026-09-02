#!/usr/bin/env bash
# scripts/attach-grok.sh — put a Lumenbox box daemon beside Grok Bot on its own VM, without
# touching anything of Grok's, and drive it from this machine over an SSH tunnel.
#
# What "beside" means, checked against the VM on 2026-09-02:
#   - Grok's host owns displays :1..:5 (one per bot), x11vnc 5900..5905, noVNC 6080/6081, its
#     daemons on 1337..1340, and Chrome debug ports 9222+N. Ours start at display :10, so every
#     derived port (5910, 6090, 5970, 6190, Chrome 9232) is clear of theirs by construction.
#   - The VM's own node is 20; /exec-daemon/node is 22, which boxd needs (global WebSocket).
#   - boxd binds loopback there; the only way in is this tunnel.
#   - The orchestrator here runs with its own state directory (~/.agentbox-grok), never the one
#     the main box's web server is using (docs/17: two hosts on one directory collide).
#
# Usage:
#   ./scripts/attach-grok.sh [SSH_HOST] [--port PORT] [--display N] [--token TOKEN] [--no-ui] [--dry-run]
set -euo pipefail

SSH_HOST="${1:-box@cursor}"
if [[ "$SSH_HOST" == --* ]]; then SSH_HOST="box@cursor"; fi

BOXD_PORT=13370
DISPLAY_NUM=10
AUTO_START_UI=true
DRY_RUN=false
UI_PORT=3000
LOCAL_HOME="${AGENTBOX_GROK_HOME:-$HOME/.agentbox-grok}"

if [[ $# -gt 0 && "$1" != --* ]]; then shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) BOXD_PORT="$2"; shift 2 ;;
    --display) DISPLAY_NUM="$2"; shift 2 ;;
    --token) AGENTBOX_TOKEN="$2"; shift 2 ;;
    --ui-port) UI_PORT="$2"; shift 2 ;;
    --no-ui) AUTO_START_UI=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: $0 [SSH_HOST] [--port PORT] [--display N] [--token TOKEN] [--ui-port PORT] [--no-ui] [--dry-run]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
VNC_PORT=$((6080 + DISPLAY_NUM))

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DROPIN_ARCHIVE="$ROOT_DIR/dist/lumen-dropin.tar.gz"

log() { printf '\033[1;34m[attach-grok]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[attach-grok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[attach-grok]\033[0m %s\n' "$*"; }

if (( DISPLAY_NUM < 10 )); then
  echo "ERROR: displays :1..:9 are Grok Bot's on this VM; use --display 10 or higher." >&2
  exit 1
fi

# The token is minted once and kept with the local state, never a default string in a script.
mkdir -p "$LOCAL_HOME"
if [ -z "${AGENTBOX_TOKEN:-}" ]; then
  if [ ! -s "$LOCAL_HOME/box-token" ]; then
    (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > "$LOCAL_HOME/box-token")
  fi
  AGENTBOX_TOKEN="$(cat "$LOCAL_HOME/box-token")"
fi
BOXD_TOKEN="$AGENTBOX_TOKEN"

log "Target host: $SSH_HOST"
log "Remote boxd port: $BOXD_PORT (display :$DISPLAY_NUM, noVNC :$VNC_PORT), local state: $LOCAL_HOME"
if [ "$DRY_RUN" = true ]; then log "Dry run; nothing executed."; exit 0; fi

log "1/5. Packaging the drop-in..."
(cd "$ROOT_DIR" && npm run pack:dropin)
[ -f "$DROPIN_ARCHIVE" ] || { echo "ERROR: $DROPIN_ARCHIVE missing after packaging." >&2; exit 1; }

log "2/5. Uploading to $SSH_HOST:~/.lumen ..."
ssh "$SSH_HOST" "mkdir -p ~/.lumen/bin ~/.lumen/run ~/work"
scp -q "$DROPIN_ARCHIVE" "$SSH_HOST:~/.lumen/"

log "3/5. Starting display :$DISPLAY_NUM, boxd and the keep-alive on the VM..."
ssh "$SSH_HOST" "bash -s" <<REMOTE_SCRIPT
set -euo pipefail
tar -xzf ~/.lumen/lumen-dropin.tar.gz -C ~/.lumen/bin/
chmod +x ~/.lumen/bin/*
export PATH="\$HOME/.lumen/bin:\$PATH"

# A node that boxd can run on: 22 or newer. The VM's own is 20; Grok's exec-daemon ships 22.
NODE_BIN=""
for candidate in node /exec-daemon/node; do
  if command -v "\$candidate" >/dev/null 2>&1; then
    major="\$("\$candidate" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
    if [ "\$major" -ge 22 ]; then NODE_BIN="\$candidate"; break; fi
  fi
done
if [ -z "\$NODE_BIN" ]; then echo "[remote] ERROR: no node >= 22 found (boxd needs a global WebSocket)"; exit 1; fi
echo "[remote] node: \$NODE_BIN (\$("\$NODE_BIN" -v))"

# The display is ours only if we started it. One that is up without our marker belongs to
# the host (Grok gives each bot a desktop), and driving it would be typing into their screen.
MARK=~/.lumen/run/display-$DISPLAY_NUM
if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
  if [ -f "\$MARK" ]; then
    echo "[remote] display :$DISPLAY_NUM is up (ours)."
  else
    echo "[remote] ERROR: display :$DISPLAY_NUM is already in use by something that is not ours. Pick another --display."; exit 1
  fi
else
  echo "[remote] starting display :$DISPLAY_NUM ..."
  start-display "$DISPLAY_NUM"
  date +%s > "\$MARK"
fi

if ! (exec 3<>"/dev/tcp/127.0.0.1/$BOXD_PORT") 2>/dev/null; then
  echo "[remote] starting boxd on 127.0.0.1:$BOXD_PORT ..."
  # DISPLAY is what boxd's "ensure the default desktop at boot" reads; left unset it would be :1,
  # and :1 is Grok's.
  DISPLAY=":$DISPLAY_NUM" BOXD_PORT="$BOXD_PORT" BOXD_BIND=127.0.0.1 BOXD_TOKEN="$BOXD_TOKEN" DEFAULT_DISPLAY="$DISPLAY_NUM" \\
    nohup "\$NODE_BIN" ~/.lumen/bin/boxd.cjs > /tmp/boxd-$BOXD_PORT.log 2>&1 &
  for _ in \$(seq 1 20); do
    (exec 3<>"/dev/tcp/127.0.0.1/$BOXD_PORT") 2>/dev/null && break
    sleep 0.5
  done
  (exec 3<>"/dev/tcp/127.0.0.1/$BOXD_PORT") 2>/dev/null || { echo "[remote] ERROR: boxd did not come up:"; tail -20 /tmp/boxd-$BOXD_PORT.log; exit 1; }
else
  echo "[remote] boxd already listening on $BOXD_PORT."
fi

if ! pgrep -f "box-keepalive $DISPLAY_NUM $BOXD_PORT" >/dev/null 2>&1; then
  echo "[remote] starting the keep-alive ..."
  nohup box-keepalive "$DISPLAY_NUM" "$BOXD_PORT" 45 > /tmp/keepalive-$BOXD_PORT.log 2>&1 &
fi
REMOTE_SCRIPT

log "4/5. Opening the tunnel (boxd $BOXD_PORT, noVNC $VNC_PORT) ..."
pkill -f "ssh -N -f.*-L $BOXD_PORT:127.0.0.1:$BOXD_PORT" 2>/dev/null || true
ssh -N -f \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=5 -o TCPKeepAlive=yes -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:$BOXD_PORT:127.0.0.1:$BOXD_PORT" \
  -L "127.0.0.1:$VNC_PORT:127.0.0.1:$VNC_PORT" \
  "$SSH_HOST"
sleep 1

log "5/5. Checking boxd through the tunnel ..."
HEALTH="$(curl -s -m 5 -H "Authorization: Bearer $BOXD_TOKEN" "http://127.0.0.1:$BOXD_PORT/health" || true)"
if [[ "$HEALTH" == *"ok"* || "$HEALTH" == *"status"* ]]; then
  success "boxd on the VM answers through the tunnel."
else
  warn "no healthy answer from http://127.0.0.1:$BOXD_PORT/health: ${HEALTH:-(empty)}"
fi

# The orchestrator's own state. The provider config is copied from the main installation once;
# the doors (channels.json), agents, transcripts and ledgers are not — they belong to that box.
if [ ! -f "$LOCAL_HOME/config.json" ] && [ -f "$HOME/.agentbox/config.json" ]; then
  python3 - "$HOME/.agentbox/config.json" "$LOCAL_HOME/config.json" <<'PY'
import json, sys
src = json.load(open(sys.argv[1]))
keep = {k: src[k] for k in ("provider", "model", "env", "rates", "activityLimit", "upgradeHour") if k in src}
json.dump(keep, open(sys.argv[2], "w"), indent=2)
PY
  log "copied provider settings into $LOCAL_HOME/config.json (not the channels, not the agents)"
fi

success "Attached. Grok's displays :1..:5 and ports 1337..1340 / 9222+ untouched."
success "  boxd:   http://127.0.0.1:$BOXD_PORT   (token in $LOCAL_HOME/box-token)"
success "  noVNC:  http://127.0.0.1:$VNC_PORT/vnc.html   (display :$DISPLAY_NUM)"

RUN_UI="AGENTBOX_HOME=\"$LOCAL_HOME\" AGENTBOX_BOXD_URL=\"http://127.0.0.1:$BOXD_PORT\" AGENTBOX_TOKEN=\"\$(cat $LOCAL_HOME/box-token)\" AGENTBOX_DISPLAY_FLOOR=$DISPLAY_NUM npm run agentbox -- web --port $UI_PORT"
if [ "$AUTO_START_UI" = true ]; then
  log "Starting the orchestrator UI on http://127.0.0.1:$UI_PORT with state in $LOCAL_HOME ..."
  cd "$ROOT_DIR"
  export AGENTBOX_HOME="$LOCAL_HOME" AGENTBOX_BOXD_URL="http://127.0.0.1:$BOXD_PORT" AGENTBOX_TOKEN="$BOXD_TOKEN" AGENTBOX_DISPLAY_FLOOR="$DISPLAY_NUM"
  exec npm run agentbox -- web --port "$UI_PORT"
else
  echo ""
  echo "To drive it from here:"
  echo "  cd $ROOT_DIR && $RUN_UI"
fi
