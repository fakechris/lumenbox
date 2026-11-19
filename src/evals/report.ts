/**
 * The one page (INV-1772): `docs/evals/REPORT-<date>.md`.
 *
 * Four numbers, each beside what limits it: the pass rate with its interval, pass^k beside pass@k,
 * the comparison with the previous run, and the smallest difference this sample could show. Then
 * where the failures are, what it cost, and what was not measured.
 *
 * The page opens with a header that says whether a model was measured at all. A page printed from
 * the deterministic stand-in says so in its first line and in its title, and `docs-lint` refuses
 * one in `docs/evals/`: a number that measures nothing must not be found where results are kept.
 */

import type { EvalRun } from "./runner.ts";
import type { GroupRow, Summary } from "./summary.ts";

const pct = (value: number | undefined): string => (value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
const count = (value: number): string => Math.round(value).toLocaleString("en-US");

function groupTable(title: string, rows: readonly GroupRow[]): string[] {
  return [
    `| ${title} | tasks | attempts passed | every attempt passed |`,
    "|---|---|---|---|",
    ...rows.map(row => `| ${row.key} | ${row.tasks} | ${row.passed}/${row.attempts} | ${row.reliable}/${row.tasks} |`),
  ];
}

export function renderReport(run: EvalRun, summary: Summary, options: { name: string }): string {
  const models = Object.entries(run.models).map(([tier, model]) => `${tier}: ${model.provider} ${model.model}`).join("; ");
  const lines: string[] = [
    `<!-- eval-report: ${options.name}`,
    `     measured: ${run.fake ? "no — a deterministic stand-in answered; these numbers measure nothing" : "yes"}`,
    `     split: ${run.split}`,
    `     corpus: ${run.corpus.version}`,
    `     commit: ${run.commit}${run.dirty ? " (dirty)" : ""}`,
    `     models: ${models}`,
    "-->",
    `# Evaluation report ${run.at.slice(0, 10)}${run.fake ? " — NOT A MEASUREMENT (stand-in model)" : ""}`,
    "",
  ];
  if (run.fake) {
    lines.push("> No model was asked. A deterministic stand-in gave each task its gold answer or the wrong one, to exercise the runner, graders, cache and this page. Nothing below describes the product.", "");
  }
  lines.push(
    `${summary.tasks} tasks from the **${run.split}** split (corpus ${run.corpus.version}), ${run.k} attempts each, at commit ${run.commit}${run.dirty ? " with uncommitted changes" : ""}. ${models}.`,
    `Model calls: ${run.calls.made} made, ${run.calls.cached} answered from the cache.`,
    "",
    "## The four numbers",
    "",
    "| | | read it with |",
    "|---|---|---|",
    `| Pass rate | **${pct(summary.passRate?.estimate)}** | 95% interval ${pct(summary.passRate?.low)} – ${pct(summary.passRate?.high)} (bootstrap over tasks) |`,
    `| pass^${run.k} — a task passes every time | **${pct(summary.passHatK)}** | pass@${run.k} (at least once) ${pct(summary.passAtK)}; at most ${pct(summary.unreliableUpperBound)} of tasks are unreliable, at 95% |`,
  );
  const comparison = summary.comparison;
  if (comparison === undefined) lines.push("| Against the previous run | **no baseline** | the first run is the baseline for the next |");
  else if (!comparison.comparable) lines.push(`| Against the previous run | **not comparable** | ${comparison.why} |`);
  else {
    lines.push(
      `| Against ${comparison.baselineCommit} (${comparison.baselineAt.slice(0, 10)}) | **${comparison.verdict.replaceAll("_", " ")}** — ` +
        `${comparison.worse} worse (${pct(comparison.worseShare)}), ${comparison.better} better (${pct(comparison.betterShare)}) | ` +
        `${comparison.why}; McNemar over ${comparison.paired} paired tasks${comparison.dropped > 0 ? `, ${comparison.dropped} not paired (new or edited)` : ""} |`
    );
  }
  lines.push(
    `| Smallest detectable difference | **${pct(summary.detectableDifference)}** | ` +
      `a change in pass rate smaller than this would not be told from noise by two runs of ${summary.tasks} tasks (5% false alarms, caught 80% of the time) |`,
    "",
    `A task counts as passing in the comparison when every one of its ${run.k} attempts passed. ` +
      (summary.infra > 0 ? `${summary.infra} attempt(s) failed in the harness, not in the model: counted, never as passes.` : "No attempt failed in the harness."),
    "",
    "## Judges",
    "",
    "**Judge not calibrated — may not gate.** Every result on this page comes from code graders. No judge question was asked, and no judge has been " +
      "checked against a person's labels, so nothing here rests on a model's opinion and no judge verdict may gate a change.",
    "",
    "## Where the failures are",
    "",
    ...groupTable("failure type", summary.byFailureType),
    "",
    ...groupTable("subject", summary.bySubject),
    "",
    "## Cost",
    "",
  );
  const use = summary.cost.use;
  lines.push(
    `${count(use.calls)} model calls: ${count(use.inputTokens)} input, ${count(use.outputTokens)} output, ${count(use.cacheReadTokens)} cache-read and ` +
      `${count(use.cacheWriteTokens)} cache-write tokens, as each call reported them (cached calls keep what they first cost).`,
    run.fake
      ? "The token figures are the stand-in's fixed numbers and no price applies."
      : summary.cost.usd !== undefined
        ? `At the configured rates: $${summary.cost.usd.toFixed(2)} in all, **$${(summary.cost.usdPerPass ?? 0).toFixed(4)} per passed attempt**.`
        : `No price: ${summary.cost.unpriced.join(", ") || "the models"} ${summary.cost.unpriced.length === 1 ? "has" : "have"} no rate under \`rates\` in config.json.`,
    summary.cost.tokensPerPass !== undefined ? `Tokens per passed attempt: ${count(summary.cost.tokensPerPass)}.` : "No attempt passed, so there is no cost per pass.",
    "",
    "## What this does not say",
    "",
    "- This report gates nothing. A gate is set only after its detectable difference above is known to be smaller than the regression it is meant to stop.",
    "- The corpus holds what the repository already stated as a right answer. Replies a person corrected and tasks from an installation's own runs are not in it until a person adds them.",
    "- The interval is over tasks: more attempts at the same tasks narrow a task's own rate, not this interval.",
    "",
  );
  const failing = run.tasks.filter(task => task.attempts.some(attempt => !attempt.pass));
  if (failing.length > 0) {
    lines.push("## Tasks that did not pass every time", "", "| task | passed | first finding |", "|---|---|---|");
    for (const task of failing) {
      const bad = task.attempts.find(attempt => !attempt.pass)!;
      const finding = bad.infra !== undefined ? `harness: ${bad.infra}` : bad.graders.filter(grader => !grader.pass).map(grader => `${grader.name}${grader.detail !== undefined ? ` — ${grader.detail}` : ""}`).join("; ");
      lines.push(`| ${task.id} | ${task.attempts.filter(attempt => attempt.pass).length}/${task.attempts.length} | ${finding.replaceAll("|", "\\|").replace(/\s+/g, " ").slice(0, 200)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** One line per past run, oldest first: the trend a single report cannot show (INV-821). */
export function renderTrend(rows: readonly { run: EvalRun; summary: Summary }[]): string[] {
  return rows.map(({ run, summary }) =>
    `${run.at.slice(0, 16)}  ${run.commit.padEnd(9)} ${run.split.padEnd(4)} ${String(summary.tasks).padStart(3)}×${run.k}  ` +
    `pass ${pct(summary.passRate?.estimate).padStart(6)} [${pct(summary.passRate?.low)} – ${pct(summary.passRate?.high)}]  ` +
    `pass^${run.k} ${pct(summary.passHatK).padStart(6)}  ${run.fake ? "STAND-IN, not a measurement" : Object.values(run.models).map(model => model.model).join(" + ")}`
  );
}
