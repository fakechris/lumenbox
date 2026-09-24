# Business judgment pilot — INV-600

See [docs/67](../../../../docs/67-jev-business-pilot.md). Research only; no product integration.

The frozen pilot contains public source excerpts, public catalog descriptions and
fictional lead messages. Labels were authored before calls, not independently
adjudicated. The report preserves disputed labels and post-hoc diagnostics.

- `fixtures.json`, `frozen-contract.json`: immutable original inputs, labels and
  per-packet common request hashes. Expected labels never enter requests.
- `observations.jsonl`: 84 real API-call observations, 42 per provider.
- `results.json`: deterministic replay result including the deliberately simple baseline.
- `diagnostic/`: 6 additional calls testing source/lead input clarification, separate
  from the original scores. These are post-hoc probes, not held-out evaluations.
- `validation.json`: verification results and artifact hashes.

```sh
node scripts/research/jev-2026-09-22/business/evaluate.mjs
node scripts/research/jev-2026-09-22/business/evaluate.mjs --self-check
node scripts/research/jev-2026-09-22/business/evaluate.mjs --replay
node scripts/research/jev-2026-09-22/business/evaluate.mjs --diagnostic --replay
```

All commands above are offline. The default is off. The recorded live runs used
`--freeze` then `--live`, with credentials read from `TYPESAFE_API_KEY` /
`TYPESAFE_TOKEN` and `DEEPSEEK_API_KEY` only in memory. Live execution consumes tokens;
existing observation/result files cause it to refuse overwriting the record.
Do not remove the frozen evidence to run another experiment: version new work separately.

Jev is pinned to `jev-1.13.0`. DeepSeek `deepseek-flash` is a mutable alias; the
response did not reveal a more specific weight version. It returns discrete labels,
not invented calibrated probabilities. Both receive the same common state/questions,
but provider wire formats and tokenizers differ. Single pass, concurrency two,
zero retries, 20-second request timeout. Latency is per API call, not product latency.

In the current fixture precheck, `fabricated` means a deliberately planted quote
was absent from the supplied excerpt. Do not reuse that label as a production claim
that a quote is absent from an entire source; use completeness and location states.
The sales intent taxonomy also does not separately preserve research-only plus
do-not-contact: the report identifies this as a prerequisite before product use.

The runner never sends messages, modifies business records, clicks a GUI, or calls
LumenBox product tools. Proposed lead actions are drafts/review only.
