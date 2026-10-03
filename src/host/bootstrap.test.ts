import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BootstrapAdmins } from "./bootstrap.ts";
import { Principals } from "./principals.ts";

test("bootstrap is single-use, atomic with the first admin, private on disk and restart-safe", async () => {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-"));
  try {
    const path = join(home, "principals.json"), codePath = join(home, "bootstrap-code");
    const bootstrap = new BootstrapAdmins(path, codePath);
    assert.equal(bootstrap.ensure(), true);
    const code = readFileSync(codePath, "utf8").trim();
    assert.equal(statSync(codePath).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8").includes(code), false);
    const restarted = new BootstrapAdmins(path, codePath);
    assert.equal(restarted.ensure(), true);
    assert.equal(readFileSync(codePath, "utf8").trim(), code);
    const result = await Promise.all(["alice", "bob"].map(async subject => restarted.redeem(code, `feishu:${subject}`, subject, 1)));
    assert.equal(result.filter(Boolean).length, 1);
    assert.equal(new Principals(path).list().length, 1);
    assert.equal(new Principals(path).list()[0]!.role, "admin");
    assert.equal(new BootstrapAdmins(path, codePath).redeem(code, "feishu:eve", "Eve", 1), false);
    const principals = new Principals(path);
    principals.save([]);
    assert.equal(new BootstrapAdmins(path, codePath).ensure(), false, "removing the last admin never re-arms bootstrap");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("nonempty and corrupt rosters cannot issue bootstrap, expired codes cannot elevate", () => {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-"));
  try {
    const path = join(home, "principals.json"), codePath = join(home, "bootstrap-code");
    const bootstrap = new BootstrapAdmins(path, codePath);
    bootstrap.ensure(100);
    const code = readFileSync(codePath, "utf8").trim();
    assert.equal(bootstrap.redeem(code, "feishu:alice", "Alice", 1, 100 + 24 * 60 * 60 * 1000), false);
    new Principals(path).save([{ id: "bob", name: "Bob", role: "viewer", identities: ["feishu:bob"] }]);
    assert.equal(bootstrap.ensure(), false);
    assert.equal(bootstrap.redeem(code, "feishu:alice", "Alice", 1, 101), false);
    writeFileSync(path, "broken");
    assert.throws(() => bootstrap.ensure());
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("independent processes race for bootstrap with exactly one winner", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const home = mkdtempSync(join(tmpdir(), "bootstrap-process-"));
  try {
    const path = join(home, "principals.json"), codePath = join(home, "bootstrap-code");
    new BootstrapAdmins(path, codePath).ensure();
    const source = `import { BootstrapAdmins } from ${JSON.stringify(new URL("./bootstrap.ts", import.meta.url).href)}; import {readFileSync} from 'node:fs'; const [path,codePath,identity]=process.argv.slice(1); console.log(new BootstrapAdmins(path,codePath).redeem(process.env.FIXTURE_CODE,identity,identity,1));`;
    const code = readFileSync(codePath, "utf8").trim();
    const results = await Promise.all(["feishu:a", "feishu:b"].map(identity => run(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source, path, codePath, identity], { env: { ...process.env, FIXTURE_CODE: code } })));
    assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ["false", "true"]);
    assert.equal(new Principals(path).list().length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a crashed lock holder cannot strand bootstrap after restart", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const home = mkdtempSync(join(tmpdir(), "bootstrap-crash-"));
  try {
    const path = join(home, "principals.json"), codePath = join(home, "bootstrap-code");
    new BootstrapAdmins(path, codePath).ensure();
    const source = `import {withRosterLock} from ${JSON.stringify(new URL("./roster-lock.ts", import.meta.url).href)}; withRosterLock(process.argv[1],()=>{process.stdout.write('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)});`;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source, path], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const code = readFileSync(codePath, "utf8").trim();
      assert.equal(new BootstrapAdmins(path, codePath).redeem(code, "feishu:a", "A", 1), true);
    } finally { child.kill("SIGKILL"); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
