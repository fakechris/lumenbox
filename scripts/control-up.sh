#!/usr/bin/env bash
# Start the control plane, building whatever is stale first.
#
# The one command to go from a checked-out repo to two people signing in and each getting their own
# box. It exists because the manual sequence has four steps with an ordering constraint — the
# bundles have to be built before the image, and the image before a box can start — and getting that
# wrong produces a 404 from a stale bundle rather than an error, which cost real time to diagnose
# once already.
#
# Deliberately not a daemon. It runs in the foreground and stops on Ctrl-C, and the boxes it created
# keep running afterwards: they are not children of this process, which is the whole point of the
# control plane not being in the path of a turn.
#
# Usage:
#   scripts/control-up.sh                      # build if stale, then start on 127.0.0.1:8080
#   scripts/control-up.sh --skip-build         # trust what is there
#   scripts/control-up.sh --port 9000
#   AGENTBOX_CONTROL_USERS=... scripts/control-up.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=8080
SKIP_BUILD=0
# A plain string rather than an array: macOS ships bash 3.2, where expanding an empty array under
# `set -u` is an unbound-variable error. Found by running this, not by reading it.
EXTRA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --help | -h)
      sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *) EXTRA="${EXTRA} $1"; shift ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

IMAGE="${AGENTBOX_IMAGE:-agentbox/box:latest}"
NODE_RUN=(node --experimental-transform-types)

# ── what has to be true before anything else ──────────────────────────────────────
docker version > /dev/null 2>&1 || die \
  "Cannot reach a Docker engine. Check \`docker version\`, DOCKER_HOST, and your docker context."

say "checking the build"
if [ "${SKIP_BUILD}" = "1" ]; then
  note "skipped"
else
  # The bundle inside the image is what a box actually runs. If it is older than the source, a box
  # will start and then answer 404 to endpoints that exist in this checkout — which reads as a bug
  # in the control plane rather than as a stale image. Compared by timestamp against the newest
  # source file, so this is cheap enough to do every time.
  NEWEST_SOURCE=$(find src docker/box -type f \( -name '*.ts' -o -name 'Dockerfile' -o -name 'entrypoint.sh' \) \
    -newer docker/box/hostd.mjs 2>/dev/null | head -1 || true)
  if [ ! -f docker/box/hostd.mjs ] || [ -n "${NEWEST_SOURCE}" ]; then
    note "bundles are stale (${NEWEST_SOURCE:-missing}); rebuilding"
    npm run build:box > /dev/null 2>&1
    note "built docker/box/hostd.mjs and boxd.cjs"
    NEEDS_IMAGE=1
  else
    note "bundles are current"
    NEEDS_IMAGE=0
  fi

  IMAGE_ID=$(docker images --quiet "${IMAGE}" 2>/dev/null || true)
  if [ -z "${IMAGE_ID}" ]; then
    note "image ${IMAGE} does not exist; building it"
    NEEDS_IMAGE=1
  fi

  if [ "${NEEDS_IMAGE}" = "1" ]; then
    note "building ${IMAGE} (a minute or two the first time)"
    docker build --quiet --tag "${IMAGE}" docker/box > /dev/null
    note "built ${IMAGE}"
  else
    note "image ${IMAGE} is current"
  fi
fi

# ── credentials ───────────────────────────────────────────────────────────────────
# Persisted rather than regenerated, so the password does not change under you between restarts.
# The control plane will generate one if this is unset, but then it is different every time and a
# browser session from the last run stops working.
HOME_DIR="${AGENTBOX_HOME:-${HOME}/.agentbox}"
USERS_FILE="${HOME_DIR}/control/users"
if [ -z "${AGENTBOX_CONTROL_USERS:-}" ]; then
  if [ -f "${USERS_FILE}" ]; then
    AGENTBOX_CONTROL_USERS="$(cat "${USERS_FILE}")"
    note "using the users in ${USERS_FILE}"
  else
    mkdir -p "$(dirname "${USERS_FILE}")"
    PASSWORD="$(openssl rand -base64 12 2>/dev/null | tr -d '/+=' | cut -c1-16)"
    [ -n "${PASSWORD}" ] || PASSWORD="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    AGENTBOX_CONTROL_USERS="alice:${PASSWORD}:acme,bob:${PASSWORD}:beta"
    printf '%s' "${AGENTBOX_CONTROL_USERS}" > "${USERS_FILE}"
    chmod 600 "${USERS_FILE}"
    say ""
    say "two users created, saved to ${USERS_FILE}"
    note "alice / ${PASSWORD}   → tenant acme"
    note "bob   / ${PASSWORD}   → tenant beta"
    note "Two so you can see that they get different boxes. Same password on purpose:"
    note "this is a test deployment, and the password list is a placeholder anyway."
  fi
fi
export AGENTBOX_CONTROL_USERS

if [ -z "${AGENTBOX_PROVIDER:-}" ]; then
  # Not fatal: a box comes up and the UI works. But every turn will fail on a missing key, which
  # looks like a broken agent rather than a missing setting.
  warn "AGENTBOX_PROVIDER is unset, so boxes default to Anthropic."
  warn "Agents will fail on every turn unless ANTHROPIC_API_KEY is set."
  warn "Set AGENTBOX_PROVIDER=minimax (or another provider) to use a different key."
fi

say ""
say "starting the control plane"
note "Ctrl-C stops it. Boxes keep running — use scripts/control-admin.sh to manage them."
say ""

# Unquoted on purpose: these are already-split flags like `--sweep-seconds 5`.
# shellcheck disable=SC2086
exec "${NODE_RUN[@]}" src/cli.ts control up --port "${PORT}" --image "${IMAGE}" ${EXTRA}
