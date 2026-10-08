/**
 * Tests for what a volume archive is allowed to carry out of the box.
 *
 * A backup exists so nothing unrebuildable is lost. The spool is the opposite of that: a
 * 24-hour buffer holding the *untruncated* output of every command an agent ran — the
 * text the transcript deliberately keeps only 2 KB of, and the likeliest place a
 * `cat .env` or a token-bearing build log survives in full. It was in every upgrade
 * archive, which turned an expiring buffer inside the container into a permanent copy
 * outside it, in a directory nobody reviews (docs/15).
 *
 * A unit test rather than an end-to-end one: the archive is built by `tar` inside a
 * container, so the thing worth pinning here is the exclude list itself and the fact that
 * the spool path it names is the path the box actually writes to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_EXCLUDES, BOX_IMAGE_REPO, BoxManager, boxImageRef, boxTokenPath, boxUiToken, defaultBoxConfig, dockerEnvironment, DockerError, ensureLocalImage, loadBoxToken, networkNameFor, packageVersion, readBoxToken, uiToken } from "./docker.ts";
import { SPILL_AT_BYTES, SPOOL_DIR } from "../boxd/shell-service.ts";
import { DURABLE_RESULT_CHARS } from "../protocol/index.ts";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the published image is fakechris/lumenbox at this package's version", () => {
  const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  assert.equal(packageVersion(), version);
  assert.equal(boxImageRef(), `${BOX_IMAGE_REPO}:${version}`);
  assert.equal(BOX_IMAGE_REPO, "fakechris/lumenbox");
  const home = mkdtempSync(join(tmpdir(), "agentbox-image-"));
  const previousImage = process.env.AGENTBOX_IMAGE;
  const previousHome = process.env.AGENTBOX_HOME;
  delete process.env.AGENTBOX_IMAGE;
  process.env.AGENTBOX_HOME = home;
  try {
    assert.equal(defaultBoxConfig().image, `fakechris/lumenbox:${version}`);
  } finally {
    if (previousImage === undefined) delete process.env.AGENTBOX_IMAGE;
    else process.env.AGENTBOX_IMAGE = previousImage;
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing image is pulled, and a failed pull says how to build it", async () => {
  let pulled = false;
  const lines: string[] = [];
  const note = (line: string) => {
    lines.push(line);
  };
  await ensureLocalImage(
    "fakechris/lumenbox:0.3.0",
    { exists: async () => true, pull: async () => { pulled = true; } },
    note,
  );
  assert.equal(pulled, false);
  assert.deepEqual(lines, []);

  await ensureLocalImage(
    "fakechris/lumenbox:0.3.0",
    { exists: async () => false, pull: async () => { pulled = true; } },
    note,
  );
  assert.equal(pulled, true);
  // The size and the wait travel with the announcement (INV-856): the pull is the one
  // long silent step of a first run, and a quiet minute reads as "stuck".
  const announcement = lines[0] ?? "";
  assert.match(announcement, /^image fakechris\/lumenbox:0\.3\.0 is not on this machine; pulling it/);
  assert.match(announcement, /750MB|a few minutes/);

  // "denied" is a registry that answered — classified as no-such-image, and it still
  // names `box build` for the reader who has a checkout (last, not first).
  await assert.rejects(
    () => ensureLocalImage("fakechris/lumenbox:0.3.0", {
      exists: async () => false,
      pull: async () => { throw new Error("denied"); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DockerError);
      assert.match(error.message, /agentbox box build/);
      assert.match(error.message, /fakechris\/lumenbox:0\.3\.0/);
      return true;
    },
  );
});

test("a pull failure says whether the registry answered or never answered (INV-856)", async () => {
  // A registry with no such tag: a just-released app racing its image, or a mistyped
  // mirror. The fix is "update the app or fix the setting", not a network lecture.
  await assert.rejects(
    () => ensureLocalImage("fakechris/lumenbox:9.9.9", {
      exists: async () => false,
      pull: async () => { throw new Error("manifest for fakechris/lumenbox:9.9.9 not found"); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DockerError);
      assert.match(error.message, /no such image or tag/);
      assert.match(error.message, /update the app/);
      return true;
    },
  );

  // A registry that never answered — the common case behind a network where Docker Hub
  // needs a mirror. The message leads with the network and names the mirror entrance.
  await assert.rejects(
    () => ensureLocalImage("fakechris/lumenbox:0.3.0", {
      exists: async () => false,
      pull: async () => { throw new Error("Client.Timeout during request"); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DockerError);
      assert.match(error.message, /registry did not answer/);
      assert.match(error.message, /mirror/i);
      assert.match(error.message, /agentbox box build/);
      return true;
    },
  );
});

test("the image comes from the config file when the environment does not name one (INV-856)", () => {
  // A Finder-launched app has no shell to export AGENTBOX_IMAGE into, so config.json is
  // the entrance a mirror has to use — and the environment still wins when it is set.
  const home = mkdtempSync(join(tmpdir(), "agentbox-boximage-"));
  const previousHome = process.env.AGENTBOX_HOME;
  const previousImage = process.env.AGENTBOX_IMAGE;
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_IMAGE;
  try {
    const version = packageVersion();
    assert.equal(defaultBoxConfig().image, `fakechris/lumenbox:${version}`, "no config, no override");
    writeFileSync(join(home, "config.json"), JSON.stringify({ boxImage: "mirror.example.com/lumenbox:0.3.0" }));
    assert.equal(defaultBoxConfig().image, "mirror.example.com/lumenbox:0.3.0", "config override holds");
    process.env.AGENTBOX_IMAGE = "pinned.example.com/lumenbox:0.3.0";
    assert.equal(defaultBoxConfig().image, "pinned.example.com/lumenbox:0.3.0", "environment wins");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    if (previousImage === undefined) delete process.env.AGENTBOX_IMAGE;
    else process.env.AGENTBOX_IMAGE = previousImage;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the daemon is published to loopback, because its VNC upgrade is unauthenticated", () => {
  // Measured on a running installation, 2026-08-28, before this was fixed: from the
  // machine's LAN address, `/health` answered and a WebSocket upgrade to
  // `/vnc/1/websockify` returned 101 and streamed the desktop. The RFB upgrade is
  // deliberately unauthenticated *on the premise* that only the host's loopback proxy
  // can reach it (src/boxd/main.ts) — and the publication contradicted the premise, so
  // anyone on the same network could watch and drive the agents.
  //
  // Pinned as an argument-shape assertion rather than a mock: the property is about what
  // is handed to Docker.
  const args = new BoxManager({
    containerName: "agentbox-test",
    image: "agentbox/box:latest",
    host: "127.0.0.1",
    token: "t",
    boxdPort: 0,
    displayWidth: 1280,
    displayHeight: 800,
    runArgs: [],
  }).runArguments();
  const publications = args
    .map((argument: string, index: number) => (argument === "--publish" ? args[index + 1] : undefined))
    .filter((value: string | undefined): value is string => value !== undefined);
  assert.ok(publications.length > 0, "the daemon must be published somehow");
  for (const publication of publications) {
    assert.ok(
      publication.startsWith("127.0.0.1:"),
      `every published port must be bound to loopback; got "${publication}"`
    );
  }
});

test("a box runs on its own network rather than the shared default bridge", () => {
  // One layer, not the boundary. Measured on Docker 29/OrbStack: a container on the
  // default bridge still reached a box's daemon at its private-network address, because
  // that engine's DOCKER-FORWARD chain accepts forwarding out of every bridge. So this
  // is kept for the engines where it does isolate, and the daemon's upgrade path was
  // authenticated instead of left resting on it. What this test pins is the topology,
  // not a reachability claim it cannot make from here.
  const args = new BoxManager({
    containerName: "agentbox-test",
    image: "agentbox/box:latest",
    host: "127.0.0.1",
    token: "t",
    boxdPort: 0,
    displayWidth: 1280,
    displayHeight: 800,
    runArgs: [],
  }).runArguments();
  const networkAt = args.indexOf("--network");
  assert.ok(networkAt >= 0, "the container must be placed on a named network");
  assert.equal(args[networkAt + 1], networkNameFor("agentbox-test"));
  // The name is derived from the container's, so create and teardown agree without a
  // lookup — a network whose name must be looked up somewhere is one that gets orphaned.
  assert.match(networkNameFor("agentbox-test"), /agentbox-test/);
  assert.notEqual(networkNameFor("agentbox-a"), networkNameFor("agentbox-b"));
});

test("the spool does not travel out of the box in a backup", () => {
  assert.ok(
    BACKUP_EXCLUDES.includes("./.spool"),
    `the spool must be excluded from volume archives; excludes are ${BACKUP_EXCLUDES.join(", ")}`
  );
});

test("the excluded path is the path the box actually spools to", () => {
  // The exclude is written relative to the volume root, because that is what `tar -C /src`
  // sees. If the daemon's SPOOL_DIR ever moves out from under /home/box/work, the exclude
  // silently stops matching and the leak comes back — which is exactly the shape of bug
  // this test exists to catch, so it is pinned to the constant rather than to a string.
  const WORK_ROOT = "/home/box/work";
  assert.ok(
    SPOOL_DIR.startsWith(`${WORK_ROOT}/`),
    `SPOOL_DIR (${SPOOL_DIR}) is expected to live under the work volume`
  );
  const relative = `.${SPOOL_DIR.slice(WORK_ROOT.length)}`;
  assert.ok(
    BACKUP_EXCLUDES.includes(relative),
    `the exclude list does not cover ${relative}; it has ${BACKUP_EXCLUDES.join(", ")}`
  );
});

test("the spool's location cannot be moved out from under the exclusion", () => {
  // The test above pins the exclusion to SPOOL_DIR's *value*, which was not enough: the
  // constant used to read `process.env.BOXD_SPOOL_DIR ?? …`, so a daemon started with
  // that variable set spooled somewhere the literal exclusion did not cover, and every
  // upgrade archive carried the output again. The adversarial review of docs/15 found it.
  // A test that reads the same environment as the code cannot catch that, so this asserts
  // the property that makes it impossible: the path is fixed.
  const source = readFileSync(new URL("../boxd/shell-service.ts", import.meta.url), "utf8");
  const declaration = /export const SPOOL_DIR\s*=\s*([^;]+);/.exec(source)?.[1] ?? "";
  assert.ok(
    !/process\.env/.test(declaration),
    `SPOOL_DIR must not be configurable, or the backup exclusion is a lie; got: ${declaration.trim()}`
  );
});

test("spilling happens before anything durable is truncated", () => {
  // Three thresholds existed and this one was measured against the wrong one: spilling
  // began at 16KB while the transcript kept 2KB, so a 2,500-character result was shown to
  // the model whole, stored as a head, and given no pointer to its tail.
  assert.ok(
    SPILL_AT_BYTES <= DURABLE_RESULT_CHARS,
    `output is spilled at ${SPILL_AT_BYTES} bytes but only ${DURABLE_RESULT_CHARS} ` +
      `characters survive durably, so results between the two lose their tail with no pointer`
  );
});

test("each box gets its own token, and a new one inherits nothing", () => {
  // One `~/.agentbox/token` was shared by every box this host started. Harmless while
  // there was only ever one, and exactly the failure the control plane's own allocator
  // warns about: "one token across the fleet would mean anyone who reached one tenant's
  // box could reach another". A box that belongs to one person is the whole of the
  // identity design, and a shared key would make that boundary a wish.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-token-"));
  const home = process.env.AGENTBOX_HOME;
  const explicit = process.env.AGENTBOX_TOKEN;
  try {
    process.env.AGENTBOX_HOME = dir;
    delete process.env.AGENTBOX_TOKEN;

    const mine = loadBoxToken("agentbox-box");
    const theirs = loadBoxToken("agentbox-identity-dana");
    assert.notEqual(mine, theirs, "two boxes, two keys");
    assert.equal(loadBoxToken("agentbox-box"), mine, "stable across calls, or a running box locks out");
    assert.match(boxTokenPath("agentbox-identity-dana"), /tokens\/agentbox-identity-dana$/);
  } finally {
    if (home === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = home;
    if (explicit !== undefined) process.env.AGENTBOX_TOKEN = explicit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the box running right now keeps working, and only it may read the old shared token", () => {
  // Its environment has the old token baked in and cannot be edited in place, so the
  // default container still reads the legacy file. Any other box must not: inheriting is
  // how one key came to open every door.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-token-"));
  const home = process.env.AGENTBOX_HOME;
  const explicit = process.env.AGENTBOX_TOKEN;
  try {
    process.env.AGENTBOX_HOME = dir;
    delete process.env.AGENTBOX_TOKEN;
    writeFileSync(join(dir, "token"), "legacy-shared-token\n", { mode: 0o600 });

    assert.equal(readBoxToken("agentbox-box"), "legacy-shared-token");
    assert.equal(readBoxToken("agentbox-identity-dana"), undefined);
  } finally {
    if (home === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = home;
    if (explicit !== undefined) process.env.AGENTBOX_TOKEN = explicit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the machine's web and the box's web hold different secrets (INV-572)", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-tokens-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    const mine = uiToken();
    const box = boxUiToken();
    assert.notEqual(mine, box, "one secret behind two doors means one leak is two doors");
    assert.ok(mine.length >= 16 && box.length >= 16);

    // Both stable across calls: a restart must not invalidate an open tab.
    assert.equal(uiToken(), mine);
    assert.equal(boxUiToken(), box);

    // Both private, because either one drives everything behind its own door.
    for (const name of ["ui-token", "box-ui-token"]) {
      assert.equal(statSync(join(home, name)).mode & 0o777, 0o600, `${name} is readable by others`);
    }

    // An installation that only ever had the old file keeps it, and gains the new one.
    rmSync(join(home, "box-ui-token"));
    const minted = boxUiToken();
    assert.notEqual(minted, box, "a fresh mint, not a derivation of the one it is separating from");
    assert.equal(uiToken(), mine, "and the machine's own is untouched");
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("dockerEnvironment separates a missing install from a stopped engine", async () => {
  // A fake `docker` on PATH, three ways: absent, present-and-failing, present-and-happy.
  // These are the three things a fresh machine can be, and the settings page has one
  // sentence for each (INV-855) — a test pins the mapping, because the easy refactor is
  // folding them back into one boolean and one jargon error.
  const empty = mkdtempSync(join(tmpdir(), "agentbox-nodocker-"));
  const bin = mkdtempSync(join(tmpdir(), "agentbox-fakedocker-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = empty;
    const missing = await dockerEnvironment(2_000);
    assert.equal(missing.state, "no-binary");
    assert.match(missing.detail, /PATH/);

    const failing = join(bin, "docker");
    writeFileSync(failing, "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const stopped = await dockerEnvironment(2_000);
    assert.equal(stopped.state, "no-engine");
    assert.match(stopped.detail, /Cannot connect/);

    writeFileSync(failing, "#!/bin/sh\necho 27.0.1\n", { mode: 0o755 });
    const ok = await dockerEnvironment(2_000);
    assert.equal(ok.state, "ok");
    assert.match(ok.detail, /27\.0\.1/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(empty, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
