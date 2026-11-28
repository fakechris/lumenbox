/** The onboarding run's pure parts (INV-1447): arguments, the published digest, isolation, and the untouched check. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { appEnv, boxResources, cleanup, disturbed, dmgName, expectedDigest, ownProcess, parseArgs, runBundles, summarize } from "./onboarding-e2e.mjs";

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

test("the app's environment keeps a login session's basics and nothing else from the operator's shell, and points it at the run's own home and logs", () => {
  const operator = { HOME: "/Users/x", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", MINIMAX_API_KEY: "mm", AGENTBOX_HOME: "/Users/x/.agentbox", DOCKER_HOST: "tcp://elsewhere", LUMENBOX_LOGS_DIR: "/Users/x/elsewhere" };
  const env = appEnv(operator, { home: "/run/full/home", logs: "/run/full/logs", container: "lumenbox-onboard-1", port: 7796 });
  assert.equal(env.HOME, "/Users/x", "the real HOME is kept, so the shell's default logs directory would be the owner's");
  assert.equal(env.LUMENBOX_LOGS_DIR, "/run/full/logs", "so the run names its own (INV-2307)");
  assert.deepEqual([env.AGENTBOX_HOME, env.AGENTBOX_CONTAINER, env.LUMENBOX_PORT], ["/run/full/home", "lumenbox-onboard-1", "7796"]);
  assert.equal(appEnv(operator, { home: "/h", logs: "/l", container: "c" }, { ELECTRON_RUN_AS_NODE: "1" }).LUMENBOX_LOGS_DIR, "/l", "the server started alone gets one too");
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

test("cleanup stops a recorded process only while it is provably the run's own: its executable in the run's app, started before it was recorded", () => {
  const bundles = runBundles("/runs/r1");
  const app = "/runs/r1/LumenBox.app/Contents/MacOS/LumenBox";
  const at = "2026-11-28T06:00:00.000Z";
  const t = Date.parse(at);
  assert.equal(ownProcess({ pid: 5, startedAt: at }, { executable: app, startedAt: t - 1000 }, bundles).stop, true);
  assert.equal(ownProcess({ pid: 5, startedAt: at }, { executable: "/runs/r1/previous/LumenBox.app/Contents/Frameworks/x", startedAt: t }, bundles).stop, true, "the previous release's app is the run's too");
  assert.match(ownProcess(5, { executable: app, startedAt: t }, bundles).why, /no start time, so the executable alone decides; stopped/, "a manifest without start times is judged by the executable alone, and says so");
  assert.match(ownProcess({ pid: 5, startedAt: at }, { executable: app, startedAt: undefined }, bundles).why, /executable alone decides; stopped/, "where ps cannot run, the executable still proves it");
  for (const [entry, now, why] of [
    [{ pid: 5, startedAt: at }, undefined, /no longer running/],
    [{ pid: 5, startedAt: at }, { executable: "/bin/sleep", startedAt: t - 1000 }, /not ours.*\/bin\/sleep/],
    [{ pid: 5, startedAt: at }, { executable: "/runs/r1/LumenBox.app-other/LumenBox", startedAt: t - 1000 }, /not ours/],
    [{ pid: 5, startedAt: at }, { executable: "/runs/r10/LumenBox.app/Contents/MacOS/LumenBox", startedAt: t - 1000 }, /not ours/],
    [{ pid: 5, startedAt: at }, { executable: app, startedAt: t + 60_000 }, /after the run recorded it/],
    [{ pid: 5, startedAt: at }, { executable: undefined, startedAt: t }, /could not be read/],
    [{ pid: 5, startedAt: at }, { executable: "/bin/sleep", startedAt: undefined }, /not ours/],
  ]) {
    const verdict = ownProcess(entry, now, bundles);
    assert.equal(verdict.stop, false, verdict.why);
    assert.match(verdict.why, why);
  }
});

test("--cleanup --yes leaves alone a process that took a recorded number, and stops the one running from the run's own app", async t => {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-cleanup-"));
  const macos = join(dir, "LumenBox.app", "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  // A real executable inside the run's bundle: a copy of this node (a copy of a system binary will not start on macOS).
  copyFileSync(process.execPath, join(macos, "LumenBox"), constants.COPYFILE_FICLONE);
  const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
  const ours = spawn(join(macos, "LumenBox"), ["-e", "console.log('up'); setTimeout(() => {}, 60000)"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { unrelated.kill("SIGKILL"); ours.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  await once(ours.stdout, "data");
  const recorded = new Date().toISOString();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ box: boxResources("lumenbox-onboard-test0"), image: "fakechris/lumenbox:9.9.9", imageWasCached: true, appProcesses: [unrelated.pid, { pid: ours.pid, startedAt: recorded }] }));
  const docker = { sh: () => { throw new Error("no Docker in this test"); }, shOk: () => false };
  const listed = [];
  await cleanup({ cleanup: dir, yes: false }, { ...docker, log: line => listed.push(line) });
  const list = listed.join("\n");
  assert.match(list, new RegExp(`process +${unrelated.pid} — not ours, left alone: it runs \\S*sleep`), "the list says which numbers are left alone and why");
  assert.match(list, new RegExp(`process +${ours.pid} — this run's app .*stopped with --yes`), "the list names the process --yes stops");
  const exited = once(ours, "exit");
  await cleanup({ cleanup: dir, yes: true }, { ...docker, log: () => {} });
  assert.deepEqual(await exited, [null, "SIGTERM"]);
  assert.equal(unrelated.exitCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "the unrelated process is still running");
});
