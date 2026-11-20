import assert from "node:assert/strict";
import { test } from "node:test";
import { engineBuildArgs, publishImage, requireReleasePlatforms } from "./image-release.mjs";

test("a release tag must carry both runnable Linux platforms, not just attestations", () => {
  const amd64 = { os: "linux", architecture: "amd64" };
  const arm64 = { os: "linux", architecture: "arm64" };
  assert.doesNotThrow(() => requireReleasePlatforms({ images: [amd64, arm64, { os: "unknown", architecture: "unknown" }] }, "image:1"));
  assert.throws(() => requireReleasePlatforms({ images: [arm64] }, "image:1"), /image:1 lacks linux\/amd64/);
  assert.throws(() => requireReleasePlatforms({ images: [amd64] }, "image:1"), /linux\/arm64/);
  assert.throws(() => requireReleasePlatforms({}, "image:1"), /linux\/amd64, linux\/arm64/);
});

test("local and published builds share pins and refuse incomplete release builds", () => {
  const env = { OPENCODE_VERSION: "1", CLAUDE_CODE_VERSION: "2", PI_VERSION: "3", MCODE_VERSION: "4", LUMENBOX_RELEASE_IMAGE: "1" };
  const args = engineBuildArgs(env, () => {});
  for (const name of Object.keys(env).filter(key => key.endsWith("_VERSION"))) assert.ok(args.includes(`${name}=${env[name]}`));
  assert.throws(() => engineBuildArgs({ ...env, PI_VERSION: "" }, () => {}), /refusing.*PI_VERSION/);
  assert.deepEqual(engineBuildArgs({}, () => {}), []);
});

test("publishing creates a multi-platform builder when absent, or reuses a suitable one", () => {
  for (const exists of [false, true]) {
    const calls = [];
    publishImage(args => {
      calls.push(args);
      if (args[1] === "inspect") {
        if (!exists) throw new Error("no builder");
        return "docker-container\n";
      }
      return "";
    }, { image: "repo:1", latest: "repo:latest", context: "context", buildArgs: ["--build-arg", "PI_VERSION=3"] });
    assert.equal(calls.some(args => args[1] === "create"), !exists);
    const build = calls.find(args => args[1] === "build");
    assert.equal(build[build.indexOf("--platform") + 1], "linux/amd64,linux/arm64");
    assert.ok(build.includes("--push"));
    for (const tag of ["repo:1", "repo:latest"]) assert.ok(build.some((arg, i) => arg === "-t" && build[i + 1] === tag));
    assert.ok(build.includes("PI_VERSION=3"));
  }
  assert.throws(() => publishImage(() => "docker", {}), /docker-container driver/);
  assert.throws(() => publishImage(() => { throw new Error("engine offline"); }, {}), /engine offline/);
});
