/**
 * The host sandbox (INV-1344): the rules it writes, the refusal when it cannot apply them, and —
 * where the OS has the mechanism — what a real child process can and cannot do under it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { HostSandbox, sandboxViolations } from "./host-sandbox.ts";

const run = promisify(execFile);
const live = new HostSandbox();
const unavailable = live.unavailableReason();

function home(): { home: string; cwd: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "host-sandbox-"));
  const homeDir = join(root, "home");
  const cwd = join(homeDir, "work");
  mkdirSync(join(homeDir, ".ssh"), { recursive: true });
  mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
  writeFileSync(join(homeDir, ".zshrc"), "# rc\n");
  return { home: homeDir, cwd, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("the rules are written in words and in the profile: cwd and tmp writable, the credential places denied even under cwd, network only to the named ports", () => {
  const h = home();
  try {
    const sandbox = new HostSandbox({ platform: "darwin", home: h.home, probe: () => true });
    const wrapped = sandbox.wrap("/bin/sh", ["-c", "true"], { cwd: h.cwd, allowWrite: [join(h.home, "extra")], loopbackPorts: [8791] });
    assert.equal(wrapped.mechanism, "sandbox-exec");
    assert.equal(wrapped.command, "/usr/bin/sandbox-exec");
    const profile = wrapped.args[1]!;
    const real = realpathSync(h.cwd);
    assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${real}"\\)`), "cwd writable, by its real path");
    assert.match(profile, /\(deny file-write\* .*\.ssh"\)/, "~/.ssh denied");
    assert.match(profile, /\.zshrc/, "shell rc denied");
    assert.match(profile, /\.git\/hooks/, "hooks under cwd denied, after the cwd allow so the deny wins");
    assert.ok(profile.indexOf("(deny file-write* (subpath") > profile.indexOf("(allow file-write*"), "denies come after allows");
    assert.match(profile, /\(deny network-outbound\)\(allow network-outbound \(remote ip "localhost:8791"\)\)/);
    assert.match(wrapped.rules.join("\n"), /writes only under .*work/);
    assert.match(wrapped.rules.join("\n"), /never under .*~\/\.ssh/);
    assert.match(wrapped.rules.join("\n"), /loopback port 8791/);

    const linux = new HostSandbox({ platform: "linux", home: h.home, probe: () => true }).wrap("/bin/echo", ["hi"], { cwd: h.cwd });
    assert.equal(linux.command, "bwrap");
    assert.ok(linux.args.includes("--unshare-net") && linux.args.includes("--unshare-pid"));
    assert.ok(linux.args.indexOf("--ro-bind") < linux.args.indexOf("--bind"), "root read-only first, writable paths bound back in");
    assert.match(linux.rules.join("\n"), /no network at all/);
  } finally {
    h.dispose();
  }
});

test("unavailable means refused with the reason, never a bare run", () => {
  const none = new HostSandbox({ platform: "linux", probe: () => false });
  assert.match(none.unavailableReason() ?? "", /bubblewrap/);
  assert.throws(() => none.wrap("/bin/true", [], { cwd: tmpdir() }), /Not run: the host sandbox is unavailable/);
  assert.match(new HostSandbox({ platform: "win32" }).unavailableReason() ?? "", /no OS sandbox/);
});

test("the violations block appears only for a failed command whose output looks like a refusal, and names the rules", () => {
  const wrapped = { mechanism: "sandbox-exec" as const, rules: ["writes only under /w", "no network at all"] };
  assert.equal(sandboxViolations(wrapped, { code: 0, stderr: "Operation not permitted" }), undefined, "a success is not a violation");
  assert.equal(sandboxViolations(wrapped, { code: 1, stderr: "no such file" }), undefined, "an unrelated failure is not blamed on the sandbox");
  const block = sandboxViolations(wrapped, { code: 1, stderr: "touch: x: Operation not permitted" })!;
  assert.match(block, /^<sandbox_violations>\n/);
  assert.match(block, /- writes only under \/w\n- no network at all/);
  assert.match(block, /<\/sandbox_violations>$/);
});

test("under the real sandbox: a write in cwd succeeds, ~/.ssh and .git/hooks are refused, the network is refused, loopback to the named port works", { skip: unavailable }, async () => {
  const h = home();
  const { createServer } = await import("node:net");
  const server = createServer(socket => socket.end("pong"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const sandbox = new HostSandbox({ home: h.home });
    const script = [
      "cd \"$1\"",
      "echo hi > in-cwd.txt && echo CWD_OK",
      "touch \"$2/.ssh/key\" 2>/dev/null && echo SSH_WRITTEN || echo SSH_DENIED",
      "touch .git/hooks/pre-commit 2>/dev/null && echo HOOK_WRITTEN || echo HOOK_DENIED",
      "touch \"$2/.zshrc\" 2>/dev/null && echo RC_WRITTEN || echo RC_DENIED",
      "echo x > \"$TMPDIR/host-sandbox-probe-$$\" 2>/dev/null && echo TMP_OK || echo TMP_DENIED",
    ].join("; ");
    // The network leg only on macOS: inside bwrap's namespace the loopback is bridged by socat
    // from the host's Unix socket (host-egress.ts), which this test does not start.
    const net = process.platform === "darwin" ? `; (curl -s -m 3 http://93.184.216.34/ >/dev/null 2>&1 && echo NET_OPEN || echo NET_DENIED); (echo ping | nc -w 2 127.0.0.1 ${port} | grep -q pong && echo LOOP_OK || echo LOOP_DENIED)` : "";
    const wrapped = sandbox.wrap("/bin/sh", ["-c", script + net, "sh", h.cwd, h.home], { cwd: h.cwd, loopbackPorts: [port] });
    const { stdout } = await run(wrapped.command, wrapped.args, { env: { ...process.env, ...wrapped.env, TMPDIR: tmpdir() }, cwd: h.cwd, timeout: 30_000 });
    const lines = stdout.trim().split("\n");
    assert.ok(lines.includes("CWD_OK"), stdout);
    assert.ok(lines.includes("SSH_DENIED"), stdout);
    assert.ok(lines.includes("HOOK_DENIED"), stdout);
    assert.ok(lines.includes("RC_DENIED"), stdout);
    assert.ok(lines.includes("TMP_OK"), stdout);
    if (process.platform === "darwin") {
      assert.ok(lines.includes("NET_DENIED"), stdout);
      assert.ok(lines.includes("LOOP_OK"), stdout);
    }
  } finally {
    server.close();
    h.dispose();
  }
});
