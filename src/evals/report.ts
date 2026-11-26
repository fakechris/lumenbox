/**
 * The one page (INV-1772): `docs/evals/REPORT-<date>-<model>.md`.
 *
 * Four numbers, each beside what limits it: the pass rate with its interval, pass^k beside pass@k,
 * the comparison with the previous run, and the smallest difference this sample could show. Then
 * where the failures are, what it cost, and what was not measured.
 *
 * The page opens with a header that says whether a model was measured at all. A page printed from
 * the deterministic stand-in says so in its first line and in its title, and `docs-lint` refuses
 * one in `docs/evals/`: a number that measures nothing must not be found where results are kept.
 */

import { KAPPA_TO_GATE, MIN_LABELS, twoPlaces } from "./calibration.ts";
import type { CompareRecord, Comparison, MovedTask, Side } from "./compare.ts";
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

const NOT_CALIBRATED = "**Judge not calibrated — may not gate.**";

/**
 * What the judges said and whether any of it may be relied on. Until enough of a person's labels
 * match this judge's verdicts the section opens with the same sentence every time, whatever the
 * verdicts were: an unchecked judge's numbers are shown so they can be checked, not so they can be used.
 */
function judgeLines(summary: Summary): string[] {
  const judges = summary.judges;
  if (judges === undefined) {
    return [
      `${NOT_CALIBRATED} Every result on this page comes from code graders. No judge question was asked, and no judge has been ` +
        "checked against a person's labels, so nothing here rests on a model's opinion and no judge verdict may gate a change.",
    ];
  }
  const calibration = judges.calibration;
  const who = `Judge: ${judges.model.provider} ${judges.model.model}, questions version ${judges.promptVersion}`;
  const asked = judges.rows.reduce((sum, row) => sum + row.asked, 0);
  const tail = `One yes-or-no question per failure type, each verdict resting on a quote that code found in the output. ${asked} asked` +
    `${judges.skipped > 0 ? `, ${judges.skipped} not asked (nothing to read)` : ""}, costing ${count(judges.use.inputTokens)} input and ${count(judges.use.outputTokens)} output tokens beside the cost below. ` +
    "A verdict never changes the pass rate above.";
  if (calibration === undefined || !calibration.calibrated) {
    const why = calibration === undefined
      ? "The judge here is the stand-in; its verdicts mean nothing."
      : `${calibration.matched} of the ${MIN_LABELS} labels a person must give have been matched to these verdicts` +
        `${calibration.unmatched > 0 ? ` (${calibration.unmatched} more are for outputs not on this record)` : ""}, so no verdict below may gate a change.`;
    return [
      `${NOT_CALIBRATED} ${why}`, "", `${who}. ${tail}`, "",
      "| failure type | asked | judge says present | no valid quote |", "|---|---|---|---|",
      ...judges.rows.map(row => `| ${row.question} | ${row.asked} | ${row.present} | ${row.invalid} |`),
    ];
  }
  const byQuestion = new Map(calibration.questions.map(one => [one.question, one]));
  const num = (value: number | undefined) => (value === undefined ? "—" : twoPlaces(value));
  return [
    `Checked against ${calibration.matched} outputs labelled by ${calibration.labellers.join(", ")}` +
      `${calibration.conflicting > 0 ? `; ${calibration.conflicting} left out because two labels disagree` : ""}. ` +
      `A question may gate only at kappa ${KAPPA_TO_GATE} or more; a verdict with no valid quote counts against the judge.`,
    "", `${who}. ${tail}`, "",
    "| failure type | asked | judge says present | no valid quote | labels | kappa | catch rate | |", "|---|---|---|---|---|---|---|---|",
    ...judges.rows.map(row => {
      const one = byQuestion.get(row.question);
      return `| ${row.question} | ${row.asked} | ${row.present} | ${row.invalid} | ${one?.labels ?? 0} | ${num(one?.kappa)} | ${one?.catchRate === undefined ? "—" : pct(one.catchRate)} | ` +
        `${one?.mayGate === true ? "may gate" : "**may not gate**"} — ${one?.why ?? "no labels"} |`;
    }),
  ];
}

/**
 * The page's name: the day and the agent's model, so two models measured on one day are two pages
 * and neither overwrites the other. The model is lower-cased and anything outside `a-z 0-9 .` becomes
 * a dash; `docs-lint` accepts exactly this shape, and a page from before the model was in the name.
 */
export function reportName(run: Pick<EvalRun, "at" | "models">): string {
  const model = run.models.primary.model.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  return `REPORT-${run.at.slice(0, 10)}${model === "" ? "" : `-${model}`}`;
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
    ...judgeLines(summary),
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
      lines.push(`| ${task.id} | ${task.attempts.filter(attempt => attempt.pass).length}/${task.attempts.length} | ${cell(finding)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const signed = (value: number, digits = 1): string => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;
const cell = (text: string): string => text.replaceAll("|", "\\|").replace(/\s+/g, " ").slice(0, 200);

function movedTable(title: string, tasks: readonly MovedTask[], which: string): string[] {
  if (tasks.length === 0) return [`## ${title}`, "", "None.", ""];
  return [
    `## ${title}`, "",
    `| task | split | base | candidate | ${which} |`, "|---|---|---|---|---|",
    ...tasks.map(task => `| ${task.id}${task.outright ? " **(outright)**" : ""} | ${task.split ?? "—"} | ${task.base} | ${task.candidate} | ${cell(task.finding)} |`),
    "",
  ];
}

/**
 * The page of a comparison of two versions (INV-1862): the gate first, then the two sides, the
 * difference, the tasks that moved, and what the page does not say. Same header as a report, so a
 * stand-in's comparison is kept out of `docs/evals/` by the same check.
 */
export function renderComparison(record: CompareRecord, comparison: Comparison, options: { name: string }): string {
  const { base, candidate, gate, paired, difference } = comparison;
  const run = record.candidate.run;
  const models = Object.entries(run.models).map(([tier, model]) => `${tier}: ${model.provider} ${model.model}`).join("; ");
  const named = (side: Side): string => `${side.ref} (${side.sha.slice(0, 7)})`;
  const rate = (summary: typeof base): string => `**${pct(summary.passRate?.estimate)}** (${pct(summary.passRate?.low)} – ${pct(summary.passRate?.high)})`;
  const perPass = (summary: typeof base): string =>
    summary.cost.tokensPerPass === undefined ? "—" : `${count(summary.cost.tokensPerPass)} tokens${summary.cost.usdPerPass !== undefined ? `, $${summary.cost.usdPerPass.toFixed(4)}` : ""}`;
  const corpusNote = (side: Side, name: string): string =>
    side.ownCorpus === "same" ? "" : side.ownCorpus === "none" ? ` The ${name} commit has no corpus of its own.` : ` The ${name} commit's own corpus differs from it and was not used.`;
  const lines: string[] = [
    `<!-- eval-report: ${options.name}`,
    `     measured: ${record.fake ? "no — a deterministic stand-in answered; these numbers measure nothing" : "yes"}`,
    `     split: ${run.split}`,
    `     corpus: ${run.corpus.version}`,
    `     base: ${named(record.base)}`,
    `     candidate: ${named(record.candidate)}`,
    `     models: ${models}`,
    "-->",
    `# Comparison ${record.at.slice(0, 10)}: ${record.base.ref} → ${record.candidate.ref}${record.fake ? " — NOT A MEASUREMENT (stand-in model)" : ""}`,
    "",
  ];
  if (record.fake) {
    lines.push(
      "> No model was asked. A deterministic stand-in answered both versions — the gold answer where the prompt it was sent still offers it, " +
        "or the wrong one — to exercise the comparison and this page. Nothing below describes the product.",
      "",
    );
  }
  lines.push(
    gate.status === "RED" ? `**Gate: RED** — ${gate.reasons.join("; ")}.` : gate.status === "NOT_READ" ? `**Gate: not read** — ${gate.reasons.join("; ")}.` : "**Gate: not red.**",
    "",
    `Red is a fall in the pass rate whose whole 95% interval is below zero, or more than ${gate.maxBroken} task${gate.maxBroken === 1 ? "" : "s"} going from passing every attempt to passing none` +
      `${gate.maxWorse !== undefined ? `, or more than ${gate.maxWorse} tasks getting worse` : ""}. ` +
      "The gate reads code graders only: no judge was asked, and no judge has been checked against a person's labels, so none may gate. Nothing in CI reads this page; a person does.",
    "",
    "## The two versions",
    "",
    "| | commit | system prompt | tools | prompt and tools |",
    "|---|---|---|---|---|",
    ...([["base", record.base], ["candidate", record.candidate]] as const).map(([name, side]) =>
      `| ${name}: ${side.ref} | ${side.sha.slice(0, 7)} | ${count(side.surface.systemBytes)} bytes | ${side.surface.tools}, ${count(side.surface.toolsBytes)} bytes | ${side.surface.digest} |`),
    "",
    record.base.surface.digest === record.candidate.surface.digest
      ? "**The two versions send the same prompt and the same tools.** Whatever differs below comes from the product's handling of the answers, not from what the model was told."
      : `The candidate's system prompt is ${signed(record.candidate.surface.systemBytes - record.base.surface.systemBytes, 0)} bytes ` +
        `and its tool list ${signed(record.candidate.surface.toolsBytes - record.base.surface.toolsBytes, 0)} bytes against the base.`,
    "",
    `${base.tasks} tasks from the **${run.split}** split${run.split === "dev+test" ? "s" : ""} (corpus ${run.corpus.version}), ${record.k} attempts each on each side, graded by the same code. ${models}. ` +
      `The tasks and graders are the running checkout's, for both sides.${corpusNote(record.base, "base")}${corpusNote(record.candidate, "candidate")}`,
    `Model calls: ${record.base.run.calls.made + record.candidate.run.calls.made} made, ${record.base.run.calls.cached + record.candidate.run.calls.cached} answered from the cache. ` +
      "A request the two versions send byte for byte alike is asked once and answered the same on both sides.",
    "",
    "## The numbers",
    "",
    "| | base | candidate | difference |",
    "|---|---|---|---|",
    `| Pass rate (95% interval) | ${rate(base)} | ${rate(candidate)} | ` +
      (difference === undefined ? "— |" : `**${signed(difference.estimate * 100)} points** (${signed(difference.low * 100)} to ${signed(difference.high * 100)}), task by task |`),
    `| pass^${record.k} — a task passes every time | ${pct(base.passHatK)} | ${pct(candidate.passHatK)} | ${paired.worse} worse, ${paired.better} better of ${paired.paired} paired |`,
    `| McNemar | | | p = ${paired.p.toFixed(3)} — **${paired.verdict.replaceAll("_", " ")}**: ${paired.why} |`,
    `| Cost per passed attempt | ${perPass(base)} | ${perPass(candidate)} | ` +
      (comparison.cost.tokensPerPass === undefined ? "— |" : `${signed(comparison.cost.tokensPerPass, 0)} tokens${comparison.cost.usdPerPass !== undefined ? `, ${signed(comparison.cost.usdPerPass, 4)} $` : ""} |`),
    `| Smallest detectable difference | | | ${pct(base.detectableDifference)} — a true change smaller than this is usually not told from noise by ${base.tasks} tasks |`,
    "",
    "The difference is the mean, over paired tasks, of the change in each task's own pass rate; its interval resamples tasks. " +
      `A task is worse when every one of its ${record.k} attempts passed on the base and not on the candidate, better the other way round.` +
      (comparison.unpaired.length > 0
        ? ` **${comparison.unpaired.length} task(s) were not paired** because the harness failed on a side (${cell(comparison.unpaired.join(", "))}): ` +
          "they are in each side's pass rate as failures and in no difference."
        : ""),
    "",
    "| split | paired tasks | base passes every time | candidate passes every time | worse | better |",
    "|---|---|---|---|---|---|",
    ...comparison.bySplit.map(row => `| ${row.split} | ${row.tasks} | ${row.base} | ${row.candidate} | ${row.worse} | ${row.better} |`),
    "",
    "Dev is what a prompt may have been tuned against; a gain there that test does not show is the tuning.",
    "",
    ...movedTable("Tasks that got worse", comparison.worse, "what the graders found on the candidate"),
    ...movedTable("Tasks that got better", comparison.better, "what the graders found on the base"),
    "## What this does not say",
    "",
    "- Not red is not safe. A fall smaller than the detectable difference above passes this gate unseen; the McNemar line says INCOMPLETE and how many tasks would settle it when that is the case.",
    "- A task that moved is not always the prompt's doing: between two runs of one version, tasks change sides by chance. The gate counts only tasks that broke outright for that reason.",
    "- The corpus holds what the repository already stated as a right answer; what no task asks, this cannot see.",
    "",
  );
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
