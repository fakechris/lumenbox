/**
 * The native box's shell under the OS sandbox (INV-1700): the rules it is given, the refusal when
 * the sandbox cannot be applied, and — where this machine has the mechanism — what a real command
 * can and cannot do. Hermetic: temporary directories only, a fake home, never the real one.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostSandbox } from "../host/host-sandbox.ts";
import { ConfinementRefused, confinementFor } from "./confinement.ts";
import { Roots } from "./headless.ts";
import { AcpService } from "./acp-service.ts";
import { JobService } from "./job-service.ts";
import { runShell } from "./shell-service.ts";

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "boxd-confinement-")));
  const dirs = { home: join(root, "home"), work: join(root, "home", "work"), docs: join(root, "home", "docs"), vendor: join(root, "home", "work", "vendor"), outside: join(root, "home", "elsewhere"), tmp: join(root, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(dirs.home, ".ssh"), { recursive: true });
  writeFileSync(join(dirs.home, ".ssh", "id_ed25519"), "SECRET-KEY\n");
  // The person's own engine logins (INV-1710): the box runs its engines elsewhere and never sees these.
  mkdirSync(join(dirs.home, ".claude"), { recursive: true });
  writeFileSync(join(dirs.home, ".claude", ".credentials.json"), "ENGINE-LOGIN\n");
  mkdirSync(join(dirs.home, ".codex"), { recursive: true });
  writeFileSync(join(dirs.home, ".codex", "auth.json"), "ENGINE-LOGIN\n");
  writeFileSync(join(dirs.outside, "keep.txt"), "keep\n");
  writeFileSync(join(dirs.docs, "readme.md"), "docs\n");
  const roots = new Roots([{ path: dirs.work, mode: "rw" }, { path: dirs.docs, mode: "ro" }, { path: dirs.vendor, mode: "ro" }]);
  return { root, dirs, roots, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("a Docker box is not confined by this: the container is its wall", () => {
  assert.equal(confinementFor({ headless: false, roots: () => new Roots([]), egressPort: () => undefined, log: () => {} }), undefined);
});

test("the rules a headless box's commands run under: rw roots and temp writable, ro roots and credentials not, the start directory grants nothing", () => {
  const m = machine();
  try {
    const lines: string[] = [];
    const confine = confinementFor({ headless: true, roots: () => m.roots, workDir: m.dirs.work, egressPort: () => 3128, log: line => lines.push(line), systemTmp: m.dirs.tmp, sandbox: new HostSandbox({ platform: "darwin", home: m.dirs.home, tmp: m.dirs.tmp, probe: () => true }) })!;
    const { command, args, wrapped } = confine.wrap("nice", ["-n", "19", "/bin/bash", "-lc", "true"], { what: "exec", cwd: m.dirs.outside, actor: "agent:a1" });
    assert.equal(command, "/usr/bin/sandbox-exec");
    assert.deepEqual(confine.state(), { active: true });
    const profile = args[1]!;
    assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${m.dirs.work}"\\)`), "the work directory is writable");
    assert.ok(!profile.includes(`(subpath "${m.dirs.outside}")`), "starting a command somewhere does not make it writable");
    assert.match(profile, new RegExp(`\\(deny file-write\\* .*\\(subpath "${m.dirs.vendor}"\\)`), "a ro root under a rw one stays read-only");
    assert.match(profile, /\(deny file-read\* \(subpath "[^"]*\/\.ssh"\)/, "credentials are unreadable");
    assert.match(profile, /\(remote ip "localhost:3128"\)/, "network only to the egress proxy");
    assert.deepEqual(args.slice(2), ["nice", "-n", "19", "/bin/bash", "-lc", "true"]);
    assert.match(wrapped.rules.join("\n"), /no reads at all under ~\/\.ssh/);
    assert.ok(lines.some(line => line.includes("exec [agent:a1] under sandbox-exec")), "the start is a line in the box's log");
    // Tools and engines keep their state in the agent's own directory under the work directory (INV-1710), never in the person's home.
    const state = join(m.dirs.work, ".state", "a1");
    const { env } = confine.wrap("/bin/true", [], { what: "acp", actor: "agent:a1" });
    assert.equal(env.XDG_CACHE_HOME, join(state, "cache"));
    assert.equal(env.npm_config_cache, join(state, "npm"));
    assert.equal(env.CLAUDE_CONFIG_DIR, join(state, "claude"));
    assert.equal(env.CODEX_HOME, join(state, "codex"));
    assert.ok(existsSync(env.CODEX_HOME!), "each one exists before the engine starts; Codex refuses one that does not");
    const denies = (op: string) => profile.slice(profile.indexOf(`(deny ${op}* (subpath`)).split(")(")[0]!;
    for (const engine of [".claude", ".codex"]) {
      assert.ok(denies("file-read").includes(`(subpath "${join(m.dirs.home, engine)}")`), `the person's own ${engine} is hidden`);
      assert.ok(denies("file-write").includes(`(subpath "${join(m.dirs.home, engine)}")`), `and not writable, even if a parent were granted rw`);
    }
    assert.equal(confine.wrap("/bin/true", [], { what: "exec", actor: "agent:../../x" }).env.XDG_STATE_HOME, join(m.dirs.work, ".state", "_.._x", "state"), "an actor cannot name its way out of the state directory");

    const block = confine.violations(wrapped, { exit_code: 1, stderr: `bash: ${m.dirs.outside}/x: Operation not permitted` }, { what: "exec", actor: "agent:a1" });
    assert.match(block ?? "", /<sandbox_violations>[\s\S]*\.state\/a1[\s\S]*granting a directory rw/, "the agent is told which rule, where its state goes, and how it is widened");
    assert.ok(lines.some(line => /refused by the sandbox, exec \[agent:a1\] \(exit 1\)/.test(line)), "and the refusal is an audit line");
  } finally {
    m.dispose();
  }
});

test("where the sandbox is unavailable nothing runs — not a command, not a job, not an engine — and the reason is said", async () => {
  const m = machine();
  try {
    const lines: string[] = [];
    const confine = confinementFor({ headless: true, roots: () => m.roots, workDir: m.dirs.work, egressPort: () => undefined, log: line => lines.push(line), sandbox: new HostSandbox({ platform: "linux", home: m.dirs.home, probe: () => false }) })!;
    const marker = join(m.dirs.work, "ran.txt");
    await assert.rejects(runShell({ command: `touch ${marker}`, cwd: m.dirs.work, actor: "agent:a1" }, {}, undefined, confine), (error: unknown) => error instanceof ConfinementRefused && /bubblewrap/.test(error.message) && /no way to run bare/.test(error.message));
    const jobs = new JobService(join(m.dirs.work, ".jobs"));
    assert.throws(() => jobs.start({ command: `touch ${marker}`, cwd: m.dirs.work, nice: 0, scrubbedEnv: {}, confine }), ConfinementRefused);
    assert.deepEqual(jobs.list(), [], "a refused job takes no slot");
    const engines = new AcpService(join(m.dirs.work, ".acp"));
    await assert.rejects(engines.open({ session_id: "job-0123abcd", command: `touch ${marker}`, cwd: m.dirs.work, nice: 0, scrubbedEnv: {}, confine }), ConfinementRefused);
    assert.equal(existsSync(join(m.dirs.work, ".acp", "job-0123abcd.log")), false, "a refused engine leaves no log");
    assert.equal(existsSync(marker), false, "nothing ran");
    assert.ok(lines.filter(line => line.startsWith("confinement: refused")).length >= 2, "each refusal is an audit line");
    assert.match(confine.describe(), /every command is refused/);
    assert.equal(confine.state().active, false, "and the health answer says so, which keeps an organisation node's native environment closed to members (INV-1697)");
  } finally {
    m.dispose();
  }
});

const live = new HostSandbox();
const unavailable = live.unavailableReason();

test("under the real sandbox: writes land in the rw root and temp only; outside, a ro root and a credential read are refused; rm -rf outside does nothing", { skip: unavailable }, async () => {
  const m = machine();
  try {
    const lines: string[] = [];
    const confine = confinementFor({ headless: true, roots: () => m.roots, workDir: m.dirs.work, egressPort: () => undefined, log: line => lines.push(line), systemTmp: m.dirs.tmp, sandbox: new HostSandbox({ home: m.dirs.home, tmp: m.dirs.tmp }) })!;
    // HOME is the fake one too, so nothing here reads the real home's npm or engine config.
    const run = (command: string) => runShell({ command, cwd: m.dirs.work, actor: "agent:a1", env: { HOME: m.dirs.home } }, {}, undefined, confine);

    const inside = await run("echo ok > inside.txt");
    assert.equal(inside.exit_code, 0, inside.stderr);
    assert.equal(readFileSync(join(m.dirs.work, "inside.txt"), "utf8"), "ok\n");
    assert.equal((await run(`echo ok > ${m.dirs.tmp}/t.txt`)).exit_code, 0, "the temp directory is writable");

    const outside = await run(`echo pwned > ${m.dirs.outside}/new.txt`);
    assert.notEqual(outside.exit_code, 0);
    assert.equal(existsSync(join(m.dirs.outside, "new.txt")), false, "a write outside the roots did not happen");
    assert.match(outside.stderr, /<sandbox_violations>/, "and the agent is told why");
    assert.ok(lines.some(line => line.startsWith("confinement: refused by the sandbox")), "with an audit line");

    assert.notEqual((await run(`touch ${m.dirs.docs}/x`)).exit_code, 0);
    assert.equal(existsSync(join(m.dirs.docs, "x")), false, "a ro root is not writable");
    assert.notEqual((await run(`touch ${m.dirs.vendor}/x`)).exit_code, 0);
    assert.equal(existsSync(join(m.dirs.vendor, "x")), false, "nor a ro root under the rw one");

    const key = await run(`cat ${m.dirs.home}/.ssh/id_ed25519`);
    assert.doesNotMatch(key.stdout, /SECRET-KEY/, "a credential is not readable");

    // An agent's tools and engines write their state in its own directory (INV-1710); the home stays shut.
    const state = join(m.dirs.work, ".state", "a1");
    const cache = await run('echo cached > "$XDG_CACHE_HOME/tool.txt" && echo "$XDG_CACHE_HOME"');
    assert.equal(cache.exit_code, 0, cache.stderr);
    assert.equal(cache.stdout.trim(), join(state, "cache"));
    assert.equal(readFileSync(join(state, "cache", "tool.txt"), "utf8"), "cached\n", "the write landed in the state directory");
    assert.notEqual((await run(`mkdir -p ${m.dirs.home}/.cache && echo x > ${m.dirs.home}/.cache/tool.txt`)).exit_code, 0);
    assert.equal(existsSync(join(m.dirs.home, ".cache", "tool.txt")), false, "and not in the home");
    assert.notEqual((await run(`echo pwned > ${m.dirs.home}/.ssh/authorized_keys`)).exit_code, 0);
    assert.equal(existsSync(join(m.dirs.home, ".ssh", "authorized_keys")), false, "~/.ssh is still not writable");
    const login = await run(`cat ${m.dirs.home}/.claude/.credentials.json ${m.dirs.home}/.codex/auth.json`);
    assert.doesNotMatch(login.stdout, /ENGINE-LOGIN/, "the person's own engine logins are not readable");
    assert.notEqual((await run(`echo x > ${m.dirs.home}/.codex/config.toml`)).exit_code, 0);
    assert.equal(existsSync(join(m.dirs.home, ".codex", "config.toml")), false, "nor writable");
    const npm = await run("command -v npm >/dev/null || { echo no-npm; exit 0; }; npm config get cache");
    if (npm.stdout.trim() !== "no-npm") assert.equal(npm.stdout.trim().split("\n").at(-1), join(state, "npm"), `npm's cache is the state directory's: ${npm.stderr}`);
    // A job and an engine get the same directory: what the agent's engine saved, its next run finds.
    const jobs = new JobService(join(m.dirs.work, ".jobs"));
    const job = jobs.start({ command: 'echo saved > "$CODEX_HOME/session.txt"', cwd: m.dirs.work, nice: 0, scrubbedEnv: { ...process.env, HOME: m.dirs.home, CODEX_HOME: join(m.dirs.home, ".codex") }, actor: "agent:a1", confine });
    const ended = await jobs.wait({ job_id: job.job_id, timeout_ms: 20_000 });
    assert.equal(ended?.exit_code, 0, ended?.tail ?? "");
    assert.equal(readFileSync(join(state, "codex", "session.txt"), "utf8"), "saved\n", "the box's state directory wins over a CODEX_HOME the person's environment named");

    await run(`rm -rf ${m.dirs.outside}`);
    assert.equal(readFileSync(join(m.dirs.outside, "keep.txt"), "utf8"), "keep\n", "rm -rf outside the roots removed nothing");
    assert.equal(readFileSync(join(m.dirs.docs, "readme.md"), "utf8"), "docs\n");
  } finally {
    m.dispose();
  }
});
