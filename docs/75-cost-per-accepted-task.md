<!-- doc: 75-cost-per-accepted-task
     title: Cost per accepted task requires an auditable denominator
     family: decision
     status: current
     updated: 2026-09-29
-->
# 75. Cost per accepted task requires an auditable denominator

**Decision, 2026-09-29 (INV-872).** Do not infer a cost saving from fewer tokens, a
higher cache-read share, fewer exposed tools, or a task board entry marked `done`.
No tool-trimming or model-routing default changes on this evidence. The available
real-task sample had no sufficiently evidenced requester or reviewer acceptance;
the cost-per-accepted-task result is **INCOMPLETE**, not zero. The replayable,
private-window study and its anonymized fixtures remain in the ignored local
`research/` directory, with a pointer on INV-872; they are not product data or
material to copy into the repository.

The existing `usage.ts` ledger identifies calls and stable work across retries.
`spend.ts` prices the four input/output/cache classes using configured rates,
but a retained feed cannot reconstruct calls it has lost. `tasks.ts` may close
one-shot work without external review, and task history is bounded. These facts
make a `done` count or a partial bill an unsafe denominator or numerator.

For any future paired optimization, first select a fixed window and a fixed
set of task inputs with an acceptance source independent of the executor.
Count the full price-weighted spend for *all* selected tasks, including failed,
partial and recovery attempts, in the numerator; count only externally
accepted completions in the denominator. Report coverage, missing usage,
unpriced models or token classes, ambiguous work joins and expired history
separately. Withhold the ratio if any selected task is not costable. A prompt
segment hash shows what changed; it does **not** assign cached or uncached
tokens to that segment. A deterministic scripted scenario is a regression
check, not a real-model cost or quality measurement.

The quality gate is the outcome: compare the same tasks, model, prompt,
price table and initial state, with external verification or blind review.
Until such a paired cohort exists, the answer to whether a proposed
optimization is cheaper per accepted task is **unknown**. This decision
does not add another billing ledger, change default models or grant new tools.
