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
    assert.doesNotMatch(profile, /mach-lookup|process-exec/, "a host command keeps the Keychain: hiding it is the native box's rule");
    // The native box hides the Keychain (INV-1711): a service, so the Mach lookups are refused, not only the files.
    mkdirSync(join(h.home, "Library", "Keychains"), { recursive: true });
    const hidden = sandbox.wrap("/bin/sh", ["-c", "true"], { cwd: h.cwd, hideCredentials: true }).args[1]!;
    assert.match(hidden, /\(deny mach-lookup [^)]*\(global-name "com\.apple\.SecurityServer"\)[^)]*\)?.*\(global-name-prefix "com\.apple\.securityd"\)/, "securityd and secd cannot be asked for an item");
    assert.match(hidden, /\(deny process-exec \(literal "\/usr\/bin\/security"\)\)/, "and the security tool does not start");
    assert.match(hidden, /\(deny file-read\* [^\n]*Library\/Keychains"\)/, "nor are the keychain files readable");
    assert.doesNotMatch(hidden, /com\.apple\.trustd/, "certificate checks still reach trustd");
    // And no Unix socket but the box's own (INV-1716): not the person's ssh-agent, docker.sock, tmux, mDNSResponder.
    assert.match(profile, /\(allow network-outbound \(remote unix-socket\)\)$/, "a host command, asked for each time, keeps them");
    assert.doesNotMatch(hidden, /\(remote unix-socket\)\)/, "the native box has no blanket socket allow");
    assert.ok(hidden.endsWith(`(allow network-outbound (remote unix-socket (subpath "${realpathSync(h.cwd)}")))`), "only sockets under its own root, after the network deny");
    const boxArgs = sandbox.wrap("/bin/sh", ["-c", "true"], { cwd: h.cwd, hideCredentials: true }).args;
    assert.deepEqual(boxArgs.slice(2, 5), ["/usr/bin/env", "-u", "SSH_AUTH_SOCK"], "and the variables naming a socket are unset before the command starts");
    assert.ok(boxArgs.includes("DOCKER_HOST"));

    const linux = new HostSandbox({ platform: "linux", home: h.home, probe: () => true }).wrap("/bin/echo", ["hi"], { cwd: h.cwd });
    assert.equal(linux.command, "bwrap");
    assert.ok(linux.args.includes("--unshare-net") && linux.args.includes("--unshare-pid"));
    assert.ok(linux.args.indexOf("--ro-bind") < linux.args.indexOf("--bind"), "root read-only first, writable paths bound back in");
    assert.match(linux.rules.join("\n"), /no network at all/);
    // The native box's extra rules (INV-1700): a start directory that grants nothing, a ro path, hidden credentials.
    // On Linux the secret stores are sockets in the runtime directory: the session bus Secret Service answers on, gpg-agent's (INV-1711);
    // so are systemd's, rootless docker's and a desktop's ssh-agent, so the whole directory goes (INV-1716). Sockets are files, so bwrap hides them.
    const runtime = join(h.home, "..", "run");
    mkdirSync(join(runtime, "gnupg"), { recursive: true });
    writeFileSync(join(runtime, "bus"), "");
    const fakeTmp = join(h.home, "..", "systmp");
    // An agent started outside /tmp (a /tmp one is behind the private /tmp already, INV-1724).
    const agentDir = join(h.home, "..", "agents", "ssh-abc");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(fakeTmp, { recursive: true });
    writeFileSync(join(agentDir, "agent.1"), "");
    mkdirSync(join(h.home, ".orbstack", "run"), { recursive: true });
    const native = new HostSandbox({ platform: "linux", home: h.home, runtimeDir: runtime, tmp: fakeTmp, systemTmp: fakeTmp, sshAuthSock: join(agentDir, "agent.1"), probe: () => true }).wrap("/bin/echo", ["hi"], { cwd: h.cwd, runIn: h.home, readOnly: [join(h.cwd, "vendor")], hideCredentials: true });
    const at = (flag: string, path: string) => native.args.findIndex((arg, i) => arg === flag && native.args[i + 1] === path);
    assert.equal(native.args[native.args.indexOf("--chdir") + 1], realpathSync(h.home), "starts where asked");
    assert.ok(!native.args.some((arg, i) => arg === "--bind" && native.args[i + 1] === realpathSync(h.home)), "without making it writable");
    assert.ok(at("--tmpfs", realpathSync(join(h.home, ".ssh"))) > at("--bind", real), "~/.ssh is hidden, after the writable binds so it covers them");
    assert.ok(at("--remount-ro", realpathSync(join(h.home, ".ssh"))) > at("--tmpfs", realpathSync(join(h.home, ".ssh"))), "and read-only, so a write there fails rather than vanishing");
    assert.ok(at("--tmpfs", realpathSync(runtime)) > at("--bind", real), "the runtime directory is gone: no session bus, no gpg-agent, no systemd");
    assert.ok(at("--tmpfs", realpathSync(agentDir)) > 0, "the person's ssh-agent directory is gone");
    assert.ok(at("--tmpfs", realpathSync(join(h.home, ".orbstack", "run"))) > 0, "and a container engine's socket directory");
    assert.match(native.args.at(native.args.indexOf("-c") + 1)!, /^unset SSH_AUTH_SOCK [^;]*DOCKER_HOST[^;]*; /, "and the variables naming them are unset");
  } finally {
    h.dispose();
  }
});

test("on Linux a box command gets a /tmp of its own: the shared one, and every socket the person opens there, is not bound in; the egress bridge is, read-only (INV-1724)", async () => {
  const h = home();
  const { createServer } = await import("node:net");
  const systemTmp = realpathSync(mkdtempSync(join(tmpdir(), "hs-systmp-")));
  const own = join(h.cwd, ".tmp");
  mkdirSync(own, { recursive: true });
  const servers = [join(systemTmp, "ssh-abc", "agent.1"), join(systemTmp, "agentbox-host-port-8791.sock")].map(path => {
    mkdirSync(join(path, ".."), { recursive: true });
    const server = createServer();
    return { path, server, up: new Promise<void>(resolve => server.listen(path, resolve)) };
  });
  // A repository granted under the shared /tmp, with a hook place in it, stays the box's.
  const repo = join(systemTmp, "scratch-repo");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  try {
    await Promise.all(servers.map(entry => entry.up));
    const sandbox = new HostSandbox({ platform: "linux", home: h.home, tmp: systemTmp, systemTmp, sshAuthSock: servers[0]!.path, probe: () => true });
    const box = sandbox.wrap("/bin/true", [], { cwd: h.cwd, allowWrite: [systemTmp, repo], loopbackPorts: [8791, 8792], hideCredentials: true, privateTmp: own });
    const at = (...triple: string[]) => box.args.findIndex((_, i) => triple.every((arg, k) => box.args[i + k] === arg));
    assert.ok(at("--bind", realpathSync(own), systemTmp) > 0, "the box's own directory is its /tmp");
    assert.equal(at("--bind", systemTmp, systemTmp), -1, "the shared one is never bound in, so a socket made there later is not in it");
    const bridge = servers[1]!.path;
    assert.ok(at("--ro-bind", bridge, bridge) > at("--bind", realpathSync(own), systemTmp), "the egress bridge is bound in on top, read-only");
    assert.equal(box.args.filter(arg => arg.includes("agentbox-host-port-8792")).length, 1, "a bridge not listening yet is not bound (bwrap cannot bind what is not there); only socat names it");
    assert.ok(at("--bind", repo, repo) > at("--bind", realpathSync(own), systemTmp), "a root granted under /tmp is bound after it");
    assert.ok(at("--ro-bind", join(repo, ".git", "hooks"), join(repo, ".git", "hooks")) > 0, "with its hooks still read-only");
    assert.ok(!box.args.some(arg => arg.startsWith(join(systemTmp, "ssh-abc"))), "nothing else under /tmp is named: the agent there is gone with it, no sweep");
    assert.match(box.rules.join("\n"), /a \/tmp of its own/);
    const empty = sandbox.wrap("/bin/true", [], { cwd: h.cwd, hideCredentials: true });
    assert.ok(empty.args.some((arg, i) => arg === "--tmpfs" && empty.args[i + 1] === systemTmp), "with no directory named, /tmp is an empty one");
    const host = sandbox.wrap("/bin/true", [], { cwd: h.cwd, privateTmp: own }).args;
    assert.ok(host.some((arg, i) => arg === "--bind" && host[i + 1] === systemTmp && host[i + 2] === systemTmp), "a host command, asked for each time, keeps the shared /tmp");
  } finally {
    for (const entry of servers) entry.server.close();
    rmSync(systemTmp, { recursive: true, force: true });
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
