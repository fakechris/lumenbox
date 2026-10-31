/**
 * Whether a macOS artifact will open for a person who downloaded it (INV-1450).
 *
 * Gatekeeper lets a downloaded app open only when Apple has notarized it. electron-builder
 * notarizes only when Apple credentials are in its environment, and otherwise logs one warning
 * and goes on — so every release through 0.3.8 shipped signed but unnotarized, and a browser
 * download was blocked on first open. The same shape as 0.3.7's engine-less image: a step that
 * skips itself quietly on the one machine where nobody reads the log.
 *
 * Two readings per artifact: `xcrun stapler validate` (is a ticket stapled, so it opens offline
 * too) and `spctl --assess` (does Gatekeeper accept it, and if not, the `source=` line says why).
 * The verdict is pure so it is tested on what the tools print, captured from a real 0.3.8 run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The macOS artifacts of one version in a dist directory: staged apps whose version matches, and dmgs. */
export function macArtifacts(distDir, version, readVersion = app => JSON.parse(readFileSync(join(app, "Contents", "Resources", "app", "package.json"), "utf8")).version) {
  if (!existsSync(distDir)) return [];
  const found = [];
  for (const dir of ["mac-arm64", "mac"]) {
    const app = join(distDir, dir, "LumenBox.app");
    if (!existsSync(app)) continue;
    let staged;
    try {
      staged = readVersion(app);
    } catch {
      continue;
    }
    // A staged app left from another version is not what ships with this one.
    if (staged === version) found.push({ kind: "app", path: app });
  }
  for (const name of readdirSync(distDir)) {
    if (name.startsWith(`LumenBox-${version}`) && name.endsWith(".dmg")) found.push({ kind: "dmg", path: join(distDir, name) });
  }
  return found;
}

/**
 * The verdict from the two readings. `stapler` and `spctl` are { code, output } as the tools
 * answered (exit code and stdout+stderr together).
 */
export function notarizationVerdict(stapler, spctl) {
  const problems = [];
  if (stapler.code !== 0) {
    problems.push(/does not have a ticket stapled/.test(stapler.output) ? "no notarization ticket stapled" : `stapler validate failed: ${firstLine(stapler.output)}`);
  }
  if (spctl.code !== 0 || !/: accepted/.test(spctl.output)) {
    const source = /source=(.+)/.exec(spctl.output)?.[1]?.trim();
    problems.push(`Gatekeeper rejects it${source ? ` (${source})` : ""}`);
  }
  return { ok: problems.length === 0, problems };
}

function firstLine(text) {
  return text.split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("Processing:"))[0] ?? "";
}

function run(command, args) {
  try {
    return { code: 0, output: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }) };
  } catch (error) {
    return { code: typeof error.status === "number" ? error.status : 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Reads one artifact with the real tools. macOS only. */
export function assess(artifact) {
  const stapler = run("xcrun", ["stapler", "validate", artifact.path]);
  const spctl = artifact.kind === "app"
    ? run("spctl", ["--assess", "--type", "execute", "-vv", artifact.path])
    : run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", artifact.path]);
  return notarizationVerdict(stapler, spctl);
}
