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

export function publishImage(run, { image, latest, context, buildArgs }) {
  const builder = "lumenbox-release";
  let inspection;
  try { inspection = run(["buildx", "inspect", builder]); }
  catch { run(["buildx", "create", "--name", builder, "--driver", "docker-container"]); }
  if (inspection !== undefined && !/^Driver:\s+docker-container\s*$/m.test(inspection)) {
    throw new Error(`Builder ${builder} must use the docker-container driver; select a different name or remove the conflicting builder.`);
  }
  run(["buildx", "build", "--builder", builder, "--platform", RELEASE_PLATFORMS.join(","), "--push", ...buildArgs, "-t", image, "-t", latest, context]);
}

export function requireReleasePlatforms(tag, image) {
  const published = new Set((tag.images ?? []).map(entry => `${entry.os}/${entry.architecture}`));
  const missing = RELEASE_PLATFORMS.filter(platform => !published.has(platform));
  if (missing.length) throw new Error(`${image} lacks ${missing.join(", ")}; run npm run push:image to publish a multi-platform release before shipping the app.`);
}
