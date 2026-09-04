#!/usr/bin/env bash
# lumen-bridge — prepare a Grok Bot box (or any Debian-like VM you have a shell in) so a
# LumenBox installation can drive it as an attached box, without touching what is already
# running there. Idempotent: every subcommand can be run again.
#
#   lumen-bridge.sh check                 what this box is, what is missing, what is in the way
#   lumen-bridge.sh tailscale [--hostname NAME]
#                                         install Tailscale if needed, join the tailnet with
#                                         Tailscale SSH on; prints the login URL to hand to the
#                                         person, waits for the login, prints the address
#   lumen-bridge.sh install [--display N] [--port P] [--from URL|FILE] [--token T]
#                                         unpack the LumenBox box daemon, mint a token, start a
#                                         desktop of our own and the daemon on the tailnet
#   lumen-bridge.sh start                 (re)start desktop + daemon + keep-alive (also @reboot)
#   lumen-bridge.sh status                is it up, where, since when
#   lumen-bridge.sh token                 print the token (only when the person asked for it)
#   lumen-bridge.sh connect-hint          what to type on the laptop
#
# Displays :1..:9 are the host bot's own (Grok gives each bot a desktop); ours start at :10 and
# every derived port (VNC 5910, noVNC 6090, Chrome 9232) is clear of theirs by construction.
set -euo pipefail

LUMEN_HOME="${LUMEN_HOME:-$HOME/.lumen}"
BIN="$LUMEN_HOME/bin"
RUN="$LUMEN_HOME/run"
TOKEN_FILE="$LUMEN_HOME/token"
DISPLAY_NUM="${LUMEN_DISPLAY:-10}"
BOXD_PORT="${LUMEN_PORT:-13370}"
DROPIN_URL="${LUMEN_DROPIN_URL:-https://github.com/fakechris/lumenbox/releases/latest/download/lumen-dropin.tar.gz}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

say() { printf '[lumen-bridge] %s\n' "$*"; }
die() { printf '[lumen-bridge] ERROR: %s\n' "$*" >&2; exit 1; }

node22() {
  for candidate in node /exec-daemon/node /usr/local/bin/node; do
    if command -v "$candidate" >/dev/null 2>&1; then
      major="$("$candidate" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
      if [ "$major" -ge 22 ]; then echo "$candidate"; return 0; fi
    fi
  done
  return 1
}

ts_ip() { tailscale ip -4 2>/dev/null | head -1 || true; }
listening() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }

cmd_check() {
  say "user: $(whoami) on $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s) ($(uname -m))"
  if sudo -n true 2>/dev/null; then say "sudo: yes (passwordless)"; else say "sudo: no — Tailscale can still be installed if it is already there; otherwise the host must add it"; fi
  if command -v apt-get >/dev/null 2>&1; then say "packages: apt"; else say "packages: no apt — install steps assume Debian/Ubuntu"; fi
  if n="$(node22)"; then say "node >= 22: $n ($("$n" -v))"; else say "node >= 22: MISSING — the daemon needs it (Grok boxes ship one at /exec-daemon/node)"; fi
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(ts_ip)"; if [ -n "$ip" ]; then say "tailscale: $(tailscale version | head -1), joined as $ip"; else say "tailscale: installed, not joined"; fi
  else say "tailscale: not installed"; fi
  for d in 1 2 3 4 5; do xdpyinfo -display ":$d" >/dev/null 2>&1 && say "display :$d is in use (the host bot's — left alone)"; done
  if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
    if [ -f "$RUN/display-$DISPLAY_NUM" ]; then say "display :$DISPLAY_NUM: ours, up"; else say "display :$DISPLAY_NUM: in use by something else — pick another with --display"; fi
  else say "display :$DISPLAY_NUM: free"; fi
  if [ -x "$BIN/boxd.cjs" ] || [ -f "$BIN/boxd.cjs" ]; then say "daemon: installed at $BIN"; else say "daemon: not installed"; fi
  ip="$(ts_ip)"; if [ -n "$ip" ] && listening "$ip" "$BOXD_PORT"; then say "daemon: listening on $ip:$BOXD_PORT"; fi
  [ -s "$TOKEN_FILE" ] && say "token: present ($TOKEN_FILE)" || say "token: none yet"
  command -v xdpyinfo >/dev/null 2>&1 || say "xdpyinfo missing: apt install x11-utils (the check above could not see displays)"
}

cmd_tailscale() {
  local hostname="lumenbox-$(hostname -s 2>/dev/null | tr -c 'a-z0-9\n' '-' | head -c 20)"
  while [ $# -gt 0 ]; do case "$1" in --hostname) hostname="$2"; shift 2 ;; *) die "unknown option $1" ;; esac; done
  if ! command -v tailscale >/dev/null 2>&1; then
    say "installing Tailscale (official script, needs sudo) ..."
    curl -fsSL https://tailscale.com/install.sh | sudo sh
  fi
  if [ -n "$(ts_ip)" ]; then
    say "already joined: $(ts_ip) ($(tailscale status --self --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1))"
    sudo tailscale set --ssh >/dev/null 2>&1 || true
    return 0
  fi
  say "joining the tailnet with Tailscale SSH on; a login link follows — the person opens it and signs in with their Tailscale account"
  # --ssh: their laptop reaches this box with `ssh box@<hostname>` and no key to manage.
  # The command prints the URL and waits; we run it in the background and read the URL.
  sudo tailscale up --ssh --hostname "$hostname" --timeout 0s > "$RUN/tailscale-up.log" 2>&1 &
  mkdir -p "$RUN"
  for _ in $(seq 1 40); do
    url="$(grep -o 'https://login.tailscale.com/[A-Za-z0-9/._-]*' "$RUN/tailscale-up.log" 2>/dev/null | head -1 || true)"
    [ -n "$url" ] && break
    sleep 0.5
  done
  if [ -z "${url:-}" ]; then cat "$RUN/tailscale-up.log" >&2; die "tailscale up printed no login link"; fi
  printf 'LOGIN_URL %s\n' "$url"
  say "waiting for the login (up to 10 minutes) ..."
  for _ in $(seq 1 600); do
    ip="$(ts_ip)"; if [ -n "$ip" ]; then say "joined: $ip as $hostname"; printf 'TAILSCALE_IP %s\nTAILSCALE_HOST %s\n' "$ip" "$hostname"; return 0; fi
    sleep 1
  done
  die "not joined after 10 minutes; run 'lumen-bridge.sh tailscale' again once the person has signed in"
}

cmd_install() {
  local from="$DROPIN_URL" token=""
  while [ $# -gt 0 ]; do case "$1" in
    --display) DISPLAY_NUM="$2"; shift 2 ;; --port) BOXD_PORT="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;; --token) token="$2"; shift 2 ;; *) die "unknown option $1" ;; esac; done
  (( DISPLAY_NUM >= 10 )) || die "displays :1..:9 are the host bot's; use --display 10 or higher"
  mkdir -p "$BIN" "$RUN" "$HOME/work"
  if [ -f "$from" ]; then
    [ "$(readlink -f "$from")" = "$(readlink -f "$LUMEN_HOME/lumen-dropin.tar.gz")" ] || cp "$from" "$LUMEN_HOME/lumen-dropin.tar.gz"
  else say "downloading the box daemon from $from ..."; curl -fsSL "$from" -o "$LUMEN_HOME/lumen-dropin.tar.gz"; fi
  tar -xzf "$LUMEN_HOME/lumen-dropin.tar.gz" -C "$BIN/"
  chmod +x "$BIN"/* 2>/dev/null || true
  if [ -n "$token" ]; then (umask 077; printf '%s\n' "$token" > "$TOKEN_FILE")
  elif [ ! -s "$TOKEN_FILE" ]; then (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > "$TOKEN_FILE"); say "minted a token at $TOKEN_FILE"
  fi
  printf '%s\n%s\n' "$DISPLAY_NUM" "$BOXD_PORT" > "$RUN/config"
  # Survive a VM reboot: the keep-alive only outlives a session, cron outlives the box.
  ( crontab -l 2>/dev/null | grep -v 'lumen-bridge.sh start' ; echo "@reboot sleep 20 && $BIN/lumen-bridge.sh start >> /tmp/lumen-bridge-boot.log 2>&1" ) | crontab - 2>/dev/null || say "could not install the @reboot line (no cron); run 'lumen-bridge.sh start' after a reboot"
  cp "$SELF" "$BIN/lumen-bridge.sh" 2>/dev/null || true
  cmd_start
}

cmd_start() {
  [ -f "$RUN/config" ] && { DISPLAY_NUM="$(sed -n 1p "$RUN/config")"; BOXD_PORT="$(sed -n 2p "$RUN/config")"; }
  export PATH="$BIN:$PATH"
  local node; node="$(node22)" || die "no node >= 22 (the daemon needs a global WebSocket)"
  local bind; bind="$(ts_ip)"; [ -n "$bind" ] || die "not on a tailnet yet — run 'lumen-bridge.sh tailscale' first"
  [ -s "$TOKEN_FILE" ] || die "no token — run 'lumen-bridge.sh install' first"
  local mark="$RUN/display-$DISPLAY_NUM"
  if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
    [ -f "$mark" ] || die "display :$DISPLAY_NUM is in use by something that is not ours"
  else
    say "starting display :$DISPLAY_NUM ..."
    PLANK_DOCK=lumen "$BIN/start-display" "$DISPLAY_NUM"
    date +%s > "$mark"
  fi
  if ! listening "$bind" "$BOXD_PORT"; then
    pkill -f "[l]umen/bin/boxd.cjs" 2>/dev/null || true
    sleep 1
    say "starting the daemon on $bind:$BOXD_PORT ..."
    DISPLAY=":$DISPLAY_NUM" BOXD_PORT="$BOXD_PORT" BOXD_BIND="$bind" BOXD_TOKEN="$(cat "$TOKEN_FILE")" DEFAULT_DISPLAY="$DISPLAY_NUM" \
      BOXD_START_DISPLAY="$BIN/start-display" PLANK_DOCK=lumen \
      nohup "$node" "$BIN/boxd.cjs" > "/tmp/boxd-$BOXD_PORT.log" 2>&1 &
    for _ in $(seq 1 30); do listening "$bind" "$BOXD_PORT" && break; sleep 0.5; done
    listening "$bind" "$BOXD_PORT" || { tail -20 "/tmp/boxd-$BOXD_PORT.log" >&2; die "the daemon did not come up"; }
  fi
  pkill -f "box-keepalive $DISPLAY_NUM $BOXD_PORT" 2>/dev/null || true
  nohup "$BIN/box-keepalive" "$DISPLAY_NUM" "$BOXD_PORT" 45 "$bind" > "/tmp/keepalive-$BOXD_PORT.log" 2>&1 &
  say "up: http://$bind:$BOXD_PORT (display :$DISPLAY_NUM)"
  printf 'BOXD_URL http://%s:%s\n' "$bind" "$BOXD_PORT"
}

cmd_status() {
  [ -f "$RUN/config" ] && { DISPLAY_NUM="$(sed -n 1p "$RUN/config")"; BOXD_PORT="$(sed -n 2p "$RUN/config")"; }
  local bind; bind="$(ts_ip)"
  if [ -n "$bind" ] && listening "$bind" "$BOXD_PORT"; then
    say "daemon up at http://$bind:$BOXD_PORT (display :$DISPLAY_NUM); health: $(curl -s -m 5 "http://$bind:$BOXD_PORT/health" | head -c 200)"
    printf 'BOXD_URL http://%s:%s\n' "$bind" "$BOXD_PORT"
  else say "daemon not listening (tailnet: ${bind:-not joined}); run 'lumen-bridge.sh start'"; fi
}

cmd_token() { [ -s "$TOKEN_FILE" ] || die "no token yet"; cat "$TOKEN_FILE"; }

cmd_connect_hint() {
  [ -f "$RUN/config" ] && BOXD_PORT="$(sed -n 2p "$RUN/config")"
  local ip host; ip="$(ts_ip)"; host="$(tailscale status --self --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
  cat <<HINT
On the laptop (Tailscale signed in to the same account):
  1. Read the token over Tailscale SSH — it never has to pass through a chat:
       ssh $(whoami)@${host:-<this-box>} cat ~/.lumen/token
  2. In LumenBox: Settings → Boxes → Attach
       name: grok    URL: http://${ip:-<tailscale-ip>}:$BOXD_PORT    token: (paste)
     or on the command line:
       agentbox box attach grok http://${ip:-<tailscale-ip>}:$BOXD_PORT --token-file <(ssh $(whoami)@${host:-<this-box>} cat ~/.lumen/token) --display-floor 10
  3. Create an agent in box "grok". Its desktop is :10 here — the host bot's own desktops are untouched.
HINT
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  tailscale) shift; cmd_tailscale "$@" ;;
  install) shift; cmd_install "$@" ;;
  start) shift; cmd_start "$@" ;;
  status) shift; cmd_status "$@" ;;
  token) shift; cmd_token "$@" ;;
  connect-hint) shift; cmd_connect_hint "$@" ;;
  *) sed -n '2,20p' "$SELF"; exit 1 ;;
esac
