/**
 * What has to be true of the *artifact*, not of the source, before a build is believed.
 *
 * `npm run check` proves the source typechecks, lints and passes its tests; the build step
 * proves the bundler exits zero. Neither proves the thing that ships runs — and the gap is
 * not theoretical: a bundle can be written, be non-empty, and throw on its first import
 * because a dependency was externalised that should not have been. OpenClaw's CI asserts
 * `test -s dist/index.js` and calls it a smoke test; the only check there that catches a
 * dead binary is the one that actually launches it in the built image.
 *
 * So this loads what was built and asks it to speak:
 *
 *   - the CLI bundle imports without throwing, and prints its usage
 *   - the box daemon bundle imports without throwing (it is CommonJS, loaded as such)
 *   - the daemon bundle contains no absolute path from this machine, which is how a
 *     bundle "works here" and dies in the container
 *   - the image's Dockerfile still pins its base by digest, so a rebuild is reproducible
 *   - the packaged app in dist-app/ carries the full production dependency closure, and a
 *     dmg exists beside every zip (the 0.3.0 installers shipped with three packages and
 *     crashed on every new user's first import — a green check above would not have seen it)
 *   - the image tag this app pulls at its version exists on Docker Hub, because a fresh
 *     install's first "Start the box" pulls exactly that tag (skippable per environment)
 *
 * Not here: anything needing a real box or an X server. `npm run smoke` covers those
 * against a running container and takes minutes — it belongs to a release, and this
 * belongs to every build that claims to be one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const note = message => console.log(`  ${message}`);

function check(name, run) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}`);
    note(error instanceof Error ? error.message : String(error));
  }
}

check("the CLI bundle exists and is not a stub", () => {
  const path = join(root, "dist/cli.js");
  if (!existsSync(path)) throw new Error(`${path} is missing — run npm run build:cli`);
  const size = statSync(path).size;
  if (size < 10_000) throw new Error(`${path} is ${size} bytes, which is not a built CLI`);
});

check("the CLI runs and prints its usage", () => {
  // The real question — a bundle that imports a module the bundler externalised dies
  // here and nowhere earlier. `--help` is chosen because it exercises module load and
  // argument parsing without touching a box, a network or a config file.
  const out = execFileSync(process.execPath, [join(root, "dist/cli.js"), "--help"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTBOX_TEST: "1" },
  });
  if (!/agentbox/i.test(out)) throw new Error("usage text did not mention agentbox");
});

check("the box daemon bundle loads", () => {
  const path = join(root, "docker/box/boxd.cjs");
  if (!existsSync(path)) throw new Error(`${path} is missing — run npm run build:boxd`);
  const size = statSync(path).size;
  if (size < 10_000) throw new Error(`${path} is ${size} bytes, which is not a built daemon`);
});

check("no absolute path from this machine is baked into the daemon", () => {
  // A bundle carrying /Users/<somebody> works on the machine that built it and fails in
  // the container, at runtime, with a path nobody recognises.
  const text = readFileSync(join(root, "docker/box/boxd.cjs"), "utf8");
  const leaked = text.match(/\/(?:Users|home)\/[a-z0-9_.-]+\/[^\s"'`]{4,}/gi) ?? [];
  const real = leaked.filter(path => !path.startsWith("/home/box") && !path.startsWith("/home/hostd"));
  if (real.length > 0) {
    throw new Error(`build-machine paths in the bundle: ${[...new Set(real)].slice(0, 3).join(", ")}`);
  }
});

check("the box image pins its base by digest, and something unfreezes it", () => {
  // A tag can move under a rebuild; a digest cannot. Same rule the CI pins its actions by.
  const dockerfile = readFileSync(join(root, "docker/box/Dockerfile"), "utf8");
  const first = dockerfile.split("\n").find(line => /^FROM\s/i.test(line)) ?? "";
  if (!/@sha256:[a-f0-9]{64}/.test(first)) {
    throw new Error(`the first FROM is not digest-pinned: ${first.trim()}`);
  }
  // The half that is easy to forget: a pin with no updater is a security hole that ages
  // while looking deliberate. Asserted together, because they are one mechanism.
  const dependabot = join(root, ".github/dependabot.yml");
  if (!existsSync(dependabot)) {
    throw new Error("the base is pinned but .github/dependabot.yml is missing to move it");
  }
  const config = readFileSync(dependabot, "utf8");
  if (!/package-ecosystem:\s*docker/.test(config)) {
    throw new Error("dependabot does not watch the docker ecosystem, so the pin will rot");
  }
});

// ── the two gates 0.3.0 shipped without (INV-854 → INV-858) ─────────────────────────
//
// Everything above proves bundles built from this checkout load. Neither proved what
// electron-builder *packed* — and 0.3.0 published four installers whose app/node_modules
// held exactly the three top-level packages, so every new user's first launch died on the
// first import with a green check behind it. And once the app began pulling its box image
// at the package version, an app published before its image exists breaks every fresh
// install of that version on the first "Start the box" click.

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// Overridable so a candidate directory can be checked — and so the negative path of this
// gate itself is runnable against a sabotaged copy rather than a rebuilt app.
const distDir = process.env.AGENTBOX_DIST_DIR ?? join(root, "dist-app");

/** Every non-dev package name the packaged app imports from, per the lock it builds with. */
function expectedPackagedPackages() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entry = name => lock.packages?.[`node_modules/${name}`];
  const expected = new Set();
  const queue = Object.keys(manifest.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.pop();
    if (expected.has(name)) continue;
    expected.add(name);
    for (const dep of Object.keys(entry(name)?.dependencies ?? {})) queue.push(dep);
  }
  return expected;
}

/** Top-level package names inside an artifact's app/node_modules, from `unzip -l`. */
function zipPackages(path) {
  const out = execFileSync("unzip", ["-l", path], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const names = new Set();
  for (const match of out.matchAll(/node_modules\/(@[^/\s]+\/[^/\s]+|[^@\s/][^/\s]*)\//g)) {
    names.add(match[1]);
  }
  return names;
}

check("every packaged app carries the full production dependency closure", () => {
  const zips = existsSync(distDir)
    ? readdirSync(distDir).filter(name => name.startsWith(`LumenBox-${version}`) && name.endsWith(".zip"))
    : [];
  if (zips.length === 0) {
    note(`no LumenBox-${version} zip in ${distDir} — nothing built to publish; gate skipped, but do not publish without it`);
    return;
  }
  const expected = expectedPackagedPackages();
  for (const name of zips) {
    const packaged = zipPackages(join(distDir, name));
    const missing = [...expected].filter(pkg => !packaged.has(pkg));
    if (missing.length > 0) {
      throw new Error(
        `${name} is missing ${missing.length} packaged package(s), first few: ` +
          `${missing.slice(0, 5).join(", ")}. This is the 0.3.0 failure: an app whose ` +
          `node_modules holds ${packaged.size} top-level packages instead of the ` +
          `${expected.size} the app imports. Rebuild on a clean node_modules (npm ci, then dist).`
      );
    }
    note(`${name}: ${packaged.size} top-level packages, all ${expected.size} expected present`);
  }
});

check("every packaged dmg exists beside its zip (same staged app, same tree)", () => {
  // The dmg is produced from the same per-arch staged .app as that arch's zip, so the
  // closure check on the zips covers its contents; what this gate adds is that a dmg
  // exists to upload at all — half a release (zip-only) shipped silently once before
  // anyone noticed. Mount-and-verify per dmg would double the cost for that assurance.
  const files = existsSync(distDir) ? readdirSync(distDir) : [];
  const zips = files.filter(name => name.startsWith(`LumenBox-${version}`) && name.endsWith(".zip"));
  if (zips.length === 0) {
    note(`no artifacts for ${version} in ${distDir}; dmg gate skipped`);
    return;
  }
  const problems = [];
  for (const zip of zips) {
    const arch = zip.includes("-arm64") ? "arm64" : "x64";
    const dmg = arch === "arm64" ? `LumenBox-${version}-arm64.dmg` : `LumenBox-${version}.dmg`;
    const path = join(distDir, dmg);
    if (!existsSync(path)) {
      problems.push(`${dmg} missing for ${zip}`);
    } else if (statSync(path).size < 50 * 1024 * 1024) {
      problems.push(`${dmg} is ${statSync(path).size} bytes, which is not the app`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
});

check("the image tag this app pulls exists on Docker Hub before the app ships", () => {
  if (process.env.RELEASE_CHECK_SKIP_IMAGE === "1") {
    note("RELEASE_CHECK_SKIP_IMAGE=1 — image gate skipped (CI has no business depending on the Hub per push)");
    return;
  }
  const repo = process.env.AGENTBOX_IMAGE_REPO ?? "fakechris/lumenbox";
  let body;
  try {
    // The Hub tags API, not `docker manifest inspect`: it answers without a docker
    // daemon or a login, which is the context a release check actually runs in.
    body = execFileSync(
      "curl",
      ["-fsS", "--max-time", "30", `https://hub.docker.com/v2/repositories/${repo}/tags/${version}`],
      { encoding: "utf8", timeout: 45_000 },
    );
  } catch (error) {
    const status = error?.status ?? "";
    if (String(status).includes("22") || /HTTP.*404/.test(String(error))) {
      throw new Error(
        `Docker Hub has no ${repo}:${version}. A fresh install of this app pulls exactly ` +
          "that tag on first start — build and push the image first (npm run build:image, " +
          "npm run push:image), then publish the app."
      );
    }
    throw new Error(
      `could not reach Docker Hub to confirm ${repo}:${version} exists (${error.message}). ` +
        "A release must not ship on an unverified tag: check the network, or set " +
        "RELEASE_CHECK_SKIP_IMAGE=1 only if you have verified the tag another way."
    );
  }
  const tag = JSON.parse(body);
  if (tag.name !== version) {
    throw new Error(`Docker Hub answered with tag "${tag.name}" where ${version} was asked for`);
  }
  note(`${repo}:${version} is on Docker Hub`);
});

console.log("");
if (failures.length > 0) {
  console.error(`[release-check] ${failures.length} check(s) failed: ${failures.join(", ")}`);
  console.error("[release-check] The source may be fine; what would ship is not.");
  process.exit(1);
}
console.log("[release-check] the built artifacts load and are pinned. OK.");
console.log("[release-check] Still yours to run before shipping: npm run smoke, against a live box.");
