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
    const profile = args[1]!;
    assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${m.dirs.work}"\\)`), "the work directory is writable");
    assert.ok(!profile.includes(`(subpath "${m.dirs.outside}")`), "starting a command somewhere does not make it writable");
    assert.match(profile, new RegExp(`\\(deny file-write\\* .*\\(subpath "${m.dirs.vendor}"\\)`), "a ro root under a rw one stays read-only");
    assert.match(profile, /\(deny file-read\* \(subpath "[^"]*\/\.ssh"\)/, "credentials are unreadable");
    assert.match(profile, /\(remote ip "localhost:3128"\)/, "network only to the egress proxy");
    assert.deepEqual(args.slice(2), ["nice", "-n", "19", "/bin/bash", "-lc", "true"]);
    assert.match(wrapped.rules.join("\n"), /no reads at all under ~\/\.ssh/);
    assert.ok(lines.some(line => line.includes("exec [agent:a1] under sandbox-exec")), "the start is a line in the box's log");

    const block = confine.violations(wrapped, { exit_code: 1, stderr: `bash: ${m.dirs.outside}/x: Operation not permitted` }, { what: "exec", actor: "agent:a1" });
    assert.match(block ?? "", /<sandbox_violations>[\s\S]*granting the directory rw/, "the agent is told which rule and how it is widened");
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
    const run = (command: string) => runShell({ command, cwd: m.dirs.work, actor: "agent:a1" }, {}, undefined, confine);

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

    await run(`rm -rf ${m.dirs.outside}`);
    assert.equal(readFileSync(join(m.dirs.outside, "keep.txt"), "utf8"), "keep\n", "rm -rf outside the roots removed nothing");
    assert.equal(readFileSync(join(m.dirs.docs, "readme.md"), "utf8"), "docs\n");
  } finally {
    m.dispose();
  }
});
