---
module: release
tags: [macos, notarization, gatekeeper]
problem_type: best-practice
found: 2026-10-31, INV-1450
---
# `dist:mac` without the Apple credentials ships a package Gatekeeper refuses on a fresh Mac

**Symptom.** The DMG opens on the build machine and is refused ("cannot be opened because the developer cannot be verified") on a new user's Mac.

**Cause.** Signing and notarization need `APPLE_*` / an App Store Connect key in the environment; absent, the build signs ad hoc and never submits, and nothing said so (all releases through 0.3.8).

**Fix.** `scripts/dist.mjs` submits with `notarytool` and staples when credentials are present and prints `NOT NOTARIZED` otherwise; `release:check` refuses an unnotarized package unless `RELEASE_CHECK_SKIP_NOTARIZE=1`; the onboarding acceptance needs `--allow-unnotarized` to accept one.

**Verify.** `spctl -a -vv -t install <dmg>` says `accepted` and `stapler validate` passes on a machine that never built it.
