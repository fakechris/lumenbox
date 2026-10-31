<!-- doc: 27-testing-and-release
     title: Testing and release stability: ours, against OpenClaw and Hermes
     family: spec
     status: current
     domain: testing-and-release
     updated: 2026-10-26
-->
# Testing and release stability: ours, against OpenClaw and Hermes

Status: **written 2026-09-01**, after the owner asked how mature products build
their test data and mocks, and what guarantees a release. Both references were
read at source: OpenClaw (`~/source/claw/openclaw`, 1,799 test files, five
vitest configs) and Hermes (`~/sdcard/source/hermes-agent`, 3,297 pytest files
plus ~916 vitest). What follows is what they do, what we do, and the five things
that changed today because the comparison found them.

## What the audit cost us to learn — three live defects, found by building the checks

**1. Our test suite was writing into the live installation.** The orchestrator
opens its usage ledger off `agentboxHome()`, so `resume-integration.test.ts` had
been appending to the real `~/.agentbox/usage.jsonl` on every run — a person's
spend record, polluted by tests, silently. `resume.ts` already carried the scar
of this class ("how a sibling of this file wrote into a developer's home
directory from a test that had asked for no file at all"); the class was never
closed. Now `agentboxHome()` **refuses its default under `AGENTBOX_TEST=1`**.

**2. A test passed only because of a credential in the developer's shell.**
`compaction.test.ts`'s summary-routing test minted a client for a second wire
using whatever `MINIMAX_CODE_CN_API_KEY` happened to be exported. It would have
failed on any machine without the key. Now it sets its own fake one.

**3. The packaged CLI was broken on main, and every check was green.** The
catalog reads persona files from disk relative to its module; esbuild bundles
code, not data, so `dist/cli.js --help` died on `ENOENT … dist/catalog-data/experts/lin.md`
— for a day, since PR #14. `npm run build` exited zero the whole time, because
"the bundler was happy" and "the artifact runs" are different claims.

**And a fourth, from looking rather than building: CI had been red on `main` for
at least five consecutive pushes** (lint), and nobody — me included — had looked.
A gate whose failures nobody reads is not a gate.

## How the three of us build test data

| | Ours (before → after) | OpenClaw | Hermes |
| --- | --- | --- | --- |
| Runner | `node --test`, one flat run → **hermetic runner with an env allowlist** | vitest, 5 configs, custom parallel runner with per-file quarantine lanes | pytest via a custom runner, **`env -i` allowlist**, per-file subprocess isolation |
| Tiers | none → still none (open) | unit / gateway / extensions / e2e / live, split by *blast radius* not by style | unit / integration (marker-excluded by default) / e2e / docker / OS-specific / live |
| Vendor payload fixtures | a handful inlined as real captured strings (`meet_number`) | **none** — every payload is a developer's mental model | **none** meaningful (one normalized MCP `tools/list`) |
| Model fake | **one `fakeModel`, in `src/host/testing/`** — every site converted | one behavioural simulator swapping `fetch` (`test-helpers.openai-mock.ts`), used by one file | 72 files each redefining their own `_FakeOpenAI`; the one real fake is a **984-line OpenAI-compatible mock server** in the desktop e2e |
| Snapshots | none | **zero, deliberately** — replaced by committed-artifact diffs | **zero** — replaced by generated golden vectors with provenance stamps |
| Credential isolation | none → **allowlist strips everything unnamed** | deletes vendor tokens in setup, inverts for live runs | deletes 16 suffix patterns + ~110 names; import-time home sandbox |
| Network guard | **loopback only; anything else throws where it was called** | none — compensated by 46 `process.env.VITEST` branches in production code | none global; one package-scoped socket guard that asserts zero attempts at teardown |
| Live tier | none (open) | 13 files, gated on **flag AND credential** so a missing key skips rather than fails | 3 files + a branch-prefix Windows lane; **CI never holds a model key** |

Two things both mature repos do that are worth more than their size suggests:

**A shared contract assertion per pluggable interface.** OpenClaw's
`test/helpers/inbound-contract.ts` is twelve lines applied across six channel
adapters — adding a channel that does not satisfy it fails. It encodes the
invariant rather than the output, which is why it survives refactors that would
break any snapshot.

**Generated goldens with provenance and an `expect` field.** Hermes generates
`tests/conformance/vectors/*.json` through the real renderers, stamps the
generator commit into the file, and has a test that regenerates into a tmpdir and
diffs — failing with the exact regeneration command. Each vector declares
`parity | semantic | divergent`, so *intentional* divergence is data rather than
a red test.

Two things neither does, and we should not copy the absence of: **recorded
vendor payloads**. Both compensate with a live tier run against real credentials
by a maintainer. We have real credentials and a live installation on this
machine — which is exactly why our tests must not see them, and why a small
captured-payload corpus is the cheaper insurance for us than a live tier.

## What guards a release

The order a release goes out in, mechanical since INV-858 (2026-09-29, after 0.3.0 shipped
installers with three packages in node_modules and every new user's first launch died):

1. **Build and push the image first**: `npm run build:image`, then `npm run push:image`
   (needs `docker login`), publishing `fakechris/lumenbox:<version>` and `:latest`.
   The app pins its pull at the package version — an app published before its tag
   exists breaks every fresh install of that version on the first start.
2. **`npm run release:check`**, which now also refuses to bless a release whose packaged
   zips do not carry the full production dependency closure, whose dmg is missing beside a
   zip, or whose image tag is absent from Docker Hub (skippable with
   `RELEASE_CHECK_SKIP_IMAGE=1`, which CI sets — the gate belongs to the publishing machine).
3. **Build the app** (`npm run dist:mac`, …), and upload only artifacts the check above
   saw. Overriding `AGENTBOX_DIST_DIR` points the check at a candidate directory. The
   dist scripts stamp the short commit into the packaged `package.json` (`buildCommit`),
   which is the version line's only source on a machine with no `.git` (INV-876).
   **Notarized, with `APPLE_KEYCHAIN_PROFILE=lumenbox` set** (INV-1450): electron-builder
   notarizes and staples each `.app`, and `scripts/dist.mjs` submits each signed dmg to the
   notary service and staples it. Without credentials the build still succeeds and prints
   `NOT NOTARIZED` before and after — every release through 0.3.8 went out that way, and a
   browser download was blocked on first open. Then run `release:check` again: it refuses an
   app or dmg that `stapler validate` and `spctl --assess` do not pass
   (`RELEASE_CHECK_SKIP_NOTARIZE=1` for a build that will not be published). Make
   `SHA256SUMS` only after this; stapling changes the dmg.
   One-time setup on the publishing Mac: an App Store Connect API key (Developer role, team
   A69VRB2X6U), its `.p8` kept outside the repository, stored once with
   `xcrun notarytool store-credentials lumenbox --key <AuthKey_ID.p8> --key-id <ID> --issuer <issuer>`.
   The secret then lives in the keychain; nothing in the repository or the build log names it.
4. **After publishing, a new user's first run on another Mac** (INV-1447):
   `scripts/onboarding-e2e.mjs` downloads the published DMG, checks it against SHA256SUMS,
   and walks no-Docker guidance → key in Settings → Start the box (a real first pull) →
   green dot → first reply, isolated from whatever already runs there. Runbook:
   [86](86-onboarding-acceptance.md).

| | Ours (after today) | OpenClaw | Hermes |
| --- | --- | --- | --- |
| CI gate | typecheck, lint, test-floor, build, **release-check** | typecheck/lint/tests; `release-check` **push-only, never on PRs** | 16-workflow aggregator, fail-open change classifier, SHA-pinned actions |
| Artifact check | **the built CLI is launched and must print usage**; no build-machine paths in the daemon bundle; base image digest-pinned *and* dependabot present; **packaged zips carry the full prod dependency closure, a dmg beside every zip, and the image tag live on Docker Hub** (INV-858) | `npm pack` contents asserted; the only real launch check is `openclaw --version` inside the built image | post-build smoke = 25 docker tests against the loaded image |
| Suite-shrink guard | floor 200 → **975, and staleness now reports itself every run** | none | structural: OS-marker lanes fail on "no tests collected" |
| Release script | none (open) | version alignment, appcast floors, pack contents — and **the gate itself is unit-tested** | a changelog formatter that gates on nothing |
| Self-heal | `agentbox box doctor` exists, not wired to updates | `doctor --non-interactive --fix` runs **automatically after every update** | `hermes doctor` / `hermes verify`, manual |

## What changed today

- `scripts/test-env.mjs` — an allowlisted environment for test runs (`TZ=UTC`,
  no credentials, `AGENTBOX_TEST=1`). `npm test` and CI both go through it.
- `agentboxHome()` refuses its default under test, naming the fix.
- `scripts/release-check.mjs` — launches the built CLI, refuses build-machine
  paths in the daemon bundle, and requires the base image to be digest-pinned
  **with dependabot watching it**, because a pin nobody moves is a CVE that ages.
- `scripts/copy-catalog-data.mjs` — runtime data ships beside the bundle that
  reads it, for both `dist/` and the image.
- The test floor is 986 and complains when it goes stale.
- CI is green again, and now runs the release check.
- `src/channels/fixtures/feishu-messages.json` + `feishu-corpus.test.ts` — 27 real
  shapes (INV-128, 2026-10-25; seven before), captured from the operator's tenant and
  sanitised, each with provenance and the outcome the receiver owes it; driven through the
  real receiver (`receiverFor`) with no credentials or network. `feishu-negatives.json`
  holds six synthetic refusals, labelled synthetic. Mutation-checked: flattening `post`
  content turns it red. Known gap: the corpus is the API-history shape (`mentions[].id` a
  string where the live event nests `open_id`); the test maps that one field.
- `scripts/public-content.mjs` (INV-1381) — every markdown file under docs/ plus README and
  AGENTS fails the suite on a local home directory, a tailnet or LAN address, a `*.ts.net`
  name, a non-placeholder email, or an internal host name listed (as a SHA-256 hash) in
  `scripts/public-content.json`. Ticket ids stay allowed. The first run cleaned twelve docs;
  git history still holds the old text.
- `scripts/test-network-guard.mjs` — loopback only, everything else throws where
  it was called. The suite passes under it, which is the evidence that nothing
  was quietly reaching a vendor.
- `src/host/test-guards.test.ts` — the guards have their own tests, which double
  as proof the runner was used: run the suite the wrong way and they fail. The
  `test:raw` bypass is gone for the same reason.
- `src/host/testing/fake-model.ts` — one programmable stand-in for the client,
  replacing thirteen ad-hoc ones. It answers each call exactly once (a `respond`
  with side effects fired twice under the first draft), and knows the three
  surfaces the code actually uses: `stream`, `create` — the summariser's path —
  and raw stream events.

## Open, ranked

1. **A captured-payload corpus — Feishu done, DingTalk open.** 27 real Feishu shapes are
   in (INV-128). DingTalk has no history API a script can read; its stream events have to
   be recorded as they arrive, and none have been. Until an operator records a day of
   DingTalk traffic the DingTalk parsers stay pinned by hand-written literals and the
   adapter contract only. Still missing on the Feishu side: a `video_chat` message, a
   `share_chat`/`merge_forward`, and a live-event capture to replace the API shape.
2. **A contract assertion per adapter**, in OpenClaw's shape — one function every
   channel's tests must satisfy.
3. **Tiering and a live tier** — only once there is something a live run protects
   that the smoke suite does not. One live run now exists: `scripts/preset-matrix.mjs`
   (docs/84, INV-1359) runs every Delegate preset × configured provider × five scenarios
   against a dedicated box and writes a dated table; run it before a release that touches
   the presets, the relay, or the image's engines. Its first run found the image's
   root-owned npm cache (fixed, guarded by `release-check`).

## The network is denied twice (INV-1238, 2026-10-20)

`npm test` keeps a test off the network in two layers, and says which are in force on its
first line:

- **In the process**, `scripts/test-network-guard.mjs` refuses `fetch`, `http`/`https`,
  `net.connect` / `createConnection` / `Socket.connect` and `tls.connect` to anything but
  loopback and Unix sockets, naming the target in the error (`BlockedByTestGuard`). The patched
  builtins are synced to their ESM bindings, so `import { connect } from "node:net"` is caught
  too.
- **At the operating system**, `scripts/test-floor.mjs` runs the whole suite under macOS
  `sandbox-exec` (`deny network-outbound`, loopback and Unix sockets allowed) or a Linux network
  namespace (`unshare -rn`, only `lo` up). A `curl` or `git fetch` a test spawns fails there;
  `src/host/test-guards.test.ts` spawns one to prove it. Where neither is usable the runner prints
  `network: NOT denied by the OS — <why>` and goes on with the in-process layer alone; the
  self-test then reports the gap instead of asserting the deny. `AGENTBOX_TEST_NO_SANDBOX=1`
  switches the OS layer off on purpose. CI (Linux) has it on.

