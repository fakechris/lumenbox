---
module: release
tags: [build, docker, feishu, markdown]
problem_type: runtime-error
found: 2026-11-23
---
# The standalone host bundle needs Node require and its browser asset

**Symptom.** Opening a Feishu door in bundled hostd fails with `Dynamic require of "util" is not supported`, and the UI cannot load `/vendor/markdown-it.js`.

**Cause.** The Feishu SDK is bundled as CommonJS inside an ES module, and the browser build of markdown-it is read from disk rather than bundled as JavaScript.

**Fix.** Give the ESM bundle Node's `require` and `__dirname` via `createRequire(import.meta.url)` and `import.meta.dirname`. Ship `markdown-it.js` beside `hostd.mjs`, where the web server can find it without `node_modules` or a vendor directory override.

**Verify.** Run `node --test scripts/build-hostd.test.mjs`. The smoke test checks the browser build served by the isolated bundle, then adds a Feishu door and verifies that its adapter initializes without live network access.
