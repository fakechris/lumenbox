import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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

test("the standalone Docker host bundle uses the release build stamp and loads Markdown and Feishu", async t => {
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
  await checkHostd(dir, ["web", "--port", "0", "--no-box"], {
    ...env, SMOKE_APP_ID: "cli_smoke", SMOKE_APP_SECRET: "fixture",
  }, webReady, async output => {
    const base = webReady.exec(output)[1];
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(`${base}/api/state`, { signal });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).build, { version, commit });

    const markdown = await fetch(`${base}/vendor/markdown-it.js`, { signal });
    assert.equal(markdown.status, 200);
    const browser = { atob, TextDecoder };
    runInNewContext(await markdown.text(), browser);
    assert.equal(browser.markdownit().renderInline("**ready**"), "<strong>ready</strong>");

    const saved = await fetch(`${base}/api/channels/records`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ id: "smoke", type: "feishu" }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { restartNeeded: false, started: true });
    for (;;) {
      const { channels } = await (await fetch(`${base}/api/channels?lang=en`, { signal })).json();
      const channel = channels.find(entry => entry.name === "smoke");
      assert.ok(channel, "Feishu door is missing");
      if (channel.detail !== "starting") {
        assert.equal(channel.running, true, channel.detail);
        break;
      }
      await setTimeout(25, undefined, { signal });
    }
  });
});
