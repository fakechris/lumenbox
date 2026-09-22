# Actual-report evidence audit — INV-600

See [docs/68](../../../../docs/68-jev-report-audit.md).

`claims.json` records ten purposively selected statements from the actual docs/66
report, with fixed upstream revisions, source excerpts, original locations and
scope notes. The same agent inspected them; these are not independent gold labels
or model predictions. Nonsemantic entries separately record a missing deployment
snapshot, a design proposal and the old excerpt-only `fabricated` label limitation.

`verify.mjs` checks the prior business-pilot artifact hashes, invokes its existing
offline replay, independently aggregates API observations and verifies catalog
counts and the audit's exact report locations. It never calls a model or product
tool. Source hashes were matched against the fixed upstream clones when the audit
was created; offline replay checks retained excerpts and provenance metadata, and
does not refetch upstream source or certify the semantic review.

```sh
node scripts/research/jev-2026-09-22/report-audit/verify.mjs
```

`verification.json` is the first recorded result. `validation.json` records this
round's repository checks and hashes. Old reports and frozen pilot files remain
unchanged. No live experiment or production A/B was activated.
