/**
 * The release scorecard (INV-130): one record per build that says what was checked,
 * against what, and whether it may ship — with the three kinds of evidence kept apart.
 *
 *   - **deterministic**: `npm test` (hermetic: no network, no credentials, no live home).
 *     A failure here is a hard gate.
 *   - **artifact**: `scripts/release-check.mjs` — the built bundles load and are pinned.
 *     Also a hard gate.
 *   - **model**: `npm run scenario` against the real provider, opt-in, costs money. Not
 *     run means SKIPPED, never PASS; run and worse than the baseline means REVIEW, never
 *     an automatic pass — a named person accepts a regression or the build waits.
 *
 * A baseline is comparable only when it was produced by the same provider, model and
 * fixture version; otherwise the comparison is refused and said, because a scorecard
 * that compares two different models and calls the difference a regression teaches
 * people to ignore it.
 *
 * Four verdicts, four exit codes: PASS 0, FAIL 1, INCOMPLETE 2, REVIEW 3.
 */

export interface ScenarioRun {
  scenario: string;
  run: number;
  seconds: number;
  checks?: Record<string, boolean>;
  failure?: string;
}

export interface ModelSection {
  status: "ran" | "skipped";
  reason?: string;
  provider?: string;
  model?: string;
  /** A hash of the scenario definitions, so two runs are known to have asked the same questions. */
  fixtureVersion?: string;
  runs?: number;
  results?: ScenarioRun[];
}

export interface ScorecardInput {
  commit: string;
  dirty: boolean;
  node: string;
  builtAt?: string;
  startedAt: string;
  endedAt: string;
  deterministic: { status: "pass" | "fail" | "skipped"; pass?: number; fail?: number; floor?: number; note?: string };
  artifact: { status: "pass" | "fail" | "skipped"; failures?: string[]; note?: string };
  model: ModelSection;
  baseline?: { commit?: string; model: ModelSection };
  /** `scenario/check` pairs a named reviewer has accepted as known regressions. */
  acceptedRegressions?: { key: string; by: string; why?: string }[];
  /** A deliberate failure, so the gate can be shown to close (INV-130 A3). */
  injectFailure?: boolean;
  knownLimitations?: string[];
}

export type Verdict = "PASS" | "FAIL" | "INCOMPLETE" | "REVIEW";

export interface ComparisonRow {
  key: string;
  baseline: number;
  now: number;
  delta: number;
  regressed: boolean;
  accepted?: string;
}

export interface Scorecard extends ScorecardInput {
  format: "lumenbox-scorecard/1";
  verdict: { status: Verdict; reasons: string[] };
  comparison?: { comparable: boolean; why?: string; rows: ComparisonRow[] };
}

/** Pass rate per `scenario/check`, over the runs that produced a scorecard at all. */
export function passRates(results: readonly ScenarioRun[]): Map<string, number> {
  const seen = new Map<string, { pass: number; total: number }>();
  for (const run of results) {
    if (run.checks === undefined) continue;
    for (const [check, ok] of Object.entries(run.checks)) {
      const key = `${run.scenario}/${check}`;
      const cell = seen.get(key) ?? { pass: 0, total: 0 };
      cell.total += 1;
      if (ok) cell.pass += 1;
      seen.set(key, cell);
    }
  }
  return new Map([...seen].map(([key, cell]) => [key, cell.total === 0 ? 0 : cell.pass / cell.total]));
}

export function compareModelSections(
  now: ModelSection,
  baseline: ModelSection,
  accepted: readonly { key: string; by: string }[] = []
): NonNullable<Scorecard["comparison"]> {
  if (now.status !== "ran" || baseline.status !== "ran") {
    return { comparable: false, why: "one side has no model results", rows: [] };
  }
  const differs = (["provider", "model", "fixtureVersion"] as const).filter(field => now[field] !== baseline[field]);
  if (differs.length > 0) {
    return { comparable: false, why: `the baseline differs in ${differs.join(", ")}: not comparable`, rows: [] };
  }
  const before = passRates(baseline.results ?? []);
  const after = passRates(now.results ?? []);
  const rows: ComparisonRow[] = [];
  for (const [key, rate] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    const acceptedBy = accepted.find(entry => entry.key === key)?.by;
    rows.push({ key, baseline: was, now: rate, delta: rate - was, regressed: rate < was, ...(acceptedBy !== undefined ? { accepted: acceptedBy } : {}) });
  }
  return { comparable: true, rows };
}

export function buildScorecard(input: ScorecardInput): Scorecard {
  const reasons: string[] = [];
  let status: Verdict = "PASS";
  const fail = (why: string) => {
    status = "FAIL";
    reasons.push(why);
  };
  const soften = (to: Verdict, why: string) => {
    if (status === "FAIL") return;
    if (status === "PASS" || (status === "INCOMPLETE" && to === "REVIEW")) status = to;
    reasons.push(why);
  };

  if (input.injectFailure) fail("a failure was injected on purpose; this scorecard proves the gate closes");
  if (input.deterministic.status === "fail") fail(`deterministic tests failed: ${input.deterministic.fail ?? "?"} failing`);
  if (input.artifact.status === "fail") fail(`artifact checks failed: ${(input.artifact.failures ?? []).join(", ") || "unspecified"}`);
  if (input.deterministic.status === "skipped") soften("INCOMPLETE", `deterministic tests were not run (${input.deterministic.note ?? "no reason given"})`);
  if (input.artifact.status === "skipped") soften("INCOMPLETE", `artifact checks were not run (${input.artifact.note ?? "no reason given"})`);
  if (input.model.status === "skipped") soften("INCOMPLETE", `model scenarios SKIPPED: ${input.model.reason ?? "not run"}`);

  let comparison: Scorecard["comparison"];
  if (input.baseline !== undefined) {
    comparison = compareModelSections(input.model, input.baseline.model, input.acceptedRegressions ?? []);
    if (!comparison.comparable) {
      soften("INCOMPLETE", `no comparison: ${comparison.why}`);
    } else {
      const regressed = comparison.rows.filter(row => row.regressed && row.accepted === undefined);
      if (regressed.length > 0) {
        soften("REVIEW", `worse than the baseline on ${regressed.map(row => `${row.key} (${pct(row.baseline)} → ${pct(row.now)})`).join(", ")}; a named reviewer must accept or the build waits`);
      }
      for (const row of comparison.rows.filter(r => r.regressed && r.accepted !== undefined)) {
        reasons.push(`regression on ${row.key} accepted by ${row.accepted}`);
      }
    }
  } else if (input.model.status === "ran") {
    soften("INCOMPLETE", "model scenarios ran but there is no baseline to compare against");
  }
  if (input.dirty) reasons.push("the working tree was dirty: this commit id does not fully describe what was tested");

  return { format: "lumenbox-scorecard/1", ...input, verdict: { status, reasons }, ...(comparison !== undefined ? { comparison } : {}) };
}

const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

export function exitCodeFor(status: Verdict): 0 | 1 | 2 | 3 {
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : status === "INCOMPLETE" ? 2 : 3;
}

export function describeScorecard(card: Scorecard): string[] {
  const lines = [
    `Scorecard ${card.commit}${card.dirty ? " (dirty)" : ""} — ${card.verdict.status}`,
    `  node ${card.node}; ${card.startedAt} → ${card.endedAt}${card.builtAt !== undefined ? `; built ${card.builtAt}` : ""}`,
    `  deterministic: ${card.deterministic.status}${card.deterministic.pass !== undefined ? ` (${card.deterministic.pass} pass, ${card.deterministic.fail ?? 0} fail, floor ${card.deterministic.floor ?? "?"})` : ""}`,
    `  artifact: ${card.artifact.status}${(card.artifact.failures ?? []).length > 0 ? ` (${card.artifact.failures!.join(", ")})` : ""}`,
    `  model: ${card.model.status === "ran" ? `ran ${card.model.runs ?? "?"}×${new Set((card.model.results ?? []).map(r => r.scenario)).size} on ${card.model.provider ?? "?"} ${card.model.model ?? ""} (fixtures ${card.model.fixtureVersion ?? "?"})` : `SKIPPED — ${card.model.reason ?? "not run"}`}`,
  ];
  if (card.comparison !== undefined) {
    if (!card.comparison.comparable) lines.push(`  baseline: ${card.comparison.why}`);
    else {
      lines.push(`  baseline ${card.baseline?.commit ?? "?"}:`);
      for (const row of card.comparison.rows) {
        lines.push(`    ${row.regressed ? "▼" : row.delta > 0 ? "▲" : "="} ${row.key}: ${pct(row.baseline)} → ${pct(row.now)}${row.accepted !== undefined ? ` (accepted by ${row.accepted})` : ""}`);
      }
    }
  }
  for (const reason of card.verdict.reasons) lines.push(`  · ${reason}`);
  for (const limitation of card.knownLimitations ?? []) lines.push(`  known: ${limitation}`);
  return lines;
}
