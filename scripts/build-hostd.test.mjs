import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./test-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const guard = join(root, "scripts/test-network-guard.mjs");

async function checkHostd(dir, args, env, ready, check) {
  const child = spawn(process.execPath, ["--import", guard, join(dir, "hostd.mjs"), ...args], {
    cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  const closed = new Promise(resolve => { child.once("close", resolve); });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const output = await new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8").on("data", chunk => {
        stdout += chunk;
        if (ready.test(stdout)) resolve(stdout);
      });
      child.once("error", reject);
      child.once("close", code => reject(new Error(`hostd exited (${code}): ${stdout}\n${stderr}`)));
    });
    await check(output);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

test("the standalone Docker host bundle uses the release build stamp", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lumenbox-hostd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const env = { ...hermeticEnv(), HOME: dir, AGENTBOX_HOME: join(dir, "home"), AGENTBOX_BOX_HOST: "127.0.0.1" };
  execFileSync(process.execPath, [join(root, "scripts/build-hostd.mjs"), dir], { cwd: dir, env, timeout: 30_000 });

  const config = join(dir, "kubeconfig");
  writeFileSync(config, `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: fake
`);
  await checkHostd(dir, ["control", "up", "--allocator", "kubernetes", "--port", "0", "--sweep-seconds", "0"], {
    ...env, KUBECONFIG: config, AGENTBOX_CONTROL_USERS: "alice:test:acme",
  }, /sign in.*gateway\/login/, output => {
    assert.ok(output.includes(`kubernetes (fakechris/lumenbox:${version})`), output);
  });

  const webReady = /agentbox web.*on (http:\/\/127\.0\.0\.1:\d+)[^\n]*\n/;
  await checkHostd(dir, ["web", "--port", "0", "--no-box"], env, webReady, async output => {
    const response = await fetch(`${webReady.exec(output)[1]}/api/state`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).build, { version, commit });
  });
});
