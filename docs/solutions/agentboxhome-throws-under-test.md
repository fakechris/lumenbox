---
module: host config
tags: [tests, hermetic, AGENTBOX_HOME]
problem_type: runtime-error
found: 2026-11-01, INV-1465
---
# `agentboxHome()` throws under `npm test`, so anything on the prompt-build path must tolerate having no home

**Symptom.** 150 tests fail at once after adding a read of `~/.agentbox/<something>` to prompt assembly; each failure is "no AGENTBOX_HOME" from somewhere unrelated.

**Cause.** The suite is hermetic: no live home, and `agentboxHome()` throws rather than defaulting, so a test never writes into the developer's real state. Any new code on a path every turn takes inherits that throw.

**Fix.** Read the home lazily and catch: `overridesDir()` in `prompt-parts.ts` returns `undefined` when there is no home, and "no overrides" is the answer. Never default to `~/.agentbox` yourself.

**Verify.** `npm test` green without `AGENTBOX_HOME`; the feature still reads the real directory when `agentbox web` runs.
