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
 *   npm run eval -- report <result.json> [--baseline <result.json>]   print the page again
 *   npm run eval -- trend [--dir <results>]  one line per past run, oldest first
 *   npm run eval -- build-corpus [--check]   rewrite evals/corpus/ from the repository's own
 *                                            material (src/evals/corpus-build.ts); --check only says
 *
 * Not part of `npm test` and not a gate: CI never runs a model. The pieces live in src/evals/ —
 * corpus, graders, subjects, cache, runner, stats, summary, report — and this file only wires them
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

function parseArgs(argv) {
  const flag = name => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  return { command: argv[0] !== undefined && !argv[0].startsWith("--") ? argv[0] : "run", flag, has: name => argv.includes(name), rest: argv.slice(1) };
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
  const split = args.flag("--split") ?? "test";
  if (split !== "dev" && split !== "test") throw new Error(`--split needs dev or test, not ${split}`);
  const only = args.flag("--only");
  const subject = args.flag("--subject");
  const tasks = loadCorpus(CORPUS_DIR)[split].filter(task => (only === undefined || task.id.startsWith(only)) && (subject === undefined || task.subject === subject));
  if (tasks.length === 0) throw new Error(`no task in the ${split} split matches`);
  const k = Number(args.flag("--k") ?? 3);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k needs a whole number of attempts, not ${args.flag("--k")}`);
  return { split, tasks, k };
}

async function plan(args, out) {
  const { SUBJECT_TABLE } = await import("../src/evals/subjects.ts");
  const { callBudget } = await import("../src/evals/runner.ts");
  const { split, tasks, k } = await chosenTasks(args);
  const budget = callBudget(tasks, SUBJECT_TABLE, k);
  out(`${tasks.length} tasks from the ${split} split × ${k} attempts: at most ${budget.total} model calls, none of them judges.`);
  for (const [name, cell] of Object.entries(budget.bySubject)) {
    out(`  ${name.padEnd(12)} ${String(cell.tasks).padStart(3)} tasks  ≤ ${String(cell.calls).padStart(4)} calls  (${SUBJECT_TABLE[name].tier} model)`);
  }
  out("An episode stops at its cap and usually ends sooner; calls already in the cache are not made again.");
  return 0;
}

async function run(args, out) {
  const fake = args.has("--fake");
  const { split, tasks, k } = await chosenTasks(args);
  const { SUBJECT_TABLE } = await import("../src/evals/subjects.ts");
  const { runEval } = await import("../src/evals/runner.ts");
  const { FileCache } = await import("../src/evals/cache.ts");
  const { summarise } = await import("../src/evals/summary.ts");
  const { renderReport } = await import("../src/evals/report.ts");
  const { resolveProvider, createClient, summaryRuntimeFor } = await import("../src/host/provider.ts");

  // Everything read from the operator's own home is read here, before the scratch home replaces it:
  // the provider, the rates, and where results and the cache are kept.
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
  const resultsDir = home !== undefined ? join(home, "scorecards") : undefined;
  const cacheDir = args.flag("--cache") ?? (home !== undefined ? join(home, "eval-cache") : undefined);
  const at = new Date().toISOString();
  const commit = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const outFile = args.flag("--out") ?? (resultsDir !== undefined ? join(resultsDir, `eval-${split}-${at.replace(/[:.]/g, "-")}-${commit}.json`) : undefined);
  const baselineFile = args.flag("--baseline") ?? (resultsDir !== undefined ? resultsIn(resultsDir).filter(one => one.run.split === split && !one.run.fake).at(-1)?.path : undefined);
  const baseline = baselineFile !== undefined ? readRun(baselineFile) : undefined;
  const name = `REPORT-${at.slice(0, 10)}`;
  const reportFile = args.flag("--report") ?? (fake ? undefined : join(REPORTS_DIR, `${name}.md`));
  if (fake && reportFile !== undefined && !relative(REPORTS_DIR, resolve(reportFile)).startsWith("..")) {
    throw new Error("a stand-in run is not a result: its page may not be written into docs/evals/");
  }

  // An episode builds a whole agent home; none of that may land in the operator's.
  const scratch = mkdtempSync(join(tmpdir(), "lumenbox-eval-"));
  const realHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = scratch;
  let result;
  try {
    result = await runEval({
      tasks, split, k, subjects: SUBJECT_TABLE, tiers,
      ...(fake ? { fake: { wrongShare: Number(args.flag("--wrong") ?? 0.2) } } : {}),
      ...(cacheDir !== undefined ? { cache: new FileCache(cacheDir) } : {}),
      offline: args.has("--offline"),
      meta: { at, commit, dirty: git(["status", "--porcelain"]) !== "" },
      progress: line => out(`  ${line}`),
    });
  } finally {
    if (realHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = realHome;
    rmSync(scratch, { recursive: true, force: true });
  }

  const summary = summarise(result, { ...(baseline !== undefined ? { baseline } : {}), rates });
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

async function report(args, out) {
  const file = args.rest.find(arg => !arg.startsWith("--") && args.rest[args.rest.indexOf(arg) - 1] !== "--baseline");
  if (file === undefined) throw new Error("report needs a result file");
  const { summarise } = await import("../src/evals/summary.ts");
  const { renderReport } = await import("../src/evals/report.ts");
  const result = readRun(file);
  const baselineFile = args.flag("--baseline");
  let rates = {};
  if (!result.fake) rates = (await import("../src/host/provider-fallback.ts")).configuredRates();
  out(renderReport(result, summarise(result, { ...(baselineFile !== undefined ? { baseline: readRun(baselineFile) } : {}), rates }), { name: `REPORT-${result.at.slice(0, 10)}` }));
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

const COMMANDS = { run, plan, report, trend, "build-corpus": buildCorpusCommand };

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
