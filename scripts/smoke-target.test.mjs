import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONTAINER } from "../src/box/docker.ts";
import { liveOwners, smokeHome, smokeTarget } from "./smoke-target.mjs";
import { BOX_OWNER_FILENAME, PROFILE_FILENAME } from "../src/agents/registry.ts";

test("smoke defaults to creating its own box, never the installation's", () => {
  const target = smokeTarget([], {}, DEFAULT_CONTAINER);
  assert.equal(target.mode, "create");
  assert.notEqual(target.name, DEFAULT_CONTAINER);
  for (const env of [{}, { AGENTBOX_BOXD_URL: "http://test.invalid" }]) {
    assert.throws(() => smokeTarget(["--box", "use", DEFAULT_CONTAINER], env, DEFAULT_CONTAINER), /installation's own box/);
  }
  assert.throws(() => smokeTarget([], { AGENTBOX_CONTAINER: DEFAULT_CONTAINER }, DEFAULT_CONTAINER), /installation's own box/);
  for (const argv of [["--box"], ["--box", "use"], ["--box", "wrong"]]) {
    assert.throws(() => smokeTarget(argv, {}, DEFAULT_CONTAINER), /--box/);
  }
});

test("smoke permits explicit test targets and requires opt-in for the live container", () => {
  assert.equal(smokeTarget(["--box", "use", "test-box"], {}, DEFAULT_CONTAINER).name, "test-box");
  assert.equal(smokeTarget([], { AGENTBOX_CONTAINER: "test-box" }, DEFAULT_CONTAINER).name, "test-box");
  assert.equal(smokeTarget([], { AGENTBOX_BOXD_URL: "http://test.invalid" }, DEFAULT_CONTAINER).mode, "attached");
  const live = smokeTarget(["--live-box"], {}, DEFAULT_CONTAINER);
  assert.equal(live.name, DEFAULT_CONTAINER);
  assert.equal(live.live, true);
});

test("smoke replaces an inherited home and removes its registry and token on close", () => {
  const env = { AGENTBOX_HOME: "/not-the-smoke-home", AGENTBOX_AGENTS_DIR: "/not-the-smoke-registry" };
  const scratch = smokeHome(env);
  try {
    assert.notEqual(env.AGENTBOX_HOME, "/not-the-smoke-home");
    assert.equal(env.AGENTBOX_HOME, scratch.home);
    assert.equal(env.AGENTBOX_AGENTS_DIR, join(scratch.home, "agents"));
    writeFileSync(join(scratch.home, "token"), "test-owner");
  } finally {
    scratch.close();
  }
  assert.equal(existsSync(scratch.home), false);
});

test("live owner lookup reads existing claims without minting missing tokens", () => {
  const scratch = smokeHome({});
  try {
    assert.equal(liveOwners(join(scratch.home, "missing")).size, 0);
    const agent = join(scratch.home, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, PROFILE_FILENAME), JSON.stringify({ displayIndex: 1 }));
    assert.equal(liveOwners(scratch.home).size, 0);
    assert.equal(existsSync(join(agent, BOX_OWNER_FILENAME)), false);
    writeFileSync(join(agent, BOX_OWNER_FILENAME), "owner-test");
    assert.equal(liveOwners(scratch.home).get(1), "owner-test");
    writeFileSync(join(agent, PROFILE_FILENAME), "invalid JSON");
    assert.throws(() => liveOwners(scratch.home), SyntaxError);
  } finally {
    scratch.close();
  }
});
