export const RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"];

export function engineBuildArgs(env, say = console.log) {
  const args = [];
  const missing = [];
  for (const name of ["OPENCODE_VERSION", "CLAUDE_CODE_VERSION", "PI_VERSION", "MCODE_VERSION"]) {
    if (env[name]) {
      args.push("--build-arg", `${name}=${env[name]}`);
      say(`${name} pinned at ${env[name]}`);
    } else missing.push(name);
  }
  if (missing.length) {
    if (env.LUMENBOX_RELEASE_IMAGE === "1") throw new Error(`LUMENBOX_RELEASE_IMAGE=1: refusing an unpinned release image; missing ${missing.join(", ")}`);
    say(`NOT in this image: ${missing.join(", ")} — a release image pins all of them.`);
  }
  return args;
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
  catch (error) { throw new Error(`could not pull published image ${image} for engine verification: ${error.message}`); }
  let raw;
  try { raw = run(["run", "--rm", "--entrypoint", "cat", image, "/etc/lumenbox/contract.json"]); }
  catch (error) {
    if (requireEngines) throw new Error(`could not read the engine contract from ${image}: ${error.message}`);
    say(`${image}: engine contract not checked (set RELEASE_CHECK_REQUIRE_ENGINES=1 to insist)`);
    return undefined;
  }
  return JSON.parse(raw);
}
