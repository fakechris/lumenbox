/** The onboarding run's pure parts (INV-1447): arguments, the published digest, isolation, and the untouched check. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { boxResources, cleanEnv, disturbed, dmgName, expectedDigest, parseArgs, summarize } from "./onboarding-e2e.mjs";

test("arguments: a version is required, the default app's port is refused, and cleanup needs no version", () => {
  const run = parseArgs(["--version", "0.3.8", "--key-env", "MINIMAX_API_KEY"]);
  assert.deepEqual({ phases: run.phases, port: run.port, cdpPort: run.cdpPort, provider: run.provider }, { phases: ["nodocker", "full"], port: 7796, cdpPort: 9341, provider: "minimax" });
  assert.throws(() => parseArgs([]), /--version X\.Y\.Z/);
  assert.throws(() => parseArgs(["--version", "0.3.8", "--port", "7777"]), /7777/);
  assert.throws(() => parseArgs(["--version", "0.3.8", "--phases", "full,teach"]), /unknown phase teach/);
  assert.throws(() => parseArgs(["--version", "0.3.8", "--key-env"]), /needs a value/);
  assert.throws(() => parseArgs(["--version", "0.3.8", "--bogus"]), /unknown argument/);
  assert.equal(parseArgs(["--cleanup", "/tmp/run", "--yes"]).yes, true);
});

test("arguments: an upgrade run names the previous release, walks its own phases, and refuses what would not be an upgrade", () => {
  const run = parseArgs(["--version", "0.4.12", "--upgrade-from", "0.4.11", "--downgrade-check", "--key-env", "K"]);
  assert.deepEqual({ from: run.upgradeFrom, phases: run.phases, downgrade: run.downgradeCheck }, { from: "0.4.11", phases: ["upgrade"], downgrade: true });
  assert.equal(parseArgs(["--version", "0.4.11", "--dmg", "c.dmg", "--upgrade-from", "0.4.11"]).upgradeFrom, "0.4.11", "a candidate of the same version is an upgrade of its data");
  assert.throws(() => parseArgs(["--version", "0.4.11", "--upgrade-from", "0.4.11"]), /needs a candidate --dmg/);
  assert.throws(() => parseArgs(["--version", "0.4.9", "--upgrade-from", "0.4.10"]), /downgrade/);
  assert.throws(() => parseArgs(["--version", "0.4.12", "--upgrade-from", "latest"]), /--upgrade-from X\.Y\.Z/);
  assert.throws(() => parseArgs(["--version", "0.4.12", "--upgrade-from", "0.4.11", "--phases", "full"]), /leave out --phases/);
  assert.throws(() => parseArgs(["--version", "0.4.12", "--downgrade-check"]), /needs --upgrade-from/);
  assert.throws(() => parseArgs(["--version", "0.4.12", "--from-dmg", "old.dmg"]), /need --upgrade-from/);
  assert.equal(parseArgs(["--version", "0.4.12", "--upgrade-from", "0.4.11", "--from-dmg", "old.dmg", "--from-sums", "S"]).fromDmg, "old.dmg");
  assert.equal(parseArgs(["--version", "0.4.12"]).downgradeCheck, false);
});

test("the DMG a person downloads, and the digest SHA256SUMS publishes for exactly that file", () => {
  assert.equal(dmgName("0.3.8", "arm64"), "LumenBox-0.3.8-arm64.dmg");
  assert.equal(dmgName("0.3.8", "x64"), "LumenBox-0.3.8.dmg");
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const sums = `${a}  LumenBox-0.3.8-arm64.dmg\n${b} *LumenBox-0.3.8.dmg\n`;
  assert.equal(expectedDigest(sums, "LumenBox-0.3.8-arm64.dmg"), a);
  assert.equal(expectedDigest(sums, "LumenBox-0.3.8.dmg"), b);
  assert.equal(expectedDigest(sums, "LumenBox-0.3.8-arm64-mac.zip"), undefined);
});

test("the app's environment keeps a login session's basics and nothing else from the operator's shell", () => {
  const env = cleanEnv({ HOME: "/Users/x", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", MINIMAX_API_KEY: "mm", AGENTBOX_HOME: "/Users/x/.agentbox", DOCKER_HOST: "tcp://elsewhere" }, { AGENTBOX_HOME: "/run/home" });
  assert.equal(env.HOME, "/Users/x");
  assert.equal(env.AGENTBOX_HOME, "/run/home");
  for (const leak of ["ANTHROPIC_API_KEY", "MINIMAX_API_KEY", "DOCKER_HOST"]) assert.equal(env[leak], undefined, `${leak} does not reach the app`);
  assert.match(env.PATH, /\/usr\/local\/bin/, "Docker's usual places are on PATH, as a GUI launch has them");
});

test("a run's box resources are all named from its own container", () => {
  assert.deepEqual(boxResources("lumenbox-onboard-1030"), { container: "lumenbox-onboard-1030", volumes: ["lumenbox-onboard-1030-work", "lumenbox-onboard-1030-config"], network: "lumenbox-onboard-1030-net" });
});

test("a container that existed before counts as touched if it was removed, replaced or restarted", () => {
  const before = [{ name: "agentbox-box", id: "1", startedAt: "t1" }, { name: "pod", id: "2", startedAt: "t2" }, { name: "db", id: "3", startedAt: "t3" }];
  const after = [{ name: "agentbox-box", id: "1", startedAt: "t1" }, { name: "pod", id: "2", startedAt: "t9" }, { name: "lumenbox-onboard-1", id: "4", startedAt: "t4" }];
  assert.deepEqual(disturbed(before, after), ["pod", "db"]);
  assert.deepEqual(disturbed(before, before), []);
});

test("a run passes only when it ran something and nothing failed; notes do not fail it", () => {
  assert.deepEqual(summarize([]), { passed: false, failed: [] });
  assert.deepEqual(summarize([{ name: "a", status: "pass" }, { name: "g", status: "note" }]), { passed: true, failed: [] });
  assert.deepEqual(summarize([{ name: "a", status: "pass" }, { name: "b", status: "fail" }]), { passed: false, failed: ["b"] });
});
