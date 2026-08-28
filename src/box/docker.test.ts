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
import { BACKUP_EXCLUDES, BoxManager, boxTokenPath, loadBoxToken, networkNameFor, readBoxToken } from "./docker.ts";
import { SPILL_AT_BYTES, SPOOL_DIR } from "../boxd/shell-service.ts";
import { DURABLE_RESULT_CHARS } from "../protocol/index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
