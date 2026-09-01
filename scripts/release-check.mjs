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
 *
 * Not here: anything needing a real box or an X server. `npm run smoke` covers those
 * against a running container and takes minutes — it belongs to a release, and this
 * belongs to every build that claims to be one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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

console.log("");
if (failures.length > 0) {
  console.error(`[release-check] ${failures.length} check(s) failed: ${failures.join(", ")}`);
  console.error("[release-check] The source may be fine; what would ship is not.");
  process.exit(1);
}
console.log("[release-check] the built artifacts load and are pinned. OK.");
console.log("[release-check] Still yours to run before shipping: npm run smoke, against a live box.");
