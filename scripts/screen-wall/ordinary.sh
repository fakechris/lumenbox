#!/bin/bash
# The other half of the screen wall (INV-1756): what the open-screen profile refuses must cost an
# ordinary command nothing. Each command here runs twice under the daemon's own Seatbelt profile
# (scripts/screen-wall/profile.ts) — screen closed, screen open — with the network reached the way
# a box reaches it, through one loopback port. A command that ran closed and not open is lost.
#
# This touches no screen: it posts nothing and captures nothing, so unlike `measure.sh` it may be
# run on any Mac, a person's own included.
#
#   bash scripts/screen-wall/ordinary.sh [work-dir]
#
# Exit 0 when nothing was lost. A command this machine does not have is "absent", not a failure.

set -u

if [ "$(uname)" != "Darwin" ]; then
  echo "screen-wall: macOS only" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
box=${1:-$(mktemp -d /tmp/screen-wall-ordinary.XXXXXX)}
mkdir -p "$box"
box=$(cd "$box" && pwd -P)

limit() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }

node "$here/proxy.mjs" > "$box/proxy.port" &
proxy=$!
trap 'kill $proxy 2>/dev/null' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$box/proxy.port" ] && break
  sleep 0.5
done
port=$(cat "$box/proxy.port")
closed=$(cd "$repo" && node --experimental-transform-types "$here/profile.ts" "$box" "$port" closed profile 2> /dev/null) || exit 1
open=$(cd "$repo" && node --experimental-transform-types "$here/profile.ts" "$box" "$port" open profile 2> /dev/null) || exit 1
(cd "$repo" && node --experimental-transform-types "$here/profile.ts" "$box" "$port" open env 2> /dev/null) > "$box/box.env" || exit 1
if [ "$closed" = "$open" ]; then
  echo "screen-wall: the open-screen profile is the closed one; there is nothing to compare" >&2
  exit 1
fi

cat > "$box/hello.c" << 'EOF'
#include <stdio.h>
int main(void) { puts("hello from c"); return 0; }
EOF
cat > "$box/hello.swift" << 'EOF'
import Foundation
print("hello from swift \(ProcessInfo.processInfo.processorCount > 0)")
EOF
cat > "$box/hello.go" << 'EOF'
package main

import "fmt"

func main() { fmt.Println("hello from go") }
EOF
cat > "$box/ordinary-commands.sh" << 'EOF'
set -e
cd "$BOX"
case $1 in
  curl) curl -fsS -o /dev/null -w '%{http_code}\n' https://example.com ;;
  git) rm -rf repo && git init -q repo && git -C repo -c user.name=probe -c user.email=probe@example.invalid commit -q --allow-empty -m one && git -C repo log --oneline | wc -l && git ls-remote https://github.com/actions/checkout HEAD | wc -l ;;
  node) node -e 'const { execFileSync } = require("node:child_process"); console.log(require("node:crypto").randomUUID().length, execFileSync(process.execPath, ["-p", "6*7"]).toString().trim())' ;;
  npm) npm view left-pad version ;;
  python3) python3 -c 'import multiprocessing as m, urllib.request as u
if __name__ == "__main__":
    print(sum(m.Pool(2).map(abs, [-1, -2])), u.urlopen("https://example.com").status)' ;;
  clang) clang -o hello-c hello.c && ./hello-c ;;
  swiftc) swiftc -module-cache-path "$BOX/.swift-modules" -o hello-swift hello.swift && ./hello-swift ;;
  go) go build -o hello-go hello.go && ./hello-go ;;
esac
EOF

lost=0
for command in curl git node npm python3 clang swiftc go; do
  if ! command -v "$command" > /dev/null 2>&1; then
    printf 'ordinary-verdict\t%s\tabsent on this machine\n' "$command"
    continue
  fi
  for screen in closed open; do
    if [ "$screen" = "closed" ]; then profile=$closed; else profile=$open; fi
    said=$(
      . "$box/box.env"
      export BOX="$box" https_proxy="http://127.0.0.1:$port" HTTPS_PROXY="http://127.0.0.1:$port" GOCACHE="$box/.go-cache" GOPATH="$box/.go" GOFLAGS=-mod=mod CLANG_MODULE_CACHE_PATH="$box/.clang-modules"
      limit 240 /usr/bin/sandbox-exec -p "$profile" /bin/bash "$box/ordinary-commands.sh" "$command" 2>&1
    )
    code=$?
    eval "exit_$screen=$code"
    printf 'ordinary\t%s\t%s\texit %s\t%s\n' "$command" "$screen" "$code" "$(printf '%s' "$said" | tr '\n\t' '  ' | cut -c1-300)"
  done
  if [ "$exit_closed" = "0" ] && [ "$exit_open" != "0" ]; then
    printf 'ordinary-verdict\t%s\tLOST to the open-screen profile\n' "$command"
    lost=$((lost + 1))
  elif [ "$exit_closed" != "0" ]; then
    printf 'ordinary-verdict\t%s\tunproven (does not run with the screen closed either)\n' "$command"
  else
    printf 'ordinary-verdict\t%s\tunchanged\n' "$command"
  fi
done
[ "$lost" = "0" ]
