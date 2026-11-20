#!/usr/bin/env node
/**
 * The prompt ratchet (INV-1857): what every request carries is written down once, and from then
 * on may only shrink.
 *
 * The architecture ratchet (arch-ratchet.mjs) counts source lines. This counts what those lines
 * become: the bytes an agent is sent before the person has said a word. A rule added to the
 * prompt or a sentence added to a tool's description is paid on every turn of every agent, and
 * nothing made anyone look at the total — each change reported its own size by hand, or did not.
 *
 * For each configuration in `CONFIGURATIONS`, `prompt-baseline.json` holds three numbers, read
 * off a real turn's first request (src/evals/surface.ts — the one place the surface is read):
 *
 *   - **stable**: the half of the system prompt before the cache breakpoint;
 *   - **volatile**: the half after it, with no memory and no tasks — its floor;
 *   - **tools**: the tool list as JSON, names, descriptions and input schemas.
 *
 * A number over its ceiling fails. A number under it passes, and `--write-baseline` brings the
 * ceiling down to it; it never raises one and never adds a configuration. Unlike a file's line
 * count, a prompt sometimes has to grow, so a ceiling may be raised — by hand, in this file, in
 * the pull request that needs it, which says why. The failure names the number and its new value.
 *
 * The file is a sibling of `arch-baseline.json` rather than a section of it: those entries never
 * rise and these may, and a pull request that conflicts on one should not have to read the other.
 * One number to a line, so two pull requests that both move a number conflict on that line only.
 *
 *   node scripts/prompt-ratchet.mjs                    check (run by `npm run arch`)
 *   node scripts/prompt-ratchet.mjs --write-baseline   lower ceilings to what is measured
 *   node scripts/prompt-ratchet.mjs --hint <base-ref>  what a pull request is reminded of; never fails
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hermeticEnv } from "./test-env.mjs";

export const BASELINE_FILE = "prompt-baseline.json";
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The agents measured, as surface.ts describes one. Few on purpose: each is a list a real turn is
 * given that the others do not cover. Names are chosen so the agent read is the first by name.
 */
export const CONFIGURATIONS = {
  /** One agent with the starter skills, a person waiting: the turn most requests are. */
  single: {},
  /** The same agent with a teammate: the roster and what is said about working with one. */
  "team-member": { team: [{ name: "Nova" }, { name: "Vera", description: "Reviews what Nova writes." }] },
  /** With a desktop: the browser tools as a box with a screen is offered them — the longest tool list. */
  desktop: { display: 0 },
  /** A turn nobody is waiting on (a schedule's): another tool list, and the unattended conduct. */
  unattended: { unattended: true },
};

const MEASURES = { stable: "the stable half of the prompt", volatile: "the volatile half of the prompt (no memory, no tasks)", tools: "the tool list" };

/** The problems, as sentences that say what to do. `measured` and `baseline` are `{ configuration: { stable, volatile, tools } }`. */
export function verify(baseline, measured) {
  const problems = [];
  for (const [name, sizes] of Object.entries(measured)) {
    const ceilings = baseline[name];
    if (ceilings === undefined) {
      problems.push(`${BASELINE_FILE} has no entry for the configuration "${name}": add ${JSON.stringify({ [name]: sizes })} and say in the pull request why it is measured`);
      continue;
    }
    for (const [measure, what] of Object.entries(MEASURES)) {
      const now = sizes[measure];
      const ceiling = ceilings[measure];
      if (ceiling === undefined) problems.push(`${BASELINE_FILE} has no "${measure}" for "${name}": add "${measure}": ${now}`);
      else if (now > ceiling) {
        problems.push(`${name}: ${what} is ${now} bytes, ${now - ceiling} over its ceiling of ${ceiling}. Shrink it — or, if every agent should pay this on every turn, raise "${name}" → "${measure}" to ${now} in ${BASELINE_FILE} and say why in the pull request`);
      }
    }
  }
  for (const name of Object.keys(baseline)) {
    if (measured[name] === undefined) problems.push(`${BASELINE_FILE} lists "${name}", which is not a configuration in scripts/prompt-ratchet.mjs: remove the entry`);
  }
  return problems;
}

/** Every number under its ceiling, as "configuration.measure" with how far under. */
export function slack(baseline, measured) {
  const under = [];
  for (const [name, sizes] of Object.entries(measured)) {
    for (const measure of Object.keys(MEASURES)) {
      const ceiling = baseline[name]?.[measure];
      if (ceiling !== undefined && sizes[measure] < ceiling) under.push(`${name}.${measure} −${ceiling - sizes[measure]}`);
    }
  }
  return under;
}

/** Lowers each ceiling to what is measured; never raises one, never adds a configuration or a number. */
export function lowered(baseline, measured) {
  const next = {};
  for (const [name, ceilings] of Object.entries(baseline)) {
    next[name] = Object.fromEntries(Object.entries(ceilings).map(([measure, ceiling]) => [measure, Math.min(ceiling, measured[name]?.[measure] ?? ceiling)]));
  }
  return next;
}

/** The ceilings that are higher than they were, or new: what a pull request owes a reason for. */
export function raised(baseline, previous) {
  const rises = [];
  for (const [name, ceilings] of Object.entries(baseline)) {
    for (const [measure, ceiling] of Object.entries(ceilings)) {
      const before = previous[name]?.[measure];
      if (before === undefined) rises.push(`${name}.${measure} is new at ${ceiling}`);
      else if (ceiling > before) rises.push(`${name}.${measure} rose from ${before} to ${ceiling} (+${ceiling - before})`);
    }
  }
  return rises;
}

/** Files whose words a model is sent: the prompt and its parts, the tools' definitions, the starter skills, the baseline itself. */
const MODEL_FACING = [/^src\/host\/[\w-]*(prompt|tool)[\w-]*\.ts$/, /^src\/host\/starter-skills\.ts$/, /^prompt-baseline\.json$/];
const NOT_PRODUCT = /\.test\.ts$/;

/**
 * What a pull request is reminded of, from the files it changes and the ceilings it raised;
 * nothing when neither. By file name, so it is a hint: a comment edited in `tools.ts` gets it too,
 * and the answer then is one line in the description.
 */
export function evalHints(paths, rises = []) {
  const hints = [];
  const touched = paths.filter(path => MODEL_FACING.some(pattern => pattern.test(path)) && !NOT_PRODUCT.test(path));
  if (touched.length > 0) {
    hints.push(`This change touches what a model is sent (${touched.join(", ")}). If the prompt or a tool's description changed, fill in "If this changes the prompt or a tool's description" in the pull request description (.github/pull_request_template.md): the comparison page and its gate line. A hint, not a gate.`);
  }
  if (rises.length > 0) hints.push(`${BASELINE_FILE} was raised: ${rises.join("; ")}. The pull request description says why every agent should pay this on every turn.`);
  return hints;
}

/** Measures every configuration in a child process: the product is TypeScript, and must not see this shell's installation. */
function measure() {
  const run = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), "--measure"], {
    cwd: root, encoding: "utf8", env: hermeticEnv(), maxBuffer: 1 << 26,
  });
  const last = (run.stdout ?? "").trim().split("\n").pop() ?? "";
  if (run.status !== 0 || !last.startsWith("{")) throw new Error(`the prompt could not be measured (exit ${run.status}): ${(run.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`);
  return JSON.parse(last);
}

const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = join(root, BASELINE_FILE);
  if (args[0] === "--measure") {
    const { promptSurface } = await import(pathToFileURL(join(root, "src/evals/surface.ts")).href);
    const measured = {};
    for (const [name, configuration] of Object.entries(CONFIGURATIONS)) {
      const { bytes } = await promptSurface(configuration);
      measured[name] = { stable: bytes.stable, volatile: bytes.volatile, tools: bytes.tools };
    }
    console.log(JSON.stringify(measured));
  } else if (args[0] === "--hint") {
    // Never fails: a reminder that cannot be computed is a reminder not given.
    try {
      const base = args[1] ?? "origin/main";
      const paths = git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(line => line !== "");
      let before;
      try { before = JSON.parse(git(["show", `${base}:${BASELINE_FILE}`])); } catch { before = undefined; }
      const rises = before === undefined ? [] : raised(JSON.parse(readFileSync(path, "utf8")), before);
      const hints = evalHints(paths, rises);
      for (const hint of hints) console.log(process.env.GITHUB_ACTIONS === "true" ? `::notice title=prompt and tools::${hint}` : `[prompt] ${hint}`);
      if (hints.length === 0) console.log("[prompt] nothing a model is sent was touched");
    } catch (error) {
      console.log(`[prompt] no hint: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  } else {
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    const measured = measure();
    if (args.includes("--write-baseline")) {
      writeFileSync(path, `${JSON.stringify(lowered(baseline, measured), null, 2)}\n`);
      const left = verify(lowered(baseline, measured), measured);
      console.log(`[prompt] ${BASELINE_FILE}: ceilings lowered to what is measured, none raised`);
      if (left.length > 0) {
        console.error(`[prompt] --write-baseline only lowers; ${left.length} problem(s) are left to a person:\n  ${left.join("\n  ")}`);
        process.exitCode = 1;
      }
    } else {
      const problems = verify(baseline, measured);
      if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      } else {
        const under = slack(baseline, measured);
        const total = Object.values(measured).reduce((sum, sizes) => sum + sizes.stable + sizes.volatile + sizes.tools, 0);
        console.log(`[prompt] ok: ${Object.keys(measured).length} configurations, ${total} bytes of prompt and tools held at their ceilings${under.length > 0 ? `; under them: ${under.join(", ")} — run \`npm run arch -- --write-baseline\` to keep it` : ""}`);
      }
    }
  }
}
