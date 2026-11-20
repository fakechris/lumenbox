---
module: box
tags: [docker, architecture, release]
problem_type: runtime-error
found: 2026-11-20, INV-1961 (0.4.5)
---
# A single-platform box image restart-loops on a different architecture

**Symptom.** On amd64, `fakechris/lumenbox:0.4.5` restarts with `exec /usr/local/bin/box-init: exec format error`.

**Cause.** The published image is linux/arm64 only. Docker can create its container on an amd64 engine, but cannot execute its entrypoint natively.

**Fix.** Before creating a box or its gate, compare the local image platform with the Docker server platform. Refuse known mismatches; unavailable inspections retain the previous behavior. From a checkout, run `npm run build:image` (requires the Go toolchain), then `agentbox box up --recreate`, or select a release image publishing the server's platform. A normal push publishes the locally built platform, not a multi-platform release.

**Verify.** Compare `docker image inspect --format '{{.Os}}/{{.Architecture}}' fakechris/lumenbox:0.4.5` with `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'`. On a mismatch, `agentbox box up` must refuse with both platforms and install instructions, leaving no new container in `docker ps -a`.
