#!/usr/bin/env node
/**
 * Writes the release scorecard (INV-130, src/host/scorecard.ts) for this checkout.
 *
 *   npm run release:check                      … && scorecard --checked: tests and artifact
 *                                              already ran in this invocation; model SKIPPED
 *                                              unless --scenario is given. Exit 0 unless FAIL/REVIEW.
 *   npm run release:scorecard                  the standalone gate: runs the tests and the
 *                                              artifact check itself; exit 0 PASS, 1 FAIL,
 *                                              2 INCOMPLETE, 3 REVIEW.
 *     --scenario out.json                      results from `npm run scenario -- --json out.json`
 *     --baseline <scorecard.json>              compare model results with a previous card
 *     --accept "<scenario/check>=<name>"       a named reviewer accepts that regression (repeatable)
 *     --skip-tests / --skip-artifact           leave a section SKIPPED (the card says so)
 *     --inject-failure                         prove the gate closes (A3): always FAIL, exit 1
 *     --out <file>                             where to write; default ~/.agentbox/scorecards/
 *
 * Credentials are never read here: the model section comes from a file the operator
 * produced under their own authorisation, or it is SKIPPED and said.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const has = name => args.includes(name);
const value = name => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const values = name => args.flatMap((arg, at) => (arg === name && args[at + 1] !== undefined ? [args[at + 1]] : []));

const { buildScorecard, describeScorecard, exitCodeFor } = await import("../src/host/scorecard.ts");

const startedAt = new Date().toISOString();
const git = argv => {
  try {
    return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const commit = git(["rev-parse", "--short", "HEAD"]) || "unknown";
const dirty = git(["status", "--porcelain"]) !== "";

// Deterministic: the hermetic suite, or what this invocation already proved.
let deterministic;
if (has("--checked")) deterministic = { status: "pass", note: "npm run check passed earlier in this release:check invocation" };
else if (has("--skip-tests")) deterministic = { status: "skipped", note: "--skip-tests" };
else {
  const run = spawnSync(process.execPath, [join(root, "scripts/test-floor.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, AGENTBOX_TEST: "1" } });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const floor = Number(/floor(?: is|:)? (\d+)/i.exec(out)?.[1] ?? NaN);
  deterministic = {
    status: run.status === 0 ? "pass" : "fail",
    ...(Number.isFinite(pass) ? { pass } : {}),
    ...(Number.isFinite(fail) ? { fail } : {}),
    ...(Number.isFinite(floor) ? { floor } : {}),
  };
}

// Artifact: the built bundles load and are pinned.
let artifact;
if (has("--checked")) artifact = { status: "pass", note: "release-check.mjs passed earlier in this invocation" };
else if (has("--skip-artifact")) artifact = { status: "skipped", note: "--skip-artifact" };
else {
  const run = spawnSync(process.execPath, [join(root, "scripts/release-check.mjs")], { cwd: root, encoding: "utf8" });
  const failures = [...`${run.stdout ?? ""}`.matchAll(/^FAIL (.+)$/gm)].map(m => m[1]);
  artifact = { status: run.status === 0 ? "pass" : "fail", ...(failures.length > 0 ? { failures } : {}) };
}

// Model: only from a file the operator produced; never run here, never read a credential.
const fixtureVersion = createHash("sha256").update(readFileSync(join(root, "scripts/scenario-live.mjs"))).digest("hex").slice(0, 12);
let model = { status: "skipped", reason: "no --scenario file; run `npm run scenario -- --json out.json` under authorised credentials", fixtureVersion };
const scenarioFile = value("--scenario");
if (scenarioFile !== undefined) {
  const parsed = JSON.parse(readFileSync(scenarioFile, "utf8"));
  const results = parsed.results ?? [];
  const runs = Math.max(0, ...results.map(r => Number(r.run) || 0));
  model = {
    status: "ran",
    ...(parsed.provider !== undefined ? { provider: String(parsed.provider) } : {}),
    ...(parsed.model !== undefined ? { model: String(parsed.model) } : {}),
    fixtureVersion: parsed.fixtureVersion ?? fixtureVersion,
    runs,
    results,
  };
}

let baseline;
const baselineFile = value("--baseline");
if (baselineFile !== undefined) {
  const parsed = JSON.parse(readFileSync(baselineFile, "utf8"));
  baseline = { commit: parsed.commit, model: parsed.model ?? { status: "skipped" } };
}

const acceptedRegressions = values("--accept").map(entry => {
  const [key, by] = entry.split("=");
  return { key: key ?? "", by: by ?? "unnamed" };
});

const builtAt = existsSync(join(root, "dist/cli.js")) ? statSync(join(root, "dist/cli.js")).mtime.toISOString() : undefined;
const card = buildScorecard({
  commit,
  dirty,
  node: process.version,
  ...(builtAt !== undefined ? { builtAt } : {}),
  startedAt,
  endedAt: new Date().toISOString(),
  deterministic,
  artifact,
  model,
  ...(baseline !== undefined ? { baseline } : {}),
  acceptedRegressions,
  injectFailure: has("--inject-failure"),
  knownLimitations: [
    "the model section is opt-in and costs money; three runs of a stochastic system is three runs",
    "a scorecard compares only against a baseline from the same provider, model and fixture version",
  ],
});

const outDir = join(process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox"), "scorecards");
const out = value("--out") ?? join(outDir, `${startedAt.replace(/[:.]/g, "-")}-${commit}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
for (const line of describeScorecard(card)) console.log(line);
console.log(`  written: ${out}`);

const code = exitCodeFor(card.verdict.status);
// Under release:check the model section is expected to be missing on a developer machine;
// INCOMPLETE is said on the card and in the output, and does not fail the build. The
// standalone gate is stricter, on purpose.
process.exit(has("--checked") && code === 2 ? 0 : code);
