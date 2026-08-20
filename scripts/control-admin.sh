#!/usr/bin/env bash
# Operating a running control plane: look at it, restart a box, take one away.
#
# The control plane itself deliberately has no admin API yet, so these are the operations an
# operator actually needs, done directly against Docker and the store. Everything destructive names
# what it will destroy and asks first — the volumes are a tenant's work and their logged-in browser
# sessions, and that is the one irreversible thing this system does.
#
# Usage:
#   scripts/control-admin.sh status              what the control plane knows
#   scripts/control-admin.sh list                containers and volumes, as Docker sees them
#   scripts/control-admin.sh logs <tenant>       that box's container logs
#   scripts/control-admin.sh doctor <tenant>     box-doctor inside that box
#   scripts/control-admin.sh restart <tenant>    restart the container, keep the volumes
#   scripts/control-admin.sh stop <tenant>       stop it, keep everything
#   scripts/control-admin.sh destroy <tenant>    remove container AND volumes — asks first
#   scripts/control-admin.sh clean               destroy every box this prefix owns — asks first
set -euo pipefail

cd "$(dirname "$0")/.."

PREFIX="${AGENTBOX_CONTROL_PREFIX:-agentbox}"
NODE_RUN=(node --experimental-transform-types)

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# The container name the compose allocator would have chosen. Mirrors containerNameFor(): anything
# outside [a-z0-9-] is replaced, and a name with nothing usable becomes a hash. The hash case cannot
# be reproduced in shell, so it is looked up rather than computed.
container_for() {
  local tenant="$1"
  local safe
  safe=$(printf '%s' "${tenant}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' | cut -c1-40 | sed 's/-*$//')
  if [ -n "${safe}" ]; then
    printf '%s-%s' "${PREFIX}" "${safe}"
    return
  fi
  # A non-ASCII tenant name (北京公司, 🚀) hashes; find it among what exists rather than guessing.
  local found
  found=$(docker ps -a --format '{{.Names}}' | grep -E "^${PREFIX}-t[0-9a-f]{12}$" | head -1 || true)
  [ -n "${found}" ] || die "Cannot work out the container for ${JSON:-$tenant}; try \`list\`."
  printf '%s' "${found}"
}

exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }

confirm() {
  printf '%s [y/N] ' "$1"
  read -r answer
  case "${answer}" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

COMMAND="${1:-status}"
shift || true

case "${COMMAND}" in
  status)
    "${NODE_RUN[@]}" src/cli.ts control status
    ;;

  list)
    # Filtered before indenting, not after: Docker strips leading whitespace out of a --format
    # template, so a grep anchored on indentation silently matches nothing and this printed "none"
    # while two containers were running.
    say "containers"
    docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' \
      | grep -E "^${PREFIX}-" | sed 's/^/  /' || note "none"
    say ""
    say "volumes"
    docker volume ls --format '{{.Name}}' | grep -E "^${PREFIX}-" | sed 's/^/  /' || note "none"
    say ""
    # The two together, because a volume with no container is the failure mode that matters: it will
    # be inherited by the next box with the same tenant name.
    for volume in $(docker volume ls --format '{{.Name}}' | grep -E "^${PREFIX}-" || true); do
      base="${volume%-work}"; base="${base%-config}"; base="${base%-hostd}"
      exists "${base}" || warn "  ${volume} has no container — a new box for that tenant would inherit it"
    done
    ;;

  logs)
    [ $# -ge 1 ] || die "Usage: control-admin.sh logs <tenant>"
    docker logs --tail "${2:-200}" "$(container_for "$1")"
    ;;

  doctor)
    [ $# -ge 1 ] || die "Usage: control-admin.sh doctor <tenant>"
    name="$(container_for "$1")"
    exists "${name}" || die "No container ${name}."
    # Runs as the agent's own uid, which is what the agent would see if it ran this itself.
    docker exec --user box "${name}" box-doctor
    ;;

  restart)
    [ $# -ge 1 ] || die "Usage: control-admin.sh restart <tenant>"
    name="$(container_for "$1")"
    exists "${name}" || die "No container ${name}."
    say "restarting ${name} (volumes are kept)"
    docker restart "${name}" > /dev/null
    # The collector will see it come back on its next sweep and un-mark it. Waiting here so the
    # operator does not have to guess whether it worked.
    for _ in $(seq 1 60); do
      state=$(docker inspect --format '{{.State.Health.Status}}' "${name}" 2>/dev/null || echo unknown)
      [ "${state}" = "healthy" ] && { note "healthy"; exit 0; }
      sleep 1
    done
    warn "  still not healthy after 60s — try \`logs ${1}\` and \`doctor ${1}\`"
    exit 1
    ;;

  stop)
    [ $# -ge 1 ] || die "Usage: control-admin.sh stop <tenant>"
    name="$(container_for "$1")"
    exists "${name}" || die "No container ${name}."
    docker stop --timeout 10 "${name}" > /dev/null
    note "stopped ${name}; volumes and the container are kept"
    note "the collector will mark it unreachable after a few sweeps, which is correct"
    ;;

  destroy)
    [ $# -ge 1 ] || die "Usage: control-admin.sh destroy <tenant>"
    name="$(container_for "$1")"
    say "this will permanently delete:"
    note "container  ${name}"
    for suffix in work config hostd; do
      volume="${name}-${suffix}"
      if docker volume ls --format '{{.Name}}' | grep -qx "${volume}"; then
        size=$(docker run --rm -v "${volume}:/v" alpine du -sh /v 2>/dev/null | cut -f1 || echo "?")
        note "volume     ${volume}  (${size})"
      fi
    done
    note ""
    note "work = everything the agents made. config = what the box logged into."
    confirm "Destroy it?" || { note "left alone"; exit 0; }
    docker rm --force "${name}" > /dev/null 2>&1 || true
    for suffix in work config hostd; do
      docker volume rm --force "${name}-${suffix}" > /dev/null 2>&1 || true
    done
    note "destroyed ${name}"
    warn "The store still has a row for it. Sign that tenant in again to get a fresh box."
    ;;

  clean)
    names=$(docker ps -a --format '{{.Names}}' | grep -E "^${PREFIX}-" | grep -v "^${PREFIX}-box$" || true)
    volumes=$(docker volume ls --format '{{.Name}}' | grep -E "^${PREFIX}-" | grep -v "^${PREFIX}-box-" || true)
    if [ -z "${names}" ] && [ -z "${volumes}" ]; then
      note "nothing to clean"
      exit 0
    fi
    say "this will permanently delete every box the control plane made:"
    [ -n "${names}" ] && printf '  %s\n' ${names}
    [ -n "${volumes}" ] && printf '  %s\n' ${volumes}
    note ""
    # agentbox-box is excluded above: that is the single-user box from `agentbox box up`, which this
    # script did not create and has no business removing.
    note "${PREFIX}-box is excluded — that is your own single-user box, not a tenant's."
    confirm "Destroy all of it?" || { note "left alone"; exit 0; }
    [ -n "${names}" ] && docker rm --force ${names} > /dev/null
    [ -n "${volumes}" ] && docker volume rm --force ${volumes} > /dev/null
    note "cleaned"
    ;;

  --help | -h | help)
    sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
    ;;

  *)
    die "Unknown command: ${COMMAND}. Try \`help\`."
    ;;
esac
