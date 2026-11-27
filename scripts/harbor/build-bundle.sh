#!/bin/bash
# Bundle the LumenBox CLI and box daemon from this checkout into <eval-clone>/lumenbox/lbx.tgz,
# the file scripts/harbor/mini-suite.json uploads into each task container (docs/105).
# Usage: scripts/harbor/build-bundle.sh <path to a frontier-harness-eval/eval clone>
set -euo pipefail
EVAL=${1:?path to the eval clone}; SRC=$(cd "$(dirname "$0")/../.." && pwd); T=$(mktemp -d)
mkdir -p "$EVAL/lumenbox"; OUT=$(cd "$EVAL/lumenbox" && pwd)
cd "$SRC"
./node_modules/.bin/esbuild src/cli.ts --bundle --platform=node --target=node22 --format=esm --outfile=$T/cli.mjs \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" --log-level=warning
./node_modules/.bin/esbuild src/boxd/main.ts --bundle --platform=node --target=node22 --format=cjs --outfile=$T/boxd.cjs --log-level=warning
cp -R src/host/catalog-data $T/
git rev-parse --short HEAD > $T/COMMIT
tar -czf "$OUT/lbx.tgz" -C $T . && rm -rf $T
echo "bundle $(tar -xOzf "$OUT/lbx.tgz" ./COMMIT) -> $OUT/lbx.tgz (set the lumenbox agent's version to it in the suite)"
