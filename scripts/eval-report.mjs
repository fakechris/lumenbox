#!/usr/bin/env node
/**
 * The evaluation report (INV-1772): the gold corpus, k attempts a task, code graders, one page.
 *
 *   npm run eval -- plan                     what a run would cost in model calls; makes none
 *   npm run eval -- run                      the test split, 3 attempts a task, on the configured
 *                                            provider. Costs money. Writes the result beside the
 *                                            release scorecards and docs/evals/REPORT-<date>.md
 *     --split dev|test    --k 3              which half, how many attempts
 *     --only <id prefix>  --subject <name>   fewer tasks (the report says how many ran)
 *     --provider <name>                      instead of the configured one
 *     --baseline <result.json>               compare with this run; default: the latest result
 *                                            for the same split
 *     --offline                              never call a model: the cache or nothing
 *     --cache <dir>  --out <file>  --report <file>
 *     --fake [--wrong 0.2]                   a deterministic stand-in answers instead of a model.
 *                                            Exercises everything and measures nothing: the page
 *                                            says so in its first line, nothing is written unless
 *                                            --out/--cache/--report name a place, and docs/evals/
 *                                            is refused
 *     --no-judges                            code graders only; skip the judge questions
 *   npm run eval -- --compare <base-ref> <candidate-ref>
 *                                            two versions of the prompt and tools on the same tasks:
 *                                            each commit's product is frozen and run on dev and test,
 *                                            k attempts a task, with this checkout's tasks and graders.
 *                                            Twice the calls of a plain run where the two send
 *                                            different requests — `plan --compare a b` says how many.
 *                                            Prints both pass rates, the difference, the tasks that
 *                                            moved and a gate; takes --split, --k, --only, --subject,
 *                                            --provider, --offline, --cache, --out, --report, --fake
 *     --max-broken 0                         red above this many tasks going from every attempt
 *                                            passing to none
 *     --max-worse <n>                        also red above this many tasks getting worse (off unless given)
 *     --repo <dir>                           where the two refs are resolved; default: this checkout
 *   npm run eval -- judge <result.json> [--out <file>] [--fake]       ask the judge questions of a
 *                                            record already made; its attempts are not run again
 *   npm run eval -- label-sheet <result.json> [--count 30] [--out <file>]
 *                                            the outputs a person labels to calibrate the judges:
 *                                            fill in "label" (present / absent) and "by" on each
 *                                            line and save it under evals/labels/
 *   npm run eval -- report <result.json> [--baseline <result.json>]   print the page again
 *   npm run eval -- trend [--dir <results>]  one line per past run, oldest first
 *   npm run eval -- build-corpus [--check]   rewrite evals/corpus/ from the repository's own
 *                                            material (src/evals/corpus-build.ts); --check only says
 *
 * Not part of `npm test` and not a gate: CI never runs a model. The pieces live in src/evals/ —
 * corpus, graders, subjects, cache, runner, judges, calibration, stats, summary, report, and frozen, surface and
 * compare for two versions — and this file only wires them
 * to a provider, a clock and the disk. Credentials are read by the provider client from the
 * operator's configuration, as every live script does, and never printed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const CORPUS_DIR = join(root, "evals/corpus");
const REPORTS_DIR = join(root, "docs/evals");
const LABELS_DIR = join(root, "evals/labels");

function parseArgs(argv) {
  const flag = name => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  return { command: argv[0] !== undefined && !argv[0].startsWith("--") ? argv[0] : "run", flag, has: name => argv.includes(name), rest: argv.slice(1), argv };
}

const git = args => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const readRun = path => {
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (run.format !== "lumenbox-eval/1") throw new Error(`${path} is not an evaluation result (format ${run.format ?? "missing"})`);
  return run;
};

/** Every evaluation result in a directory, oldest first. Other files there (release scorecards) are passed over. */
function resultsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.startsWith("eval-") && name.endsWith(".json")).sort().flatMap(name => {
    try {
      return [{ path: join(dir, name), run: readRun(join(dir, name)) }];
    } catch {
      return [];
    }
  });
}

async function chosenTasks(args) {
  const { loadCorpus } = await import("../src/evals/corpus.ts");
  // A comparison of two versions reads both halves unless told otherwise; a plain run reads test.
  const split = args.flag("--split") ?? (args.has("--compare") ? "dev+test" : "test");
  if (split !== "dev" && split !== "test" && !(split === "dev+test" && args.has("--compare"))) throw new Error(`--split needs dev or test, not ${split}`);
  const only = args.flag("--only");
  const subject = args.flag("--subject");
  const corpus = loadCorpus(CORPUS_DIR);
  const wanted = half => (split === half || split === "dev+test" ? corpus[half].filter(task => (only === undefined || task.id.startsWith(only)) && (subject === undefined || task.subject === subject)) : []);
  const halves = { dev: wanted("dev"), test: wanted("test") };
  const tasks = [...halves.dev, ...halves.test];
  if (tasks.length === 0) throw new Error(`no task in the ${split} split matches`);
  const k = Number(args.flag("--k") ?? 3);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k needs a whole number of attempts, not ${args.flag("--k")}`);
  return { split, tasks, halves, k };
}

/** The two refs after --compare. */
function comparedRefs(args) {
  const at = args.argv.indexOf("--compare");
  const refs = [args.argv[at + 1], args.argv[at + 2]];
  if (refs.some(ref => ref === undefined || ref.startsWith("--"))) throw new Error("--compare needs two refs: the base, then the candidate");
  return { base: refs[0], candidate: refs[1] };
}

/** What a comparison costs, said before anything is spent: every task runs on both versions, and no judge is asked. */
function compareBudgetLine(budget, refs) {
  return `Comparing ${refs.base} with ${refs.candidate} runs every task on both versions: at most ${budget.total * 2} model calls, twice the ${budget.total} of a plain run. ` +
    "A request the two send byte for byte alike is made once. No judge is asked: none is calibrated, and the gate reads code graders only.";
}

async function plan(args, out) {
  const { SUBJECT_TABLE } = await import("../src/evals/subjects.ts");
  const { callBudget } = await import("../src/evals/runner.ts");
  const { split, tasks, k } = await chosenTasks(args);
  const budget = callBudget(tasks, SUBJECT_TABLE, k);
  const { judgeCallBudget } = await import("../src/evals/judges.ts");
  const comparing = args.has("--compare");
  const judged = args.has("--no-judges") || comparing ? 0 : judgeCallBudget(tasks, k);
  if (comparing) out(compareBudgetLine(budget, comparedRefs(args)));
  out(`${tasks.length} tasks from the ${split} split × ${k} attempts: at most ${budget.total} model calls${comparing ? " a version" : ""}, and ${judged} judge calls after them.`);
  for (const [name, cell] of Object.entries(budget.bySubject)) {
    out(`  ${name.padEnd(12)} ${String(cell.tasks).padStart(3)} tasks  ≤ ${String(cell.calls).padStart(4)} calls  (${SUBJECT_TABLE[name].tier} model)`);
  }
  if (judged > 0) out(`  ${"judge".padEnd(12)} ${String(judged / k).padStart(3)} tasks  ≤ ${String(judged).padStart(4)} calls  (summary model; one question per attempt whose failure type has one)`);
  out("An episode stops at its cap and usually ends sooner; calls already in the cache are not made again.");
  return 0;
}

/**
 * The models a command runs on, per tier, with the operator's rates and home. Everything read from
 * the operator's own home is read here, before a scratch home replaces it. A stand-in run reads
 * none of it: no provider, no rates, no home.
 */
async function modelTiers(args, fake, out) {
  const { resolveProvider, createClient, summaryRuntimeFor } = await import("../src/host/provider.ts");
  let tiers;
  let rates = {};
  let home;
  if (fake) {
    const profile = resolveProvider("anthropic");
    const never = async () => {
      throw new Error("a stand-in run reached for the real model");
    };
    tiers = { primary: { model: never, profile }, summary: { model: never, profile } };
  } else {
    const { loadConfig, applyConfigEnv, agentboxHome } = await import("../src/config.ts");
    const { configuredRates } = await import("../src/host/provider-fallback.ts");
    const config = loadConfig();
    applyConfigEnv(config);
    home = agentboxHome();
    rates = configuredRates();
    const provider = resolveProvider(args.flag("--provider") ?? process.env.AGENTBOX_PROVIDER ?? config.provider);
    const client = createClient(provider);
    const cheap = summaryRuntimeFor(provider, client);
    const call = from => (params, wire) => (wire === "stream" ? from.messages.stream(params).finalMessage() : from.messages.create(params));
    tiers = { primary: { model: call(client), profile: provider }, summary: { model: call(cheap.client), profile: cheap.profile } };
    out(`provider: ${provider.label} ${provider.model}; side calls: ${cheap.profile.label} ${cheap.profile.model}`);
  }
  return { tiers, rates, home };
}

/** An episode builds a whole agent home; none of that may land in the operator's. */
async function inScratchHome(work) {
  const scratch = mkdtempSync(join(tmpdir(), "lumenbox-eval-"));
  const realHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = scratch;
  try {
    return await work();
  } finally {
    if (realHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = realHome;
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A stand-in's page is not a result: it may be printed or written elsewhere, never filed where results are kept. */
function refuseStandInPage(fake, reportFile) {
  if (fake && reportFile !== undefined && !relative(REPORTS_DIR, resolve(reportFile)).startsWith("..")) {
    throw new Error("a stand-in run is not a result: its page may not be written into docs/evals/");
  }
}

async function compare(args, out) {
  const fake = args.has("--fake");
  const refs = comparedRefs(args);
  const { halves, tasks, k } = await chosenTasks(args);
  const { SUBJECT_TABLE } = await import("../src/evals/subjects.ts");
  const { callBudget } = await import("../src/evals/runner.ts");
  const { freezeRef, resolveRef } = await import("../src/evals/frozen.ts");
  const { runCompare, compareSides } = await import("../src/evals/compare.ts");
  const { renderComparison } = await import("../src/evals/report.ts");
  const { FileCache } = await import("../src/evals/cache.ts");
  const repo = args.flag("--repo") ?? root;
  const number = name => {
    const given = args.flag(name);
    if (given !== undefined && !(Number.isInteger(Number(given)) && Number(given) >= 0)) throw new Error(`${name} needs a whole number of tasks, not ${given}`);
    return given === undefined ? undefined : Number(given);
  };
  const limits = { maxBroken: number("--max-broken"), maxWorse: number("--max-worse") };
  // Both refs are checked, and the cost said, before a provider is read or a tree is exported.
  const shas = { base: resolveRef(repo, refs.base), candidate: resolveRef(repo, refs.candidate) };
  out(compareBudgetLine(callBudget(tasks, SUBJECT_TABLE, k), refs));
  const { tiers, rates, home } = await modelTiers(args, fake, out);
  const cacheDir = args.flag("--cache") ?? (home !== undefined ? join(home, "eval-cache") : undefined);
  const at = new Date().toISOString();
  const name = `COMPARE-${at.slice(0, 10)}-${shas.base.slice(0, 7)}-${shas.candidate.slice(0, 7)}`;
  const outFile = args.flag("--out") ?? (home !== undefined ? join(home, "scorecards", `compare-${at.replace(/[:.]/g, "-")}-${shas.base.slice(0, 7)}-${shas.candidate.slice(0, 7)}.json`) : undefined);
  const reportFile = args.flag("--report") ?? (fake ? undefined : join(REPORTS_DIR, `${name}.md`));
  refuseStandInPage(fake, reportFile);

  const frozen = [];
  let record;
  try {
    record = await inScratchHome(async () => {
      const build = async ref => {
        // Two refs naming one commit are one tree.
        const one = frozen.find(held => held.sha === resolveRef(repo, ref)) ?? (await freezeRef({ repo, ref }));
        if (!frozen.includes(one)) frozen.push(one);
        return { ref, sha: one.sha, subjects: one.subjects, surface: await one.promptSurface(), ownCorpus: one.ownCorpus };
      };
      return runCompare({
        base: await build(refs.base), candidate: await build(refs.candidate), tasks: halves, k, tiers, at,
        ...(fake ? { fake: { wrongShare: Number(args.flag("--wrong") ?? 0.2) } } : {}),
        ...(cacheDir !== undefined ? { cache: new FileCache(cacheDir) } : {}),
        offline: args.has("--offline"),
        progress: line => out(`  ${line}`),
      });
    });
  } finally {
    for (const one of frozen) one.release();
  }

  const comparison = compareSides(record, { rates, ...(limits.maxBroken !== undefined ? { maxBroken: limits.maxBroken } : {}), ...(limits.maxWorse !== undefined ? { maxWorse: limits.maxWorse } : {}) });
  const page = renderComparison(record, comparison, { name });
  if (outFile !== undefined) {
    writeFile(outFile, `${JSON.stringify(record, null, 2)}\n`);
    out(`result: ${outFile}`);
  }
  if (reportFile !== undefined) {
    writeFile(reportFile, page);
    out(`report: ${reportFile}`);
  } else out(`\n${page}`);
  out(`gate: ${comparison.gate.status.replaceAll("_", " ")}${comparison.gate.reasons.length > 0 ? ` — ${comparison.gate.reasons.join("; ")}` : ""}${record.fake ? " (stand-in; not a measurement)" : ""}`);
  out(`model calls: ${record.base.run.calls.made + record.candidate.run.calls.made} made, ${record.base.run.calls.cached + record.candidate.run.calls.cached} from the cache`);
  return 0;
}

async function run(args, out) {
  if (args.has("--compare")) return compare(args, out);
  const fake = args.has("--fake");
  const { split, tasks, k } = await chosenTasks(args);
  const { SUBJECT_TABLE } = await import("../src/evals/subjects.ts");
  const { runEval } = await import("../src/evals/runner.ts");
  const { FileCache } = await import("../src/evals/cache.ts");
  const { summarise } = await import("../src/evals/summary.ts");
  const { renderReport } = await import("../src/evals/report.ts");
  const { judgeRun } = await import("../src/evals/judges.ts");
  const { loadLabels } = await import("../src/evals/calibration.ts");
  const { tiers, rates, home } = await modelTiers(args, fake, out);
  const resultsDir = home !== undefined ? join(home, "scorecards") : undefined;
  const cacheDir = args.flag("--cache") ?? (home !== undefined ? join(home, "eval-cache") : undefined);
  const at = new Date().toISOString();
  const commit = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const outFile = args.flag("--out") ?? (resultsDir !== undefined ? join(resultsDir, `eval-${split}-${at.replace(/[:.]/g, "-")}-${commit}.json`) : undefined);
  const baselineFile = args.flag("--baseline") ?? (resultsDir !== undefined ? resultsIn(resultsDir).filter(one => one.run.split === split && !one.run.fake).at(-1)?.path : undefined);
  const baseline = baselineFile !== undefined ? readRun(baselineFile) : undefined;
  const name = `REPORT-${at.slice(0, 10)}`;
  const reportFile = args.flag("--report") ?? (fake ? undefined : join(REPORTS_DIR, `${name}.md`));
  refuseStandInPage(fake, reportFile);

  const result = await inScratchHome(() => runEval({
    tasks, split, k, subjects: SUBJECT_TABLE, tiers,
    ...(fake ? { fake: { wrongShare: Number(args.flag("--wrong") ?? 0.2) } } : {}),
    ...(cacheDir !== undefined ? { cache: new FileCache(cacheDir) } : {}),
    offline: args.has("--offline"),
    meta: { at, commit, dirty: git(["status", "--porcelain"]) !== "" },
    progress: line => out(`  ${line}`),
  }));

  if (!args.has("--no-judges")) {
    result.judges = await judgeRun(result, tasks, {
      model: tiers.summary.model, profile: tiers.summary.profile,
      ...(fake ? { fake: { presentShare: Number(args.flag("--wrong") ?? 0.2) } } : {}),
      ...(cacheDir !== undefined ? { cache: new FileCache(cacheDir) } : {}),
      offline: args.has("--offline"),
    });
    out(`judges: ${result.judges.verdicts.length} verdicts, ${result.judges.calls.made} calls made, ${result.judges.calls.cached} from the cache`);
  }

  const summary = summarise(result, { ...(baseline !== undefined ? { baseline } : {}), rates, labels: loadLabels(LABELS_DIR) });
  const page = renderReport(result, summary, { name });
  if (outFile !== undefined) {
    writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`);
    out(`result: ${outFile}`);
  }
  if (reportFile !== undefined) {
    writeFile(reportFile, page);
    out(`report: ${reportFile}`);
  } else out(`\n${page}`);
  out(`model calls: ${result.calls.made} made, ${result.calls.cached} from the cache${result.fake ? " (stand-in; not a measurement)" : ""}`);
  return 0;
}

/** The record a command was pointed at: the first argument that is not a flag or a flag's value. */
function recordArgument(args, command) {
  const file = args.rest.find((arg, at) => !arg.startsWith("--") && !(args.rest[at - 1] ?? "").startsWith("--"));
  if (file === undefined) throw new Error(`${command} needs a result file`);
  return file;
}

/** The corpus tasks a record was run from, for the judges' context. */
async function tasksOf(record) {
  const { loadCorpus } = await import("../src/evals/corpus.ts");
  return loadCorpus(CORPUS_DIR)[record.split];
}

async function judge(args, out) {
  const file = recordArgument(args, "judge");
  const fake = args.has("--fake");
  const record = readRun(file);
  if (record.fake && !fake) throw new Error("this record is a stand-in's: asking a real judge about it would spend money on nothing (use --fake)");
  const { judgeRun } = await import("../src/evals/judges.ts");
  const { FileCache } = await import("../src/evals/cache.ts");
  const { tiers, home } = await modelTiers(args, fake, out);
  const cacheDir = args.flag("--cache") ?? (home !== undefined ? join(home, "eval-cache") : undefined);
  record.judges = await judgeRun(record, await tasksOf(record), {
    model: tiers.summary.model, profile: tiers.summary.profile,
    ...(fake ? { fake: { presentShare: Number(args.flag("--wrong") ?? 0.2) } } : {}),
    ...(cacheDir !== undefined ? { cache: new FileCache(cacheDir) } : {}),
    offline: args.has("--offline"),
  });
  const target = args.flag("--out") ?? file;
  writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
  out(`judges: ${record.judges.verdicts.length} verdicts by ${record.judges.model.provider} ${record.judges.model.model}, ${record.judges.calls.made} calls made, ${record.judges.calls.cached} from the cache`);
  out(`result: ${target}`);
  return 0;
}

async function labelSheet(args, out) {
  const file = recordArgument(args, "label-sheet");
  const record = readRun(file);
  const { selectForLabelling, MIN_LABELS } = await import("../src/evals/calibration.ts");
  const rows = selectForLabelling(record, await tasksOf(record), { count: Number(args.flag("--count") ?? MIN_LABELS) });
  const target = args.flag("--out") ?? join(LABELS_DIR, `labels-${record.at.slice(0, 10)}.jsonl`);
  if (existsSync(target)) throw new Error(`${target} exists; labels already given are not overwritten. Name another file with --out.`);
  writeFile(target, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  out(`${rows.length} outputs to label: ${target}`);
  out('On each line set "label" to "present" or "absent" — is the failure the question asks about in this output? — and "by" to your name.');
  if (rows.length < MIN_LABELS) out(`Fewer than the ${MIN_LABELS} a calibration needs: this record has no more judged outputs.`);
  return 0;
}

async function report(args, out) {
  const file = recordArgument(args, "report");
  const { summarise } = await import("../src/evals/summary.ts");
  const { renderReport } = await import("../src/evals/report.ts");
  const result = readRun(file);
  const baselineFile = args.flag("--baseline");
  let rates = {};
  if (!result.fake) rates = (await import("../src/host/provider-fallback.ts")).configuredRates();
  const { loadLabels } = await import("../src/evals/calibration.ts");
  const summary = summarise(result, { ...(baselineFile !== undefined ? { baseline: readRun(baselineFile) } : {}), rates, labels: loadLabels(LABELS_DIR) });
  out(renderReport(result, summary, { name: `REPORT-${result.at.slice(0, 10)}` }));
  return 0;
}

async function trend(args, out) {
  const { summarise } = await import("../src/evals/summary.ts");
  const { renderTrend } = await import("../src/evals/report.ts");
  const dir = args.flag("--dir") ?? join((await import("../src/config.ts")).agentboxHome(), "scorecards");
  const rows = resultsIn(dir).map(one => ({ run: one.run, summary: summarise(one.run) }));
  if (rows.length === 0) out(`No evaluation results under ${dir}.`);
  for (const line of renderTrend(rows)) out(line);
  return 0;
}

async function buildCorpusCommand(args, out) {
  const { loadCorpus, serializeCorpus, corpusProblems, SPLITS } = await import("../src/evals/corpus.ts");
  const { buildCorpus } = await import("../src/evals/corpus-build.ts");
  const built = buildCorpus(root, loadCorpus(CORPUS_DIR));
  const problems = corpusProblems(built);
  if (problems.length > 0) throw new Error(`the corpus would not be usable:\n  ${problems.join("\n  ")}`);
  let stale = 0;
  for (const split of SPLITS) {
    const path = join(CORPUS_DIR, `${split}.jsonl`);
    const text = serializeCorpus(built[split]);
    const same = existsSync(path) && readFileSync(path, "utf8") === text;
    if (!same) stale += 1;
    if (!same && !args.has("--check")) writeFile(path, text);
    out(`${split}: ${built[split].length} tasks${same ? "" : args.has("--check") ? " — differs from its sources" : " — written"}`);
  }
  return args.has("--check") && stale > 0 ? 1 : 0;
}

const COMMANDS = { run, plan, judge, "label-sheet": labelSheet, report, trend, "build-corpus": buildCorpusCommand };

export async function main(argv, out = line => console.log(line)) {
  const args = parseArgs(argv);
  const command = COMMANDS[args.command];
  if (command === undefined) {
    out(`Unknown command ${args.command}. Have: ${Object.keys(COMMANDS).join(", ")}.`);
    return 2;
  }
  return command(args, out);
}

// Run only as the script: the test imports `main`.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
