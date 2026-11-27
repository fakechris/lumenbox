import assert from "node:assert/strict";
import { test } from "node:test";
import { engineBuildArgs, publicationTarget, publishedEngineContract, publishImage, releaseEngines, requireDeclaredEngines, requireReleasePlatforms } from "./image-release.mjs";

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

test("a release declares which engines it carries, and the build and the published image are both held to it", () => {
  const all = { opencode: "1", claude: "2", pi: "3", mcode: "4" };
  // Undeclared, a release is what it has always been: all four, each required.
  assert.deepEqual(releaseEngines({}), ["opencode", "claude", "pi", "mcode"]);
  assert.deepEqual(requireDeclaredEngines({ engines: all }, releaseEngines({}), "image:1"), ["opencode 1", "claude 2", "pi 3", "mcode 4"]);
  assert.throws(() => requireDeclaredEngines({ engines: { ...all, mcode: "" } }, releaseEngines({}), "image:1"), /image:1 carries no mcode: rebuild with MCODE_VERSION exported/);
  assert.throws(() => requireDeclaredEngines({}, releaseEngines({}), "image:1"), /carries no opencode, claude, pi, mcode/);

  // A commercial build: pi alone. Only its pin is needed, and only it may be in the image.
  const commercial = { LUMENBOX_RELEASE_ENGINES: "pi", LUMENBOX_RELEASE_IMAGE: "1", PI_VERSION: "3" };
  assert.deepEqual(releaseEngines(commercial), ["pi"]);
  assert.deepEqual(engineBuildArgs(commercial, () => {}), ["--build-arg", "PI_VERSION=3"], "a release build with the one pin it declares");
  assert.throws(() => engineBuildArgs({ ...commercial, PI_VERSION: "" }, () => {}), /refusing an unpinned release image; missing PI_VERSION/);
  assert.throws(() => engineBuildArgs({ ...commercial, CLAUDE_CODE_VERSION: "2" }, () => {}), /LUMENBOX_RELEASE_ENGINES=pi does not carry claude \(CLAUDE_CODE_VERSION\), but its pin is set/, "a pin left exported from the last full build is refused, not built");
  assert.deepEqual(requireDeclaredEngines({ engines: { opencode: "", claude: "", pi: "3", mcode: "" } }, ["pi"], "image:1"), ["pi 3"], "the contract writes an absent engine as an empty field");
  assert.throws(() => requireDeclaredEngines({ engines: { opencode: "", claude: "", pi: "", mcode: "" } }, ["pi"], "image:1"), /image:1 carries no pi: rebuild with PI_VERSION exported/);
  assert.throws(() => requireDeclaredEngines({ engines: all }, ["pi"], "image:1"),
    /image:1 carries opencode 1, claude 2, mcode 4, which this release does not declare \(it declares pi\): rebuild without OPENCODE_VERSION, CLAUDE_CODE_VERSION, MCODE_VERSION/, "the image this gate exists to stop");
  assert.throws(() => requireDeclaredEngines({ engines: { pi: "", claude: "2" } }, ["pi"], "image:1"), /carries no pi.*; and carries claude 2/, "both halves are said at once");

  // The declaration itself is checked: a typo must not silently mean "no engines required".
  assert.deepEqual(releaseEngines({ LUMENBOX_RELEASE_ENGINES: " pi , opencode,pi " }), ["pi", "opencode"]);
  assert.throws(() => releaseEngines({ LUMENBOX_RELEASE_ENGINES: "pi,claude-code" }), /names claude-code, which is not an engine; the engines are opencode, claude, pi, mcode/);
  assert.throws(() => releaseEngines({ LUMENBOX_RELEASE_ENGINES: "" }), /is empty: name the engines/);
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
