#!/usr/bin/env bash
# Brings up the box desktop, then the daemon.
#
# Order matters: Xvfb must be answering before x11vnc or the daemon's display
# detection will attach to nothing.
set -euo pipefail

WIDTH="${DISPLAY_WIDTH:-1280}"
HEIGHT="${DISPLAY_HEIGHT:-800}"
DISPLAY_NUM="${DISPLAY:-:1}"
SCREEN="${WIDTH}x${HEIGHT}x24"

log() { printf '[box] %s\n' "$*"; }

if [[ -z "${BOXD_TOKEN:-}" ]]; then
  log "FATAL: BOXD_TOKEN is not set. The daemon exposes shell access and refuses"
  log "       to run without a token. Start the box via 'agentbox box up'."
  exit 1
fi

# Track children so a failure takes the whole container down rather than leaving
# a half-running desktop that looks healthy but cannot be driven.
pids=()
cleanup() {
  log "shutting down"
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

log "starting Xvfb on ${DISPLAY_NUM} at ${SCREEN}"
# -noreset keeps the server alive when the last client disconnects, so a crashing
# browser does not reset the whole display and invalidate our detected geometry.
Xvfb "${DISPLAY_NUM}" -screen 0 "${SCREEN}" -ac -noreset +extension RANDR \
  > /tmp/xvfb.log 2>&1 &
pids+=($!)

# Wait for the server rather than sleeping a fixed amount: on a loaded host Xvfb
# can take a couple of seconds, and a fixed sleep is either slow or flaky.
for _ in $(seq 1 60); do
  if xdpyinfo -display "${DISPLAY_NUM}" > /dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! xdpyinfo -display "${DISPLAY_NUM}" > /dev/null 2>&1; then
  log "FATAL: Xvfb did not come up. Log follows:"
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi
log "Xvfb ready"

# A window manager is not optional: without one, dialogs open unmapped and
# keyboard focus never lands anywhere, so typing silently goes nowhere.
# No --daemon: we want xfwm4 in the foreground of this job so the pid we record is
# the window manager itself and not a launcher that has already exited.
log "starting window manager"
dbus-launch --exit-with-session xfwm4 --replace > /tmp/xfwm4.log 2>&1 &
pids+=($!)

log "starting x11vnc"
x11vnc -display "${DISPLAY_NUM}" -forever -shared -nopw -quiet -localhost \
  -rfbport 5900 > /tmp/x11vnc.log 2>&1 &
pids+=($!)

log "starting noVNC on 6080"
websockify --web=/usr/share/novnc 6080 localhost:5900 \
  > /tmp/novnc.log 2>&1 &
pids+=($!)

# A neutral background makes screenshots easier for the model to read than the
# default X stipple, which looks like noise.
xsetroot -display "${DISPLAY_NUM}" -solid "#1f2430" 2>/dev/null || true

log "starting boxd"
exec node /opt/boxd/boxd.cjs
