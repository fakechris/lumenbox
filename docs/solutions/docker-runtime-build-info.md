---
module: release
tags: [build, docker, kubernetes]
problem_type: runtime-error
found: 2026-11-21
---
# The Docker host bundle needs package metadata beside it

**Symptom.** The Kubernetes control plane defaults new tenants to `fakechris/lumenbox:0.0.0`
and the tenant's `/api/state` reports version `0.0.0` with commit `unknown`.

**Cause.** The bundled CLI runs from `/opt/hostd` without the source checkout or its Git history.

**Fix.** Build the host with `npm run build:hostd` (part of both image build commands).
It stamps the package name, version and current commit into the package file copied beside
`/opt/hostd/hostd.mjs`. The default image and build info resolve that same package.

**Verify.** Run `node --test scripts/build-hostd.test.mjs` to boot the bundled CLI from an
isolated directory. For an image build, leave `AGENTBOX_IMAGE` unset, check the new tenant
Pod's image, and compare the tenant's `/api/state` build fields to the package version and Git commit.
