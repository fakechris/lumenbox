#!/usr/bin/env node
/**
 * The architecture ratchet (INV-1225, after SPACE's architecture-baseline): what is already
 * too big or in the wrong place is written down once, and from then on may only shrink.
 *
 * Two rules, both data in `arch-baseline.json`:
 *
 *   - **size**: a production `.ts` file is at most `limit` lines (1000). Files already over it
 *     are listed with their current length as their own ceiling; a listed file may get shorter,
 *     never longer, and leaves the list when it fits again.
 *   - **env**: `process.env` is read only in the configuration and startup layers (`allowed`).
 *     Files reading it elsewhere are listed; a listed file may stop, never a new one start.
 *
 * Three ways to fail: a new violation; a baseline entry added or a ceiling raised (checked
 * against the merge base's copy when git can show one); an entry that no longer violates and
 * was not removed. `--write-baseline` lowers and removes, never adds; `--init` writes the first
 * baseline for a repository adopting the ratchet and is not for anything else.
 *
 *   node scripts/arch-ratchet.mjs                  check
 *   node scripts/arch-ratchet.mjs --write-baseline  lower ceilings / drop entries that now pass
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEFAULT_LIMIT = 1000;
export const BASELINE_FILE = "arch-baseline.json";
const PRODUCTION = /\.ts$/;
const EXCLUDED = [/\.test\.ts$/, /\.sweep\.ts$/, /(^|\/)testing\//, /(^|\/)fixtures\//, /\.d\.ts$/];
const ENV_READ = /\bprocess\.env\b/;

/** Every production source file under `root/src`, with what the two rules measure. */
export function scan(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(root, path).split(sep).join("/");
      if (!PRODUCTION.test(rel) || EXCLUDED.some(pattern => pattern.test(rel))) continue;
      const text = readFileSync(path, "utf8");
      files.push({ path: rel, lines: text.split("\n").length, readsEnv: ENV_READ.test(text) });
    }
  };
  walk(join(root, "src"));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The problems, as sentences. `previous` is the baseline at the merge base, when known: a
 * ceiling above it or an entry it did not have is the ratchet turning the wrong way.
 */
export function verify(baseline, files, previous) {
  const problems = [];
  const limit = baseline.size?.limit ?? DEFAULT_LIMIT;
  const ceilings = baseline.size?.files ?? {};
  const allowed = new Set(baseline.env?.allowed ?? []);
  const envListed = new Set(baseline.env?.files ?? []);
  const byPath = new Map(files.map(file => [file.path, file]));

  for (const file of files) {
    const ceiling = ceilings[file.path];
    if (ceiling !== undefined) {
      if (file.lines > ceiling) problems.push(`${file.path} is ${file.lines} lines, over its ceiling of ${ceiling}: it may only get shorter`);
    } else if (file.lines > limit) {
      problems.push(`${file.path} is ${file.lines} lines, over the ${limit}-line limit, and is not in the baseline: split it (the baseline never gains entries)`);
    }
    if (file.readsEnv && !allowed.has(file.path) && !envListed.has(file.path)) {
      problems.push(`${file.path} reads process.env outside the configuration and startup layers (${[...allowed].join(", ")}): take the value as a parameter`);
    }
  }
  for (const [path, ceiling] of Object.entries(ceilings)) {
    const file = byPath.get(path);
    if (file === undefined) problems.push(`baseline lists ${path} (${ceiling} lines) but the file is gone: remove the entry`);
    else if (file.lines <= limit) problems.push(`${path} is ${file.lines} lines, within the limit: remove its baseline entry (stale entries hide regressions)`);
  }
  for (const path of envListed) {
    const file = byPath.get(path);
    if (file === undefined) problems.push(`baseline lists ${path} as an env reader but the file is gone: remove the entry`);
    else if (!file.readsEnv) problems.push(`${path} no longer reads process.env: remove its baseline entry`);
    else if (allowed.has(path)) problems.push(`${path} is both allowed and listed as a violation: keep one`);
  }
  if (previous !== undefined) {
    const before = previous.size?.files ?? {};
    for (const [path, ceiling] of Object.entries(ceilings)) {
      if (before[path] === undefined) problems.push(`baseline gained ${path}: the ratchet only turns one way (the file must fit the limit instead)`);
      else if (ceiling > before[path]) problems.push(`${path}'s ceiling rose from ${before[path]} to ${ceiling}: ceilings only come down`);
    }
    if ((previous.size?.limit ?? DEFAULT_LIMIT) < limit) problems.push(`the size limit rose from ${previous.size?.limit ?? DEFAULT_LIMIT} to ${limit}`);
    const beforeEnv = new Set(previous.env?.files ?? []);
    for (const path of envListed) if (!beforeEnv.has(path)) problems.push(`baseline gained ${path} as an env reader: the ratchet only turns one way`);
    const beforeAllowed = new Set(previous.env?.allowed ?? []);
    for (const path of allowed) if (!beforeAllowed.has(path)) problems.push(`${path} was added to the env-reading layers: that list is the rule, not a baseline — change it on purpose, in its own commit, and say why`);
  }
  return problems;
}

/** The baseline the current tree earns: each over-limit file at its own length, each env reader outside the layers listed. */
export function earned(baseline, files) {
  const limit = baseline.size?.limit ?? DEFAULT_LIMIT;
  const allowed = new Set(baseline.env?.allowed ?? []);
  return {
    size: { limit, files: Object.fromEntries(files.filter(file => file.lines > limit).map(file => [file.path, file.lines])) },
    env: { allowed: [...allowed], files: files.filter(file => file.readsEnv && !allowed.has(file.path)).map(file => file.path) },
  };
}

/** Lowers ceilings and drops entries that now pass; never adds — that is what `--init` is for, once. */
export function lowered(baseline, files) {
  const now = earned(baseline, files);
  const ceilings = baseline.size?.files ?? {};
  const kept = {};
  for (const [path, ceiling] of Object.entries(ceilings)) {
    if (now.size.files[path] !== undefined) kept[path] = Math.min(ceiling, now.size.files[path]);
  }
  const envKept = (baseline.env?.files ?? []).filter(path => now.env.files.includes(path));
  return { size: { limit: now.size.limit, files: kept }, env: { allowed: now.env.allowed, files: envKept } };
}

function previousBaseline(root) {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const text = execFileSync("git", ["show", `${base}:${BASELINE_FILE}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const args = new Set(process.argv.slice(2));
  const files = scan(root);
  const path = join(root, BASELINE_FILE);
  if (args.has("--init")) {
    const seed = { size: { limit: DEFAULT_LIMIT }, env: { allowed: ["src/config.ts", "src/cli.ts", "src/boxd/main.ts", "src/control/main.ts"] } };
    writeFileSync(path, `${JSON.stringify(earned(seed, files), null, 2)}\n`);
    console.log(`[arch] wrote the first ${BASELINE_FILE}`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  if (args.has("--write-baseline")) {
    const next = lowered(baseline, files);
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[arch] ${BASELINE_FILE}: ${Object.keys(next.size.files).length} oversized file(s), ${next.env.files.length} env reader(s) outside the layers (lowered or removed only)`);
    process.exit(0);
  }
  const previous = previousBaseline(root);
  const problems = verify(baseline, files, previous);
  if (problems.length > 0) {
    console.error(`[arch] ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const over = Object.keys(baseline.size?.files ?? {}).length;
  console.log(`[arch] ok: ${files.length} production files; ${over} over the limit and held at their ceilings; ${(baseline.env?.files ?? []).length} env reader(s) held outside the layers${previous === undefined ? " (no merge base to compare the baseline with)" : ""}`);
}
