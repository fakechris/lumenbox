/**
 * Whether a macOS app is signed with this project's Developer ID (INV-2309).
 *
 * 0.4.12 shipped four installers that were ad-hoc signed (`Signature=adhoc`,
 * `TeamIdentifier=not set`) with no sealed resources, and every download opened as "LumenBox is
 * damaged and can't be opened". Nothing refused them: the only signature reading in
 * release:check was inside the notarization gate, which the publishing machine always skips
 * (`RELEASE_CHECK_SKIP_NOTARIZE=1`, it has no notary credentials), and electron-builder falls back
 * to ad-hoc signing with one warning line when the shell that runs it cannot reach the Developer
 * ID certificate in the keychain.
 *
 * So this check stands on its own and nothing skips it: for every staged app and the app inside
 * every dmg, `codesign --verify --deep --strict` must pass, and `codesign -dv` must name a
 * `Developer ID Application` authority and this project's team. release:check and dist.mjs both
 * run it. The verdict is pure, so it is tested on what codesign prints, captured from the 0.4.12
 * build and from a correctly signed app.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Apple team every LumenBox release is signed by. A constant, not read from package.json:
 * `build.mac` names no identity or team (electron-builder finds the identity in the keychain),
 * and adding one there would change how the build signs, which is not what this check is for.
 */
export const DEVELOPER_ID_TEAM = "A69VRB2X6U";

/** Why a build ends up signed the way it was refused for, one sentence per kind of finding. */
export const CAUSES = {
  keychain:
    "the build could not reach the Developer ID Application certificate in the keychain, so electron-builder signed ad-hoc " +
    "(or not at all) with one warning line — run `security find-identity -v -p codesigning` in the shell that builds, unlock the login keychain, rebuild",
  identity: "electron-builder picked another identity from the keychain or from CSC_NAME / CSC_LINK — point it at the project's Developer ID and rebuild",
  invalid: "the bundle was signed incompletely or changed after signing — rebuild it; never edit a signed app",
};

/**
 * The verdict on one app from codesign's two answers, each { code, output } (exit code and
 * stdout+stderr together): `verify` from `codesign --verify --deep --strict`, `describe` from
 * `codesign -dv --verbose=2`. `problems` says what was found; `causes` are keys of CAUSES.
 */
export function signatureVerdict(verify, describe, team = DEVELOPER_ID_TEAM) {
  const problems = [];
  const causes = new Set();
  const text = describe.output;
  const teamId = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim();
  if (describe.code !== 0) {
    problems.push(`not signed (codesign -dv: "${firstLine(text)}")`);
    causes.add("keychain");
  } else {
    if (/^Signature=adhoc$/m.test(text) || authority === undefined) {
      problems.push(`ad-hoc signed (Signature=adhoc, TeamIdentifier=${teamId ?? "not set"}), not Developer ID`);
      causes.add("keychain");
    } else if (!/^Developer ID Application: /.test(authority)) {
      problems.push(`signed by "${authority}", which is not a Developer ID Application certificate`);
      causes.add("identity");
    } else if (teamId !== team) {
      problems.push(`signed by team ${teamId ?? "not set"} ("${authority}"), not ${team}`);
      causes.add("identity");
    }
    if (verify.code !== 0) {
      problems.push(`invalid (codesign --verify --deep --strict: "${firstLine(verify.output)}")`);
      causes.add("invalid");
    }
  }
  return { ok: problems.length === 0, problems, causes: [...causes] };
}

/** The first line a tool printed, without the path it prefixes its complaint with. */
function firstLine(text) {
  const line = text.split("\n").map(each => each.trim()).filter(each => each !== "")[0] ?? "no output";
  return line.replace(/^\/\S*: /, "");
}

/** Runs a tool and returns { code, output } with stdout and stderr together; codesign answers on stderr. */
export function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return { code: 1, output: `${command} could not run: ${result.error.message} (macOS signatures can only be read on macOS)` };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function readApp(app, run, team) {
  const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
  const describe = run("codesign", ["-dv", "--verbose=2", app]);
  return signatureVerdict(verify, describe, team);
}

/**
 * What was found, one string each and named by artifact, and the likely causes (keys of CAUSES), of every artifact from macArtifacts():
 * a staged app is read where it is; a dmg is mounted read-only, its LumenBox.app read, and
 * detached. `run` is the seam the tests fake. No problems means every app is Developer-ID signed.
 */
export function developerIdProblems(artifacts, distDir, { run = runTool, team = DEVELOPER_ID_TEAM, mountRoot = tmpdir() } = {}) {
  const problems = [];
  const causes = new Set();
  const read = (app, label) => {
    const verdict = readApp(app, run, team);
    for (const problem of verdict.problems) problems.push(`${label}: ${problem}`);
    for (const cause of verdict.causes) causes.add(cause);
  };
  for (const artifact of artifacts) {
    const name = artifact.path.startsWith(`${distDir}/`) ? artifact.path.slice(distDir.length + 1) : artifact.path;
    if (artifact.kind === "app") {
      read(artifact.path, name);
      continue;
    }
    const mount = mkdtempSync(join(mountRoot, "lumenbox-dmg-"));
    const attached = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, artifact.path]);
    if (attached.code !== 0) {
      // hdiutil prints progress first and its complaint last.
      const complaint = attached.output.split("\n").map(line => line.trim()).filter(line => line !== "").at(-1) ?? "no output";
      problems.push(`${name}: could not be mounted read-only to read its app (${complaint}); a dmg still being written or stapled fails this too`);
      removeMountPoint(mount);
      continue;
    }
    try {
      const app = join(mount, "LumenBox.app");
      if (!existsSync(app)) problems.push(`${name}: holds no LumenBox.app`);
      else read(app, `${name} (its LumenBox.app)`);
    } finally {
      const detached = run("hdiutil", ["detach", mount]);
      if (detached.code !== 0) run("hdiutil", ["detach", "-force", mount]);
      removeMountPoint(mount);
    }
  }
  return { problems, causes: [...causes] };
}

/** Only the empty directory this made to mount on: rmdir refuses one that is not empty, so a stuck mount is left alone. */
function removeMountPoint(mount) {
  try {
    rmdirSync(mount);
  } catch {
    // Still mounted after a forced detach; an empty temp directory is all that is left behind.
  }
}

/** The refusal both release:check and dist.mjs print: what was found, then the likely cause of each kind once. */
export function signingRefusal({ problems, causes }) {
  const why = causes.length > 0 ? ` Likely cause: ${causes.map(cause => CAUSES[cause]).join(". Also: ")}.` : "";
  return `${problems.join("; ")}.${why}`;
}
