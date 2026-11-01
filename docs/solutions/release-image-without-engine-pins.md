---
module: release
tags: [build, docker, engines]
problem_type: best-practice
found: 2026-10-30, INV-1441 (0.3.7)
---
# A box image built without the engine version pins ships without engines, and both gates pass it

**Symptom.** A released box has no `claude` / `opencode` / `pi` inside; `npm run smoke` and `release:check` were green.

**Cause.** `build:image` reads `OPENCODE_VERSION` / `CLAUDE_CODE_VERSION` / `PI_VERSION` from the environment; absent, the Dockerfile stages that install them are skipped, and neither gate asserts an engine is present.

**Fix.** Pin the versions in the release environment (the release runbook, docs/27) and let the engine check fail the build when a pin is missing. Verify the artifact, not the build.

**Verify.** `docker run --rm <image> sh -c 'which claude opencode pi'` lists all three before pushing.
