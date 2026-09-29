/**
 * electron-builder, plus the one thing the artifact cannot know by itself: which commit it
 * was built from.
 *
 * The packaged app carries no .git, so build-info.ts's rev-parse answers "unknown" on every
 * user machine — the page's own version line went blind the moment an app left the machine
 * that built it (seen on 0.3.1's first run, INV-876). The wrapper stamps the short SHA into
 * the packaged package.json as buildCommit, which build-info reads before it ever reaches
 * for git. No git here (a CI tarball, an exported tree): the stamp is skipped and the app
 * falls back to "unknown", which is what it said before this wrapper existed.
 *
 * Usage: node scripts/dist.mjs --mac | --win | --linux | --dir   (args pass through)
 */
import { execFileSync } from "node:child_process";

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
if (commit !== "") args.push(`-c.extraMetadata.buildCommit=${commit}`);
execFileSync("electron-builder", args, { stdio: "inherit" });
