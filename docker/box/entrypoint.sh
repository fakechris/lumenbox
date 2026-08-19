#!/usr/bin/env bash
# Container entrypoint: the desktop, the daemon, and optionally the orchestrator.
#
# Runs as root and drops privileges per process. Two users, on purpose:
#
#   box    the agent — its shell, desktop and browser. Everything it creates must be
#          box-owned, or its browser profile breaks in confusing ways.
#   hostd  the orchestrator, when it runs in here instead of on someone's laptop. A
#          separate uid so its transcripts, desktop-owner tokens and model credential are
#          not lying in the agent's own home directory.
#
# The orchestrator is off unless AGENTBOX_HOST_ENABLED=1. With it off this is the same box
# as before, driven from outside; with it on, the box is self-contained and the only thing
# outside it is a browser.
set -euo pipefail

log() { printf '[box] %s\n' "$*"; }

# docker stop sends SIGTERM here; without this the supervise loops would restart the
# services being shut down and the stop would wait out its timeout.
#
# The shell ignores the signal for itself before signalling the group, because `kill 0`
# includes the sender: with the handler still installed it re-entered itself once per
# signal until bash blew its stack and the container exited 139 on an ordinary
# `docker stop`. Only visible once PID 1 stopped sharing this process group, which is
# how a latent bug in a trap survives for weeks.
shutdown() {
  trap '' TERM INT
  log "signal received; stopping"
  kill -TERM 0 2>/dev/null || true
  # A moment for the services to close their sockets and finish their logs.
  sleep 1
  exit 0
}
trap shutdown TERM INT

if [[ -z "${BOXD_TOKEN:-}" ]]; then
  log "FATAL: BOXD_TOKEN is not set. The daemon exposes shell access and refuses"
  log "       to run without a token. Start the box via 'agentbox box up'."
  exit 1
fi

# Run something as one of the two users. --init-groups so the process gets that user's
# supplementary groups rather than root's.
as_user() {
  local user="$1"
  shift
  setpriv --reuid="${user}" --regid="${user}" --init-groups "$@"
}

# Volumes arrive owned by whoever the image left the mount point owned by, and a bind
# mount arrives owned by the host's uid. Repairing it here is the only place that can:
# by the time either service is running, it has already dropped root.
for dir in /home/box/work /home/box/.config /home/box/Desktop; do
  mkdir -p "${dir}"
  chown box:box "${dir}" 2>/dev/null || true
done

# The config directory is a volume, so it survives the image it came from. Re-seed the
# files the image owns — desktop launchers, the libfm and pcmanfm settings — or a box
# created months ago keeps its old copies and a fix shipped in the image never arrives.
# Everything else in there is left alone: browser profiles and logins are the reason the
# volume exists.
#
# cp -r rather than -a on purpose: preserving ownership from the image would undo the
# chown above.
if [[ -d /usr/local/share/agentbox/skel ]]; then
  log "re-seeding desktop config from the image"
  cp -rf /usr/local/share/agentbox/skel/. /home/box/
  chown -R box:box /home/box/Desktop /home/box/.config 2>/dev/null || true
fi

# Display 1 is the default: an agent with no assignment lands here, and it is what
# `box shot` and the smoke test look at.
log "starting the first desktop"
if ! as_user box env HOME=/home/box /usr/local/bin/start-display 1; then
  log "FATAL: could not start display 1"
  exit 1
fi

# ── keeping the services alive ────────────────────────────────────────────────────
# Restarted in place rather than by letting the container die, because the container is
# not the unit worth recycling: the desktops, the browser sessions and whatever an agent
# is in the middle of all live in here, and taking the container down to recover one
# crashed service destroys all of it. Measured before this existed — killing the
# orchestrator exited the container, and everything went with it.
#
# Backoff so a service that cannot start is not hammered, and a cap so one that never
# stays up escalates to the restart policy instead of looping in here forever. The cap is
# per service and resets once it has run for a while, which is what tells a crash-loop
# apart from a service that dies once a day.
FLAP_SECONDS="${AGENTBOX_FLAP_SECONDS:-60}"
MAX_RESTARTS="${AGENTBOX_MAX_RESTARTS:-8}"
MAX_DELAY="${AGENTBOX_MAX_DELAY:-60}"

supervise() {
  local name="$1"
  shift
  local delay=1 restarts=0 started ran code pid
  while :; do
    started=$(date +%s)
    "$@" &
    pid=$!
    set +e
    wait "${pid}"
    code=$?
    set -e
    ran=$(( $(date +%s) - started ))

    # Ran long enough to count as having worked: this is a fresh failure, not a flap.
    if [ "${ran}" -ge "${FLAP_SECONDS}" ]; then
      delay=1
      restarts=0
    fi

    restarts=$(( restarts + 1 ))
    if [ "${restarts}" -gt "${MAX_RESTARTS}" ]; then
      log "${name} failed ${restarts} times without staying up; letting the box restart"
      return 1
    fi

    log "${name} exited (${code}) after ${ran}s; restarting in ${delay}s"
    sleep "${delay}"
    delay=$(( delay * 2 ))
    [ "${delay}" -gt "${MAX_DELAY}" ] && delay="${MAX_DELAY}"
  done
}

log "starting boxd"
supervise boxd as_user box env HOME=/home/box BOXD_TOKEN="${BOXD_TOKEN}" \
  node /opt/boxd/boxd.cjs &
BOXD_PID=$!

if [[ "${AGENTBOX_HOST_ENABLED:-0}" != "1" ]]; then
  # Driven from outside: boxd is the whole job. Its supervisor only returns when boxd
  # cannot be kept alive, and then the container's restart policy is the bigger hammer.
  wait "${BOXD_PID}"
  exit $?
fi

# ── the orchestrator, in here ─────────────────────────────────────────────────────
# Waited for rather than raced: the orchestrator connects to boxd on startup, and one
# that starts first reports "box unavailable" and runs its agents without any tools.
log "waiting for boxd"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:1337/health > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -fsS http://127.0.0.1:1337/health > /dev/null 2>&1; then
  log "FATAL: boxd did not come up; not starting the orchestrator"
  exit 1
fi

# hostd's state: transcripts, agent profiles, desktop-owner tokens, config. Private to
# hostd, which is the point of it being a separate user.
AGENTBOX_HOME="${AGENTBOX_HOME:-/home/hostd/.agentbox}"
mkdir -p "${AGENTBOX_HOME}"
chown -R hostd:hostd /home/hostd 2>/dev/null || true
chmod 700 /home/hostd "${AGENTBOX_HOME}" 2>/dev/null || true

log "starting the orchestrator as hostd (web UI on 7777)"
# Over loopback: the orchestrator and the daemon are in the same container now, so this
# is the same HTTP contract with the network hop removed.
supervise hostd as_user hostd env \
  HOME=/home/hostd \
  AGENTBOX_HOME="${AGENTBOX_HOME}" \
  AGENTBOX_BOXD_URL="http://127.0.0.1:1337" \
  AGENTBOX_TOKEN="${BOXD_TOKEN}" \
  AGENTBOX_VENDOR_DIR=/opt/hostd/vendor \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  MINIMAX_CODE_CN_API_KEY="${MINIMAX_CODE_CN_API_KEY:-}" \
  AGENTBOX_API_KEY="${AGENTBOX_API_KEY:-}" \
  AGENTBOX_BASE_URL="${AGENTBOX_BASE_URL:-}" \
  AGENTBOX_MODEL="${AGENTBOX_MODEL:-}" \
  AGENTBOX_PROVIDER="${AGENTBOX_PROVIDER:-}" \
  node /opt/hostd/hostd.mjs web --host 0.0.0.0 --port 7777 &
HOSTD_PID=$!

# Each service is supervised, so reaching here means one of them could not be kept alive
# at all. That is when the container should go: a restart gets a clean /tmp, a fresh X
# lock, and a new attempt at everything.
wait -n "${BOXD_PID}" "${HOSTD_PID}"
status=$?
log "a service could not be kept alive (${status}); shutting the box down"
exit "${status}"
