# Jev synthetic smoke — 2026-09-22

Research evidence for INV-600 and [docs/63](../../../docs/63-jev-integration-research.md).
No product integration is enabled by these files.

- `provenance.json`: local baseline, fixed upstream source commits, installed skill digest.
- `synthetic-cases.json`: 12 authored examples with expected labels, not production data.
- `synthetic-results.json`: the original 36 API observations, usage, and measured request latency.
- `smoke.mjs`: standalone Node runner. No dependency installation required.

Run without network:

```sh
node scripts/research/jev-2026-09-22/smoke.mjs
```

Explicit live rerun (overwrites the result file; consumes API tokens):

```sh
node scripts/research/jev-2026-09-22/smoke.mjs --live
```

Reads `TYPESAFE_API_KEY` or the existing `TYPESAFE_TOKEN` alias in memory.
Never put the value in a command argument, report, or repository file.
Missing credentials skip the live call. All examples are synthetic; the runner
does not load private memory, transcripts, or audit data.

Model `jev-1.13.0`, three repetitions, sequential requests, no retries, 10-second
hard timeout. The 0.5 split is only a descriptive comparison with the author's
expected labels. This is not threshold calibration, a held-out evaluation,
an end-to-end benchmark, or INV-600's 50-real-command acceptance test.

## Round 2: actual memory selection path

See [docs/64](../../../docs/64-jev-memory-evaluation.md).

- `memory-eval.mjs`: compares real scored recall, candidate-limited oracle,
  and Jev Noul/Score promotion using 20 existing synthetic fixtures plus 6 stress cases.
- `memory-results.json`: 108 recorded API responses, 966 questions, three repetitions,
  per-case final recall and source/request hashes. No private memories or transcripts.
- `audit-inventory.json`: aggregate counts from one local host policy log; no command bodies.
- `round2-validation.json`: local checks and remaining acceptance limits.

Default execution makes no network calls. `--replay` verifies stored responses against
the current request hashes and final recall. `--live` consumes API tokens and overwrites
`memory-results.json`. Run with `node --experimental-transform-types` because the harness
imports existing TypeScript functions directly.

The prompt-to-ID bridge exists only in this research harness to preserve current
consumer behavior. It is not a production integration. Required-recall gains compare
with deterministic fallback, not the current generative LLM selector. A model's
non-selection is not a guarantee that existing recall omits the record from the body
or index. Four wrong-box cases remain in the existing hermetic registry tests.

## Round 3: all-category opportunities and Jev role review

See [docs/66](../../../docs/66-awesome-jev-lumenbox-opportunities.md).

- `awesome-projects.json`: complete CC0 public catalog at
  `hellogumbo/awesome-jev@e2014cdb35d7d699795c8ca28904e8f42568bf45` (905 entries,
  11 categories). This is metadata coverage, not 905 complete source audits.
- `awesome-source-review.json`: 17 additional representative repositories with
  fixed commits and hashes of selected source/documentation inspected this round;
  catalog-only examples are distinguished from source reviews.
- `awesome-cua-probe.json`: rerun of the existing isolated CUA control-flow probe
  at the recorded LumenBox HEAD. Native I/O is fake; no real GUI was driven.
- `round3-validation.json`: local validation and limitations.

This round performs no new live model evaluation, installs no upstream drivers,
changes no product behavior, and leaves the Jev role template as found. The report
maps business templates as well as host/CUA seams and specifies provider-neutral
contracts, default-off switches, stable A/B assignments, and independent outcomes.

## Round 4: business judgment pilot

See [docs/67](../../../docs/67-jev-business-pilot.md) and [business/README.md](business/README.md).
The isolated harness compares Jev with a real discrete-label DeepSeek baseline on
public citation/catalog material and fictional leads. It records 84 initial calls
plus 6 separately frozen post-hoc input probes, along with replay and limitations.
No production features or online A/B are enabled.
