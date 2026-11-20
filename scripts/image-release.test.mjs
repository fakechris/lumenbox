import assert from "node:assert/strict";
import { test } from "node:test";
import { engineBuildArgs, publicationTarget, publishedEngineContract, publishImage, requireReleasePlatforms } from "./image-release.mjs";

test("a release tag must carry both runnable Linux platforms, not just attestations", () => {
  const amd64 = { os: "linux", architecture: "amd64" };
  const arm64 = { os: "linux", architecture: "arm64" };
  assert.doesNotThrow(() => requireReleasePlatforms({ images: [amd64, arm64, { os: "unknown", architecture: "unknown" }] }, "image:1"));
  assert.throws(() => requireReleasePlatforms({ images: [arm64] }, "image:1"), /image:1 lacks linux\/amd64/);
  assert.throws(() => requireReleasePlatforms({ images: [amd64] }, "image:1"), /linux\/arm64/);
  assert.throws(() => requireReleasePlatforms({}, "image:1"), /linux\/amd64, linux\/arm64/);
  const calls = [];
  const contract = publishedEngineContract(args => {
    calls.push(args[0]);
    return args[0] === "pull" ? "pulled" : JSON.stringify({ engines: { pi: "published" } });
  }, "image:1");
  assert.deepEqual(calls, ["pull", "run"], "replace any stale local tag before reading its contract");
  assert.equal(contract.engines.pi, "published");
  const pullFails = args => {
    assert.equal(args[0], "pull", "a failed pull must never inspect a stale image");
    throw new Error("registry unavailable");
  };
  assert.equal(publishedEngineContract(pullFails, "image:1", {}, () => {}), undefined, "no daemon only blocks a strict engine check");
  assert.throws(() => publishedEngineContract(pullFails, "image:1", { requireEngines: true }, () => {}),
    /could not pull published image image:1.*registry unavailable/);
  assert.equal(publishedEngineContract(() => assert.fail("skip must not pull or run"), "image:1", { skipImage: true }, () => {}), undefined);
  const unreadable = args => { if (args[0] === "run") throw new Error("missing contract"); return ""; };
  assert.equal(publishedEngineContract(unreadable, "image:1", {}, () => {}), undefined);
  assert.throws(() => publishedEngineContract(unreadable, "image:1", { requireEngines: true }), /could not read the engine contract.*missing contract/);
  assert.throws(() => publishedEngineContract(() => "not JSON", "image:1"), SyntaxError);
});

test("local and published builds share pins and refuse incomplete release builds", () => {
  const env = { OPENCODE_VERSION: "1", CLAUDE_CODE_VERSION: "2", PI_VERSION: "3", MCODE_VERSION: "4", LUMENBOX_RELEASE_IMAGE: "1" };
  const args = engineBuildArgs(env, () => {});
  for (const name of Object.keys(env).filter(key => key.endsWith("_VERSION"))) assert.ok(args.includes(`${name}=${env[name]}`));
  assert.throws(() => engineBuildArgs({ ...env, PI_VERSION: "" }, () => {}), /refusing.*PI_VERSION/);
  assert.deepEqual(engineBuildArgs({}, () => {}), []);
});

test("publishing creates a multi-platform builder when absent, or reuses a suitable one", () => {
  for (const argv of [[], ["--image", "registry.example:5000/team/box:custom"]]) {
    const target = publicationTarget(argv, "repo", "1");
    for (const exists of [false, true]) {
      const calls = [];
      publishImage(args => {
        calls.push(args);
        if (args[1] === "inspect") {
          assert.deepEqual(args, ["buildx", "inspect", "lumenbox-release"]);
          if (!exists) throw new Error("no builder");
          return "Name:          lumenbox-release\nDriver:        docker-container\nNodes:\n";
        }
        return "";
      }, { ...target, context: "context", buildArgs: ["--build-arg", "PI_VERSION=3"] });
      assert.equal(calls.some(args => args[1] === "create"), !exists);
      const build = calls.find(args => args[1] === "build");
      assert.equal(build[build.indexOf("--platform") + 1], "linux/amd64,linux/arm64");
      assert.ok(build.includes("--push"));
      const tags = build.flatMap((arg, i) => arg === "-t" ? [build[i + 1]] : []);
      assert.deepEqual(tags, argv.length ? [argv[1]] : ["repo:1", "repo:latest"]);
      assert.ok(build.includes("PI_VERSION=3"));
    }
  }
  for (const args of [["--image"], ["--image", ""], ["--image", "--push"]]) assert.throws(() => publicationTarget(args, "repo", "1"), /requires an image reference/);
  for (const inspection of ["Name: lumenbox-release\nDriver: docker\n", ""]) {
    assert.throws(() => publishImage(() => inspection, {}), /docker-container driver/);
  }
  assert.throws(() => publishImage(() => { throw new Error("engine offline"); }, {}), /engine offline/);
});
