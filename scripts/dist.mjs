/**
 * electron-builder, plus what the artifact cannot do by itself: say which commit it was built
 * from, and get its dmgs notarized.
 *
 * The packaged app carries no .git, so build-info.ts's rev-parse answers "unknown" on every
 * user machine — the page's own version line went blind the moment an app left the machine
 * that built it (seen on 0.3.1's first run, INV-876). The wrapper stamps the short SHA into
 * the packaged package.json as buildCommit, which build-info reads before it ever reaches
 * for git. No git here (a CI tarball, an exported tree): the stamp is skipped and the app
 * falls back to "unknown", which is what it said before this wrapper existed.
 *
 * Notarization (INV-1450): electron-builder notarizes and staples each .app when Apple
 * credentials are in the environment, and skips with one warning line when they are not —
 * every release through 0.3.8 went out that way and was blocked on first open. It does not
 * notarize the dmg. So on --mac this wrapper says plainly, first and last, whether the build
 * is notarized, and with credentials submits each new dmg to the notary service and staples
 * the ticket. release:check refuses anything not notarized; SHA256SUMS is made after this,
 * since stapling changes the dmg.
 *
 * Signing identity (INV-2309): when the shell running electron-builder cannot reach the Developer
 * ID certificate in the keychain, it signs ad-hoc with one warning line and the build succeeds —
 * 0.4.12 was published that way and every download opened as "damaged". So after a --mac build
 * this wrapper reads every built app with codesign (scripts/signature.mjs) and fails unless all are
 * Developer-ID signed by the project's team. DIST_SKIP_SIGNING_CHECK=1 lets a local build that will
 * never be published through, and says so first and last; release:check refuses it either way.
 *
 * Usage: node scripts/dist.mjs --mac | --win | --linux | --dir   (args pass through)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macArtifacts } from "./notarization.mjs";
import { DEVELOPER_ID_TEAM, developerIdProblems, signingRefusal } from "./signature.mjs";

/**
 * notarytool's credential arguments from the same variables electron-builder reads, or
 * undefined. A keychain profile is preferred: the secret stays in the keychain.
 */
export function notaryCredentials(env) {
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : [])];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  return undefined;
}

/** The status notarytool reported for a finished submission ("Accepted", "Invalid", …). */
export function submissionStatus(output) {
  return /^\s*status:\s*(.+)$/im.exec(output)?.[1]?.trim();
}

const UNNOTARIZED =
  "[dist] NOT NOTARIZED: no Apple credentials (APPLE_KEYCHAIN_PROFILE, see docs/27). This build is " +
  "fine on this machine, but a browser download of it is blocked on first open, and release:check refuses it.";

const UNCHECKED_SIGNATURE =
  `[dist] SIGNING NOT CHECKED: DIST_SKIP_SIGNING_CHECK=1. This build may be ad-hoc signed; it is for this machine only. ` +
  "A download of an ad-hoc app opens as \"damaged\", and release:check refuses it.";

/**
 * Whether the --mac build just made may stand: undefined when every app is Developer-ID signed, the
 * refusal otherwise. With DIST_SKIP_SIGNING_CHECK=1 nothing is read. `read` is the seam the tests fake.
 */
export function signingFailure(env, distDir, version, read = developerIdProblems) {
  if (env.DIST_SKIP_SIGNING_CHECK === "1") return undefined;
  const artifacts = macArtifacts(distDir, version);
  if (artifacts.length === 0) return `[dist] NOT SIGNED AS A RELEASE: no LumenBox ${version} app or dmg in ${distDir} to read the signature of.`;
  const found = read(artifacts, distDir);
  if (found.problems.length === 0) return undefined;
  return `[dist] NOT SIGNED WITH THE DEVELOPER ID of team ${DEVELOPER_ID_TEAM}: ${signingRefusal(found)} ` +
    "This build is not a release. Fix the signing and rebuild, or set DIST_SKIP_SIGNING_CHECK=1 for a build that will never be published.";
}

function notarizeDmgs(distDir, version, credentials) {
  const dmgs = readdirSync(distDir).filter(name => name.startsWith(`LumenBox-${version}`) && name.endsWith(".dmg"));
  for (const name of dmgs) {
    const path = join(distDir, name);
    console.log(`[dist] notarizing ${name} (this waits for Apple, usually minutes)`);
    let output;
    try {
      output = execFileSync("xcrun", ["notarytool", "submit", path, ...credentials, "--wait"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3_600_000 });
    } catch (error) {
      // The credentials are arguments; the error message would repeat them, the output does not.
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const status = submissionStatus(output);
    if (status !== "Accepted") {
      const id = /^\s*id:\s*(\S+)/im.exec(output)?.[1];
      throw new Error(`${name}: the notary service answered ${status ?? "nothing usable"}${id ? `; see xcrun notarytool log ${id} with the same credentials` : ""}`);
    }
    execFileSync("xcrun", ["stapler", "staple", path], { stdio: "inherit" });
    console.log(`[dist] ${name} notarized and stapled`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Stamp skipped; see above.
  }

  const args = process.argv.slice(2);
  const mac = args.includes("--mac");
  const credentials = notaryCredentials(process.env);
  const skipSigning = process.env.DIST_SKIP_SIGNING_CHECK === "1";
  if (mac && skipSigning) console.warn(UNCHECKED_SIGNATURE);
  if (mac && credentials === undefined) console.warn(UNNOTARIZED);
  if (commit !== "") args.push(`-c.extraMetadata.buildCommit=${commit}`);
  execFileSync("electron-builder", args, { stdio: "inherit" });

  if (mac) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Where electron-builder just wrote — its -c override if given — not AGENTBOX_DIST_DIR (that points release:check at a candidate).
    const override = args.find(arg => arg.startsWith("-c.directories.output="))?.split("=")[1];
    const distDir = resolve(root, override ?? manifest.build?.directories?.output ?? "dist");
    // Before notarizing: Apple refuses an ad-hoc app anyway, after a wait, with a less useful answer.
    const failure = signingFailure(process.env, distDir, manifest.version);
    if (failure !== undefined) {
      console.error(failure);
      process.exit(1);
    }
    if (credentials === undefined) console.warn(UNNOTARIZED);
    else notarizeDmgs(distDir, manifest.version, credentials);
    if (skipSigning) console.warn(UNCHECKED_SIGNATURE);
    else console.log(`[dist] every app is signed with the Developer ID of team ${DEVELOPER_ID_TEAM}`);
  }
}
