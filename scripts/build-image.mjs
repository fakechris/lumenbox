/**
 * Builds the box image so that the one it replaces is still there afterwards.
 *
 * `docker build -t fakechris/lumenbox:latest` overwrites the tag in place. The previous image
 * survives as an untagged layer until the next `docker image prune`, which is to say it
 * survives until precisely the moment somebody is tidying up because something is wrong.
 * A rollback that depends on that is not a rollback.
 *
 * So three tags on every build: a content tag naming what was built, `:latest` for the
 * usual path, and `:previous` moved to whatever `:latest` used to be. One step back is
 * enough — the failure this protects against is "the image I just built is broken", and
 * nobody rolls back four versions in an incident.
 *
 * Three names: a content hash (what was built), `fakechris/lumenbox:<package version>` (what a
 * release pulls), and `:latest` (the alias). The hash stays because the image changes on
 * every edit to a Dockerfile or a bundled daemon, not only when the package version does.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CONTEXT = "docker/box";
const REPO = process.env.AGENTBOX_IMAGE_REPO ?? "fakechris/lumenbox";
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

/** Everything in the build context, in a stable order, as one hash. */
function contextHash(dir) {
  const hash = createHash("sha256");
  const walk = current => {
    // Sorted, or the hash depends on the order the filesystem happens to return.
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // The name as well as the contents: renaming a file changes the image.
      hash.update(path);
      hash.update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
}

const docker = (args, quiet = false) => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  } catch (error) {
    if (quiet) return undefined;
    throw error;
  }
};

const tag = contextHash(CONTEXT);
const versioned = `${REPO}:${tag}`;

// Moved before the build, because after it `:latest` is the new one and what it used to
// point at is unnamed.
const outgoing = docker(["image", "inspect", "--format", "{{.Id}}", `${REPO}:latest`], true);
if (outgoing) {
  docker(["tag", `${REPO}:latest`, `${REPO}:previous`], true);
  console.log(`previous <- ${outgoing.trim().slice(7, 19)}`);
} else {
  console.log("no existing :latest, so there is nothing to roll back to yet");
}

// Preset engines ride as pinned build args (docs/25 E1): OPENCODE_VERSION in the
// environment turns the Dockerfile's dormant opencode layer on, at exactly that
// version. Unset builds stay engine-free, which is what they were.
const buildArgs = [];
for (const [variable, engine] of [
  ["OPENCODE_VERSION", "opencode"],
  ["CLAUDE_CODE_VERSION", "claude"],
  ["PI_VERSION", "pi"],
]) {
  if (process.env[variable]) {
    buildArgs.push("--build-arg", `${variable}=${process.env[variable]}`);
    console.log(`${engine} pinned at ${process.env[variable]}`);
  }
}
const release = `${REPO}:${VERSION}`;
docker(["build", ...buildArgs, "-t", versioned, "-t", release, "-t", `${REPO}:latest`, CONTEXT]);
console.log(`\nbuilt ${versioned}`);
console.log(`       ${release}`);
console.log(`       ${REPO}:latest -> ${tag}`);
console.log(`\nUpgrade with: agentbox box up --recreate`);
