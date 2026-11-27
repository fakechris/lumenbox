export const RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"];

/** Each delegated engine the image can carry, as the contract names it, with the build pin that puts it there. */
export const ENGINE_PINS = { opencode: "OPENCODE_VERSION", claude: "CLAUDE_CODE_VERSION", pi: "PI_VERSION", mcode: "MCODE_VERSION" };

/**
 * Which engines this release carries (INV-2201): `LUMENBOX_RELEASE_ENGINES`, a comma-separated
 * list of contract names, e.g. `pi` for a commercial build — Claude Code may not be
 * redistributed. Unset means all of them, which is every release so far. The build's pin check
 * and the release check both read this, so what was declared is what is built and what is checked.
 */
export function releaseEngines(env) {
  const declared = env.LUMENBOX_RELEASE_ENGINES;
  if (declared === undefined) return Object.keys(ENGINE_PINS);
  const names = [...new Set(declared.split(",").map(name => name.trim()).filter(name => name !== ""))];
  const unknown = names.filter(name => !(name in ENGINE_PINS));
  if (unknown.length) throw new Error(`LUMENBOX_RELEASE_ENGINES names ${unknown.join(", ")}, which is not an engine; the engines are ${Object.keys(ENGINE_PINS).join(", ")}`);
  if (names.length === 0) throw new Error(`LUMENBOX_RELEASE_ENGINES is empty: name the engines this release carries (${Object.keys(ENGINE_PINS).join(", ")}), or unset it for all of them`);
  return names;
}

export function engineBuildArgs(env, say = console.log) {
  const declared = releaseEngines(env);
  const args = [];
  const missing = [];
  const undeclared = [];
  for (const [engine, name] of Object.entries(ENGINE_PINS)) {
    if (!declared.includes(engine)) {
      if (env[name]) undeclared.push(`${engine} (${name})`);
      continue;
    }
    if (env[name]) {
      args.push("--build-arg", `${name}=${env[name]}`);
      say(`${name} pinned at ${env[name]}`);
    } else missing.push(name);
  }
  // Refused in any build, not only a release: the declaration and the pins disagree, and building what was pinned would put in the image the engine the declaration left out.
  if (undeclared.length) throw new Error(`LUMENBOX_RELEASE_ENGINES=${env.LUMENBOX_RELEASE_ENGINES} does not carry ${undeclared.join(", ")}, but its pin is set: unset the pin, or declare the engine`);
  if (missing.length) {
    if (env.LUMENBOX_RELEASE_IMAGE === "1") throw new Error(`LUMENBOX_RELEASE_IMAGE=1: refusing an unpinned release image; missing ${missing.join(", ")}`);
    say(`NOT in this image: ${missing.join(", ")} — a release image pins all of them.`);
  }
  if (declared.length < Object.keys(ENGINE_PINS).length) say(`This image carries ${declared.join(", ")} only (LUMENBOX_RELEASE_ENGINES).`);
  return args;
}

/**
 * Holds an image's contract to what the release declared: every declared engine present, and
 * none that was not declared. The second half is the one a single-engine build exists for — a
 * commercial image that carries Claude Code is the error, however well it works.
 */
export function requireDeclaredEngines(contract, declared, image) {
  const engines = contract.engines ?? {};
  const missing = declared.filter(engine => !engines[engine]);
  const extra = Object.keys(engines).filter(engine => engines[engine] && !declared.includes(engine));
  const problems = [];
  if (missing.length) problems.push(`carries no ${missing.join(", ")}: rebuild with ${missing.map(engine => ENGINE_PINS[engine] ?? engine).join(", ")} exported (see build-image.mjs; LUMENBOX_RELEASE_IMAGE=1 refuses an unpinned release build)`);
  if (extra.length) problems.push(`carries ${extra.map(engine => `${engine} ${engines[engine]}`).join(", ")}, which this release does not declare (it declares ${declared.join(", ")}): rebuild without ${extra.map(engine => ENGINE_PINS[engine] ?? engine).join(", ")}, or add the engine to LUMENBOX_RELEASE_ENGINES if it may be shipped`);
  if (problems.length) throw new Error(`${image} ${problems.join("; and ")}.`);
  return Object.entries(engines).filter(([, version]) => version).map(([name, version]) => `${name} ${version}`);
}

export function publicationTarget(args, repo, version) {
  const at = args.indexOf("--image");
  const image = at < 0 ? `${repo}:${version}` : args[at + 1]?.trim();
  if (!image || image.startsWith("--")) throw new Error("--image requires an image reference");
  return { image, latest: image === `${repo}:${version}` ? `${repo}:latest` : undefined };
}

export function publishImage(run, { image, latest, context, buildArgs }) {
  const builder = "lumenbox-release";
  let inspection;
  try { inspection = run(["buildx", "inspect", builder]); }
  catch { run(["buildx", "create", "--name", builder, "--driver", "docker-container"]); }
  if (inspection !== undefined && !/^Driver:\s+docker-container\s*$/m.test(inspection)) {
    throw new Error(`Builder ${builder} must use the docker-container driver; select a different name or remove the conflicting builder.`);
  }
  const tags = latest && latest !== image ? [image, latest] : [image];
  run(["buildx", "build", "--builder", builder, "--platform", RELEASE_PLATFORMS.join(","), "--push", ...buildArgs, ...tags.flatMap(tag => ["-t", tag]), context]);
}

export function requireReleasePlatforms(tag, image) {
  const published = new Set((tag.images ?? []).map(entry => `${entry.os}/${entry.architecture}`));
  const missing = RELEASE_PLATFORMS.filter(platform => !published.has(platform));
  if (missing.length) throw new Error(`${image} lacks ${missing.join(", ")}; run npm run push:image to publish a multi-platform release before shipping the app.`);
}

export function publishedEngineContract(run, image, { skipImage = false, requireEngines = false } = {}, say = console.log) {
  if (skipImage) {
    say("RELEASE_CHECK_SKIP_IMAGE=1 — published engine contract gate skipped");
    return undefined;
  }
  try { run(["pull", image]); }
  catch (error) {
    if (requireEngines) throw new Error(`could not pull published image ${image} for engine verification: ${error.message}`);
    say(`${image}: engine contract not checked, pull failed (set RELEASE_CHECK_REQUIRE_ENGINES=1 to insist)`);
    return undefined;
  }
  let raw;
  try { raw = run(["run", "--rm", "--entrypoint", "cat", image, "/etc/lumenbox/contract.json"]); }
  catch (error) {
    if (requireEngines) throw new Error(`could not read the engine contract from ${image}: ${error.message}`);
    say(`${image}: engine contract not checked (set RELEASE_CHECK_REQUIRE_ENGINES=1 to insist)`);
    return undefined;
  }
  return JSON.parse(raw);
}
