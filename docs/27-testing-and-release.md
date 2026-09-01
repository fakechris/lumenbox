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
| Model fake | hand-rolled `as unknown as Anthropic` in 13 files | one behavioural simulator swapping `fetch` (`test-helpers.openai-mock.ts`), used by one file | 72 files each redefining their own `_FakeOpenAI`; the one real fake is a **984-line OpenAI-compatible mock server** in the desktop e2e |
| Snapshots | none | **zero, deliberately** — replaced by committed-artifact diffs | **zero** — replaced by generated golden vectors with provenance stamps |
| Credential isolation | none → **allowlist strips everything unnamed** | deletes vendor tokens in setup, inverts for live runs | deletes 16 suffix patterns + ~110 names; import-time home sandbox |
| Network guard | none (open) | none — compensated by 46 `process.env.VITEST` branches in production code | none global; one package-scoped socket guard that asserts zero attempts at teardown |
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

| | Ours (after today) | OpenClaw | Hermes |
| --- | --- | --- | --- |
| CI gate | typecheck, lint, test-floor, build, **release-check** | typecheck/lint/tests; `release-check` **push-only, never on PRs** | 16-workflow aggregator, fail-open change classifier, SHA-pinned actions |
| Artifact check | **the built CLI is launched and must print usage**; no build-machine paths in the daemon bundle; base image digest-pinned *and* dependabot present | `npm pack` contents asserted; the only real launch check is `openclaw --version` inside the built image | post-build smoke = 25 docker tests against the loaded image |
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
- The test floor is 975 and complains when it goes stale.
- CI is green again, and now runs the release check.

## Open, ranked

1. **A captured-payload corpus.** Twenty real Feishu/DingTalk event bodies,
   sanitised, checked in, with every parser run against all of them. This is the
   gap that keeps costing us: `meet_number`, `video_chat`, `thread_id` vs
   `root_id`, the `post` shape — each found in production, each pinned only where
   somebody happened to write a test afterwards.
2. **One fake model, shared.** Thirteen hand-rolled `as unknown as Anthropic`
   stubs are thirteen slightly different beliefs about the SDK. Hermes's desktop
   mock server is the shape worth copying: a real HTTP server, so the client, the
   SSE parser and the retry path are exercised rather than bypassed.
3. **A contract assertion per adapter**, in OpenClaw's shape — one function every
   channel's tests must satisfy.
4. **A network guard** that records attempts and fails the test that made one.
5. **Tiering and a live tier** — only once there is something a live run protects
   that the smoke suite does not.
