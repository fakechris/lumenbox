#!/usr/bin/env bash
# scripts/attach-grok.sh — One-click attach & non-destructive takeover of Grok Bot (Sand) cloud VM.
#
# Usage:
#   ./scripts/attach-grok.sh [SSH_HOST] [OPTIONS]
#
# Examples:
#   ./scripts/attach-grok.sh box@cursor
#   ./scripts/attach-grok.sh box@cursor --port 13370 --display 2 --token my_secret
#   ./scripts/attach-grok.sh user@my-remote-vps --port 13370 --display 2
#
set -euo pipefail

SSH_HOST="${1:-box@cursor}"
if [[ "$SSH_HOST" == --* ]]; then
  SSH_HOST="box@cursor"
fi

BOXD_PORT=13370
DISPLAY_NUM=2
VNC_PORT=6082
BOXD_TOKEN="${AGENTBOX_TOKEN:-lumen_grok_takeover_token}"
AUTO_START_UI=true
DRY_RUN=false

# Parse flags
shift $(( $# > 0 && "$1" != --* ? 1 : 0 )) || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      BOXD_PORT="$2"; shift 2 ;;
    --display)
      DISPLAY_NUM="$2"
      VNC_PORT=$((6080 + DISPLAY_NUM))
      shift 2 ;;
    --token)
      BOXD_TOKEN="$2"; shift 2 ;;
    --no-ui)
      AUTO_START_UI=false; shift ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: $0 [SSH_HOST] [--port PORT] [--display DISPLAY_NUM] [--token TOKEN] [--no-ui]"
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$ROOT_DIR/dist"
DROPIN_ARCHIVE="$DIST_DIR/lumen-dropin.tar.gz"

log() { printf '\033[1;34m[attach-grok]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[attach-grok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[attach-grok]\033[0m %s\n' "$*"; }

log "Target host: $SSH_HOST"
log "Remote boxd port: $BOXD_PORT (Display :$DISPLAY_NUM, VNC :$VNC_PORT)"

if [ "$DRY_RUN" = true ]; then
  log "Dry-run mode. Exiting without execution."
  exit 0
fi

# Step 1: Package drop-in archive
log "1/5. Packaging Lumenbox drop-in sidecar..."
cd "$ROOT_DIR"
npm run pack:dropin

if [ ! -f "$DROPIN_ARCHIVE" ]; then
  echo "ERROR: $DROPIN_ARCHIVE not found after packaging." >&2
  exit 1
fi

# Step 2: Upload to remote host
log "2/5. Uploading sidecar archive to remote $SSH_HOST:~/.lumen..."
ssh "$SSH_HOST" "mkdir -p ~/.lumen/bin ~/.lumen/run"
scp "$DROPIN_ARCHIVE" "$SSH_HOST:~/.lumen/"

# Step 3: Unpack and start remote components
log "3/5. Initializing remote display :$DISPLAY_NUM, boxd, and keep-alive watchdog..."
ssh "$SSH_HOST" "bash -s" <<REMOTE_SCRIPT
set -euo pipefail
tar -xzf ~/.lumen/lumen-dropin.tar.gz -C ~/.lumen/bin/
chmod +x ~/.lumen/bin/*

export PATH="\$HOME/.lumen/bin:\$PATH"

# 1. Start isolated display if not already running
if ! xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
  echo "[remote] Starting Display :$DISPLAY_NUM..."
  start-display "$DISPLAY_NUM"
else
  echo "[remote] Display :$DISPLAY_NUM is already active."
fi

# 2. Start boxd on custom port if not already listening
if ! (exec 3<>"/dev/tcp/127.0.0.1/$BOXD_PORT") 2>/dev/null; then
  echo "[remote] Starting boxd on port $BOXD_PORT..."
  BOXD_PORT="$BOXD_PORT" BOXD_TOKEN="$BOXD_TOKEN" \
    nohup node ~/.lumen/bin/boxd.cjs > /tmp/boxd-$BOXD_PORT.log 2>&1 &
  sleep 1
else
  echo "[remote] boxd is already listening on port $BOXD_PORT."
fi

# 3. Start keep-alive watchdog if not already running
if ! pgrep -f "box-keepalive $DISPLAY_NUM $BOXD_PORT" >/dev/null 2>&1; then
  echo "[remote] Starting keep-alive watchdog..."
  nohup box-keepalive "$DISPLAY_NUM" "$BOXD_PORT" 45 > /tmp/keepalive-$BOXD_PORT.log 2>&1 &
fi
REMOTE_SCRIPT

# Step 4: Establish persistent SSH tunnel
log "4/5. Establishing local SSH port-forwarding tunnel..."
# Kill any stale existing tunnel on the same port
pkill -f "ssh -N -f.*-L $BOXD_PORT:127.0.0.1:$BOXD_PORT" 2>/dev/null || true

ssh -N -f \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=5 \
  -o TCPKeepAlive=yes \
  -o ExitOnForwardFailure=yes \
  -L "$BOXD_PORT:127.0.0.1:$BOXD_PORT" \
  -L "$VNC_PORT:127.0.0.1:$VNC_PORT" \
  "$SSH_HOST"

sleep 1

# Step 5: Verify local tunnel reachability
log "5/5. Verifying connection to remote boxd via local tunnel..."
HEALTH_RESP=$(curl -s "http://127.0.0.1:$BOXD_PORT/health" || echo "")
if [[ "$HEALTH_RESP" =~ "status" ]]; then
  success "Remote boxd is online and healthy!"
else
  warn "Could not verify /health response from http://127.0.0.1:$BOXD_PORT. Response: $HEALTH_RESP"
fi

success "================================================================="
success "🎉 Grok Bot VM Attached Successfully!"
success "  • Remote Box API:      http://127.0.0.1:$BOXD_PORT"
success "  • Secondary Desktop:   Display :$DISPLAY_NUM"
success "  • VNC Live Stream:     http://127.0.0.1:$VNC_PORT (open in browser to watch)"
success "  • Grok Official State: Display :1 & port 9222 untouched & safe"
success "================================================================="

if [ "$AUTO_START_UI" = true ]; then
  log "Launching local LumenBox Orchestrator UI..."
  export AGENTBOX_BOXD_URL="http://127.0.0.1:$BOXD_PORT"
  export AGENTBOX_TOKEN="$BOXD_TOKEN"
  export AGENTBOX_DISPLAY_FLOOR="$DISPLAY_NUM"

  npm run agentbox -- ui --port 3000
else
  echo ""
  echo "To start your local LumenBox agent against this box, run:"
  echo "  export AGENTBOX_BOXD_URL=\"http://127.0.0.1:$BOXD_PORT\""
  echo "  export AGENTBOX_TOKEN=\"$BOXD_TOKEN\""
  echo "  export AGENTBOX_DISPLAY_FLOOR=$DISPLAY_NUM"
  echo "  npm run agentbox -- ui --port 3000"
fi
