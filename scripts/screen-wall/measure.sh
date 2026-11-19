#!/bin/bash
# What stands between a confined command and a Mac's screen, measured (INV-1756).
#
# Where a node opens the machine's own screen, the app's Screen Recording and Accessibility are
# inherited by everything it starts, the box's confined shell included. Refusing to start
# `screencapture` stops nothing an agent compiles itself. This script finds out, on a real macOS,
# which services such a program needs, and whether the profile the daemon builds refuses them:
#
#   1. control    every way in, run bare. A way in that does not work bare proves nothing later.
#   2. trace      every way in, under a profile that allows everything and reports each Mach
#                 lookup and IOKit open, read back from the system log.
#   3. needs      each service the trace named, refused alone: does the way in still work?
#   3b. the same for Accessibility, whose service is looked up under a local name.
#   4. wall       every way in under the daemon's own profile, screen closed and screen open
#                 (scripts/screen-wall/profile.ts), and the ordinary commands under both
#                 (scripts/screen-wall/ordinary.sh, which touches no screen and runs anywhere).
#
# NEVER RUN THIS IN A PERSON'S SESSION. It moves the pointer and captures the screen, and a run
# that is "supposed to be refused" lands on the desktop when the refusal is wrong. It starts only
# on a hosted CI runner, or where SCREEN_WALL_THROWAWAY_USER names the account it is running as —
# an account made for this and deleted after, logged in at the console, with Screen Recording and
# Accessibility granted to the terminal it is run from.
#
# Exit 0 when nothing got through the open-screen profile and no ordinary command was lost to it.
# The lines starting with a word and a tab are the result; everything else is commentary.

set -u

if [ "$(uname)" != "Darwin" ]; then
  echo "screen-wall: macOS only" >&2
  exit 2
fi
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]; then
  :
elif [ -n "${SCREEN_WALL_THROWAWAY_USER:-}" ] && [ "$SCREEN_WALL_THROWAWAY_USER" = "$(id -un)" ]; then
  :
else
  echo "screen-wall: refused. This posts input and captures the screen; it runs only on a hosted CI runner," >&2
  echo "or in a throwaway account named in SCREEN_WALL_THROWAWAY_USER. Never in a person's session." >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=$(cd "$(mktemp -d /tmp/screen-wall.XXXXXX)" && pwd -P)
mkdir -p "$work/bin" "$work/out" "$work/trace"
results="$work/results.tsv"
: > "$results"

ACTIONS="move warp hidpost hiddevice capture wincapture sck render windows ax screencapture applescript"
INPUT_ACTIONS="move warp hidpost hiddevice applescript"

say() { printf '\n=== %s\n' "$*"; }
row() { printf '%s\n' "$*" | tee -a "$results"; }
# A refused call sometimes waits for a server that will not answer: nothing here runs longer than this.
limit() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }
pointer() { "$probe" where 2>/dev/null | awk '{print $2 "," $3}'; }

say "machine"
sw_vers
uname -m
echo "user: $(id -un), session manager: $(launchctl managername 2>/dev/null)"

say "build"
probe="$work/bin/probe"
clang -fobjc-arc -framework ApplicationServices -framework IOKit -framework ImageIO -framework CoreServices -framework Foundation -o "$probe" "$here/probe.m" || exit 1
# The same programs the profile refuses to start, under another name: a rule on a path does not follow a copy.
cp /usr/sbin/screencapture "$work/bin/screencapture-copy"
cp /usr/bin/osascript "$work/bin/osascript-copy"

say "what this session holds"
"$probe" state | tee "$work/state.txt"

serial=0
# act <action> <profile, or empty for bare>: prints "yes|no <tab> exit N <tab> what the program said".
# "yes" is an effect seen from outside the sandbox: the pointer somewhere else, a picture on disk.
act() {
  local action=$1 profile=$2 detail code effect before after out program
  serial=$((serial + 1))
  out="$work/out/$action-$serial.png"
  # Under its own name each time: the system log drops a report it has already made for a name.
  program="$work/bin/p$serial-$action"
  case $action in
    screencapture) cp "$work/bin/screencapture-copy" "$program" ;;
    applescript) cp "$work/bin/osascript-copy" "$program" ;;
    *) cp "$probe" "$program" ;;
  esac
  run() {
    if [ -z "$profile" ]; then limit 25 "$@"; else limit 25 /usr/bin/sandbox-exec -p "$profile" "$@"; fi
  }
  case $action in
    move | warp | hidpost | hiddevice)
      "$probe" warp 40 40 > /dev/null 2>&1
      before=$(pointer)
      if [ "$action" = "hiddevice" ]; then detail=$(run "$program" hiddevice 2>&1); else detail=$(run "$program" "$action" 300 200 2>&1); fi
      code=$?
      after=$(pointer)
      if [ -n "$after" ] && [ "$after" != "$before" ]; then effect=yes; else effect=no; fi
      detail="$detail; pointer $before -> $after"
      ;;
    capture | wincapture | sck | render)
      detail=$(run "$program" "$action" "$out" 2>&1)
      code=$?
      if [ -s "$out" ]; then effect=yes; else effect=no; fi
      ;;
    screencapture)
      detail=$(run "$program" -x "$out" 2>&1)
      code=$?
      if [ -s "$out" ]; then effect=yes; else effect=no; fi
      ;;
    applescript)
      # Key code 80 is F19: a key press nothing is bound to.
      detail=$(run "$program" -e 'tell application "System Events" to key code 80' 2>&1)
      code=$?
      if [ $code -eq 0 ]; then effect=yes; else effect=no; fi
      ;;
    ax)
      # Finder is always there to be read.
      detail=$(run "$program" ax "$(pgrep -x Finder | head -1)" 2>&1)
      code=$?
      if [ $code -eq 0 ]; then effect=yes; else effect=no; fi
      ;;
    *)
      detail=$(run "$program" "$action" 2>&1)
      code=$?
      if [ $code -eq 0 ]; then effect=yes; else effect=no; fi
      ;;
  esac
  printf '%s\texit %s\t%s' "$effect" "$code" "$(printf '%s' "$detail" | tr '\n\t' '  ' | cut -c1-400)"
}
# act runs in a subshell when its output is captured, so the counter is advanced here too.
measured() {
  measured_out=$(act "$1" "$2")
  serial=$((serial + 1))
  measured_effect=${measured_out%%	*}
}

say "1. control: every way in, bare"
for action in $ACTIONS; do
  measured "$action" ""
  row "control	$action	$measured_out"
  eval "control_$action=$measured_effect"
done

say "2. trace: the services each way in looks up"
TRACE='(version 1)(allow default)(allow (with report) mach-lookup)(allow (with report) iokit-open)'
for action in $ACTIONS; do
  started=$(date '+%Y-%m-%d %H:%M:%S')
  name="p$((serial + 1))-$action"
  measured "$action" "$TRACE"
  row "traced	$action	$measured_out"
  eval "traced_$action=$measured_effect"
  sleep 3
  sudo log show --start "$started" --style compact --predicate 'sender == "Sandbox"' 2> /dev/null > "$work/trace/$action.log"
  grep -F "$name(" "$work/trace/$action.log" | grep -Eo '(mach-lookup|iokit-open[a-z-]*) [^ ]+' | sort -u > "$work/trace/$action.txt"
  echo "  $action: $(wc -l < "$work/trace/$action.txt" | tr -d ' ') distinct lookups reported for $name ($(wc -l < "$work/trace/$action.log" | tr -d ' ') sandbox log lines in the window)"
  sed 's/^/    /' "$work/trace/$action.txt"
done
if [ "$(cat "$work"/trace/*.txt | wc -l | tr -d ' ')" = "0" ]; then
  echo "  the report profile named nothing; a sample of what the log holds:"
  head -5 "$work/trace/move.log"
  # The other way to learn names: refuse every lookup and read the refusals. It stops at the first one a program cannot do without.
  say "2b. trace by refusal"
  for action in $ACTIONS; do
    started=$(date '+%Y-%m-%d %H:%M:%S')
    name="p$((serial + 1))-$action"
    measured "$action" '(version 1)(allow default)(deny mach-lookup)(deny iokit-open)'
    sleep 3
    sudo log show --start "$started" --style compact --predicate 'sender == "Sandbox"' 2> /dev/null | grep -F "$name(" | grep -Eo '(mach-lookup|iokit-open[a-z-]*) [^ ]+' | sort -u > "$work/trace/$action.txt"
    echo "  $action: $(wc -l < "$work/trace/$action.txt" | tr -d ' ') refused lookups"
    sed 's/^/    /' "$work/trace/$action.txt"
  done
fi

say "3. needs: each traced service refused alone"
for action in $ACTIONS; do
  eval "worked=\$control_$action traced=\$traced_$action"
  if [ "$worked" != "yes" ]; then
    echo "  $action did not work bare; refusing its services one at a time would show nothing"
    continue
  fi
  if [ "$traced" != "yes" ]; then
    row "needs	$action	nothing to refuse: it works bare and stops under a profile that allows everything, so being sandboxed at all is what refuses it"
    continue
  fi
  while read -r operation target <&3; do
    [ -n "$target" ] || continue
    case $operation in
      mach-lookup) rule="(deny mach-lookup (global-name \"$target\"))" ;;
      *) rule="(deny iokit-open (iokit-user-client-class \"$target\"))" ;;
    esac
    measured "$action" "(version 1)(allow default)$rule"
    if [ "$measured_effect" = "no" ]; then row "needs	$action	$operation $target	$measured_out"; else echo "  $action works without $operation $target"; fi
  done 3< "$work/trace/$action.txt"
done

say "3b. accessibility: which kind of rule it stops at"
# Accessibility looks its service up in the other application's namespace, so the rule of step 3
# (a global name) does not stop it and a local name does. Measured 2026-11-19: of twenty kinds of
# operation refused whole, only Mach lookups stopped it.
if [ "${control_ax:-no}" = "yes" ]; then
  while read -r rule <&3; do
    [ -n "$rule" ] || continue
    if ! /usr/bin/sandbox-exec -p "(version 1)(allow default)$rule" /usr/bin/true 2> /dev/null; then
      echo "  this macOS does not understand $rule (or nothing starts under it)"
      continue
    fi
    measured ax "(version 1)(allow default)$rule"
    row "ax-under	$rule	$measured_out"
  done 3<< 'RULES'
(deny mach-lookup (global-name "com.apple.axserver"))
(deny mach-lookup (local-name "com.apple.axserver"))
(deny mach-lookup)
RULES
fi

say "4. wall: the daemon's own profile, screen closed and screen open"
port=3128
box="$work/box"
mkdir -p "$box"
closed=$(cd "$repo" && node --experimental-transform-types "$here/profile.ts" "$box" "$port" closed profile) || exit 1
open=$(cd "$repo" && node --experimental-transform-types "$here/profile.ts" "$box" "$port" open profile) || exit 1
echo "closed profile: $closed"
echo "open profile: $open"
# The probe has to be somewhere the box may read and run it; outputs go where it may write.
work_before=$work
mkdir -p "$box/bin" "$box/out"
cp "$work"/bin/probe "$work"/bin/screencapture-copy "$work"/bin/osascript-copy "$box/bin/"
work=$box
probe="$box/bin/probe"
failures=0
for action in $ACTIONS; do
  eval "worked=\$control_$action"
  measured "$action" "$closed"
  row "closed	$action	$measured_out"
  measured "$action" "$open"
  row "open	$action	$measured_out"
  if [ "$measured_effect" = "yes" ]; then
    verdict="THROUGH"
    failures=$((failures + 1))
  elif [ "$worked" = "yes" ]; then
    verdict="refused"
  else
    verdict="unproven (did not work bare either: this session lacks what it needs)"
  fi
  row "verdict	$action	$verdict"
done
work=$work_before

say "4b. ordinary commands, screen closed and screen open"
if bash "$here/ordinary.sh" "$box" | tee -a "$results"; then :; else failures=$((failures + 1)); fi

say "result"
grep -E '^(control|needs|ax-under|verdict|ordinary-verdict)	' "$results"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### screen wall on $(sw_vers -productVersion) ($(uname -m))"
    echo '```'
    cat "$work/state.txt"
    grep -E '^(control|needs|ax-under|verdict|ordinary-verdict)	' "$results"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
input_proven=0
for action in $INPUT_ACTIONS; do
  eval "worked=\$control_$action"
  [ "$worked" = "yes" ] && input_proven=$((input_proven + 1))
done
if [ "$input_proven" = "0" ]; then
  echo "screen-wall: no way of posting input worked bare here, so nothing above shows input is refused" >&2
  failures=$((failures + 1))
fi
echo "screen-wall: $failures failure(s)"
[ "$failures" = "0" ]
