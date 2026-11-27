/**
 * The home's format number (docs/05 §2.0, docs/106 §6): a newer home is refused, an older one is
 * brought forward in order and stamped, a failed migration changes no number and is retried, and
 * a home 0.4.9 wrote still opens. The last test is the one a future format change must keep
 * green: `src/fixtures/home-0.4.9/` is what that release wrote, kept as files
 * (scripts/upgrade-fixture.ts says how), opened here by the code as it is now.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentRegistry } from "./agents/registry.ts";
import { loadConfig } from "./config.ts";
import { HOME_COMMANDS, HOME_FORMAT_FILE, HOME_FORMAT_LEDGER, HOME_MIGRATIONS, HOME_REFUSED_EXIT, HOMELESS_COMMANDS, type HomeMigration, HomeFormatError, openHome, opensHome, readFormatLedger } from "./home-format.ts";
import { TaskStore } from "./host/tasks.ts";

const CURRENT = HOME_MIGRATIONS.length;
const FIXTURE = fileURLToPath(new URL("./fixtures/home-0.4.9", import.meta.url));
const at = () => new Date("2027-01-02T03:04:05.000Z");

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-home-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A home from before the format number: it has content and no FORMAT file. */
function oldHome(t: { after(fn: () => void): void }): string {
  const home = join(scratch(t), "home");
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "config.json"), "{}\n");
  return home;
}
const formatOf = (home: string) => readFileSync(join(home, HOME_FORMAT_FILE), "utf8");

test("a home newer than this binary is refused, naming the format found and the version that wrote it, and nothing is changed", t => {
  const home = oldHome(t);
  writeFileSync(join(home, HOME_FORMAT_FILE), `${CURRENT + 2}\n`);
  assert.throws(() => openHome({ home, appVersion: "0.4.9" }), (error: unknown) => {
    assert.ok(error instanceof HomeFormatError);
    assert.match(error.message, new RegExp(`is format ${CURRENT + 2}\\. A newer LumenBox wrote this home: this is LumenBox 0\\.4\\.9, which reads up to format ${CURRENT}\\.`));
    assert.match(error.message, /Nothing was changed/);
    return true;
  });
  // The ledger knows who wrote it, so the message can say what to install.
  writeFileSync(join(home, HOME_FORMAT_LEDGER), `${JSON.stringify({ format: CURRENT + 2, from: CURRENT + 1, name: "later", at: "2027-06-01T00:00:00.000Z", appVersion: "0.6.3" })}\n`);
  assert.throws(() => openHome({ home, appVersion: "0.4.9" }), /written by LumenBox 0\.6\.3\. A newer LumenBox wrote this home.*Install LumenBox 0\.6\.3 or later/);
  assert.equal(formatOf(home), `${CURRENT + 2}\n`, "the number is as it was");
  assert.equal(readFormatLedger(home).length, 1, "and nothing was recorded");

  writeFileSync(join(home, HOME_FORMAT_FILE), "two\n");
  assert.throws(() => openHome({ home, appVersion: "0.4.9" }), /should hold one whole number and holds "two"\. Not guessing/, "an unreadable number is not read as 0");
});

test("a home with no FORMAT is format 0: brought to current in order, stamped and recorded; a new home is stamped current with nothing run", t => {
  const home = oldHome(t);
  const opened = openHome({ home, appVersion: "0.4.9", now: at, backup: () => assert.fail("a stamp needs no backup") });
  assert.deepEqual(opened, { format: CURRENT, applied: HOME_MIGRATIONS.map(migration => migration.to), created: false });
  assert.equal(formatOf(home), `${CURRENT}\n`);
  assert.deepEqual(readFormatLedger(home)[0], { format: 1, from: 0, name: HOME_MIGRATIONS[0]!.name, at: at().toISOString(), appVersion: "0.4.9" });
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{}\n", "what was there is as it was");
  assert.deepEqual(openHome({ home, appVersion: "0.4.9" }), { format: CURRENT, applied: [], created: false }, "the next start has nothing to do");
  assert.equal(readFormatLedger(home).length, CURRENT);

  for (const fresh of [join(scratch(t), "absent"), scratch(t)]) {
    const ran: number[] = [];
    const migrations: HomeMigration[] = [1, 2, 3].map(to => ({ to, name: `m${to}`, rewrites: true, run: () => void ran.push(to) }));
    assert.deepEqual(openHome({ home: fresh, appVersion: "0.9.0", now: at, migrations }), { format: 3, applied: [], created: true });
    assert.deepEqual(ran, [], "a home made at format 3 never needs the way there");
    assert.equal(formatOf(fresh), "3\n");
    assert.deepEqual(readFormatLedger(fresh), [{ format: 3, from: null, name: "new home", at: at().toISOString(), appVersion: "0.9.0" }]);
  }
});

test("a migration that throws leaves the number where it was, keeps the backup and says where; the next start retries from there", t => {
  const home = oldHome(t);
  const ran: string[] = [];
  let broken = true;
  const migrations: HomeMigration[] = [
    { to: 1, name: "stamp", rewrites: false, run: () => void ran.push("1") },
    { to: 2, name: "split the ledger", rewrites: true, run: h => { ran.push("2"); writeFileSync(join(h, "half-done"), "x"); if (broken) throw new Error("disk full"); } },
    { to: 3, name: "rename the index", rewrites: true, run: () => void ran.push("3") },
  ];
  const backups: string[] = [];
  const backup = (stamp: string) => { backups.push(stamp); ran.push("backup"); return `/backups/${stamp}`; };

  assert.throws(() => openHome({ home, appVersion: "0.5.0", now: at, migrations, backup }), (error: unknown) => {
    assert.ok(error instanceof HomeFormatError);
    assert.match(error.message, /to format 2 \(split the ledger\) failed: disk full\. The home is still format 1, and a copy from before the upgrade is at \/backups\/2027-01-02T03-04-05-before-format-2\. The next start tries again\./);
    return true;
  });
  assert.deepEqual(ran, ["1", "backup", "2"], "in order, the copy taken before the first migration that rewrites and not before the stamp");
  assert.equal(formatOf(home), "1\n", "the migration that finished is kept; the one that threw moved nothing");
  assert.deepEqual(readFormatLedger(home).map(entry => entry.format), [1]);
  assert.equal(existsSync(join(home, "FORMAT.lock")), false, "and the home is not left locked");

  broken = false;
  ran.length = 0;
  assert.deepEqual(openHome({ home, appVersion: "0.5.1", now: at, migrations, backup }).applied, [2, 3]);
  assert.deepEqual(ran, ["backup", "2", "3"], "2 runs again over its own half-finished work; one copy covers the start");
  assert.equal(formatOf(home), "3\n");
  assert.deepEqual(readFormatLedger(home).slice(1), [
    { format: 2, from: 1, name: "split the ledger", at: at().toISOString(), appVersion: "0.5.1", backup: "/backups/2027-01-02T03-04-05-before-format-2" },
    { format: 3, from: 2, name: "rename the index", at: at().toISOString(), appVersion: "0.5.1", backup: "/backups/2027-01-02T03-04-05-before-format-2" },
  ]);

  // Without a way to copy the home first, a migration that rewrites is not run at all.
  const bare = oldHome(t);
  assert.throws(() => openHome({ home: bare, appVersion: "0.5.0", migrations }), /Format 2 \(split the ledger\) rewrites stored data and there is no way to back .* up first/);
  assert.equal(existsSync(join(bare, "half-done")), false);
  assert.throws(() => openHome({ home: oldHome(t), appVersion: "0.5.0", migrations, backup: () => { throw new Error("no space"); } }), /could not be backed up before format 2 .*: no space\. Nothing was changed/);
  assert.throws(() => openHome({ home: oldHome(t), appVersion: "0.5.0", migrations: [migrations[0]!, migrations[2]!] }), /numbered 1, 2, 3/, "a gap in the registry is a programming error, said before anything runs");
});

test("one process upgrades a home at a time: a live holder is named and nothing runs; a lock a crash left is taken over", t => {
  const home = oldHome(t);
  writeFileSync(join(home, "FORMAT.lock"), `${process.ppid}\n`);
  assert.throws(() => openHome({ home, appVersion: "0.4.9" }), new RegExp(`Another LumenBox process \\(pid ${process.ppid}\\) is upgrading the data`));
  assert.equal(existsSync(join(home, HOME_FORMAT_FILE)), false);

  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(home, "FORMAT.lock"), `${dead}\n`);
  assert.equal(openHome({ home, appVersion: "0.4.9" }).format, CURRENT);
  assert.equal(existsSync(join(home, "FORMAT.lock")), false);
});

test("the home 0.4.9 wrote opens with this code: migrated, stamped, and its agents, conversation, memory, plan, work and config read back", t => {
  const home = join(scratch(t), "home");
  cpSync(FIXTURE, home, { recursive: true });
  assert.equal(existsSync(join(home, HOME_FORMAT_FILE)), false, "0.4.9 wrote no format number");

  const opened = openHome({ home, appVersion: "next", backup: stamp => join(home, "..", stamp) });
  assert.equal(opened.format, CURRENT);
  assert.equal(opened.created, false);
  assert.deepEqual(opened.applied, HOME_MIGRATIONS.map(migration => migration.to));

  const registry = new AgentRegistry(join(home, "agents"));
  assert.deepEqual(registry.list().map(agent => agent.profile.name).sort(), ["Nova", "Vera"]);
  const nova = registry.resolve("Nova");
  assert.equal(nova.profile.description, "Keeps the team's notes and answers from them.");
  assert.equal(registry.boxOf(nova.id).id, registry.box.id, "still in the installation's own box");

  const transcript = registry.readTranscript(nova.id) as { role: string; text?: string; kind?: string }[];
  assert.equal(transcript.length, 6);
  assert.equal(transcript[0]!.text, "Remember that the quarterly report goes out on the 3rd of each month.");
  assert.equal(transcript[1]!.kind, "blocks", "the tool call is still a tool call");
  assert.equal(transcript.at(-1)!.text, "That the quarterly report goes out on the 3rd of each month.");

  const memory = registry.readMemoryRecords(nova.id);
  assert.equal(memory.length, 1);
  assert.equal(memory[0]!.text, "The quarterly report goes out on the 3rd of each month.");
  assert.match(registry.readDurableState(nova.id).plan ?? "", /Keep the reporting calendar current/);

  const task = new TaskStore(join(home, "tasks.jsonl")).list().find(candidate => candidate.title === "Send the quarterly report");
  assert.equal(task?.assigneeId, nova.id);
  assert.equal(task?.status, "open");

  const before = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = before; });
  const config = loadConfig(warning => assert.fail(warning));
  assert.deepEqual({ provider: config.provider, model: config.model, channelAllow: config.channelAllow, startupItem: config.startupItem }, { provider: "anthropic", model: "claude-opus-5", channelAllow: ["feishu:ou_fixture_person"], startupItem: false });

  // The fixture is a record of what a release wrote: no credential belongs in it, and nothing here writes into it.
  const names = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? names(join(dir, entry.name)) : [entry.name]));
  assert.deepEqual(names(FIXTURE).filter(name => ["token", "ui-token", "box-owner", HOME_FORMAT_FILE, HOME_FORMAT_LEDGER].includes(name)), []);
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** The command line as a person runs it. `home` undefined leaves AGENTBOX_HOME unset, so the default is `<HOME>/.agentbox` — in a scratch HOME. */
function cli(t: { after(fn: () => void): void }, home: string | undefined, args: string[], userHome = scratch(t)): Promise<{ status: number | null; stdout: string; stderr: string; userHome: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: userHome, ...(home !== undefined ? { AGENTBOX_HOME: home, AGENTBOX_TEST: "1" } : {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("close", status => resolve({ status, stdout, stderr, userHome }));
  });
}

test("the command line passes through it: a home it cannot read stops the command with its own exit status, a 0.4.9 home is stamped and answered from", async t => {
  const newer = oldHome(t);
  writeFileSync(join(newer, HOME_FORMAT_FILE), "99\n");
  const home = join(scratch(t), "home");
  cpSync(FIXTURE, home, { recursive: true });
  const [refused, help, listed] = await Promise.all([cli(t, newer, ["agents"]), cli(t, newer, ["help"]), cli(t, home, ["agents"])]);

  assert.equal(refused.status, HOME_REFUSED_EXIT, "not the status of a crash");
  assert.match(refused.stderr, /error: The data in .* is format 99\. A newer LumenBox wrote this home/);
  assert.equal(refused.stdout, "", "the command did not run");
  assert.equal(help.status, 0, "help is not held hostage by a home");
  assert.equal(formatOf(newer), "99\n");

  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Nova/);
  assert.equal(formatOf(home), `${CURRENT}\n`);
});

test("a command that has no installation behind it makes no home: a word that is no command, a node, a box given away, the door's clients", async t => {
  // Every command the dispatch knows is on one list or the other, so a new one is a decision rather than a default.
  const source = readFileSync(CLI, "utf8");
  const dispatched = [...source.slice(source.indexOf("async function main()")).matchAll(/^ {4}case "([^"]+)":|; case "([^"]+)":/gm)].map(match => match[1] ?? match[2]!);
  assert.ok(dispatched.includes("web") && dispatched.includes("routines") && dispatched.length > 30, "the dispatch was read");
  for (const command of dispatched) assert.equal(Number(HOME_COMMANDS.has(command)) + Number(HOMELESS_COMMANDS.has(command)), 1, `${command} is on exactly one of HOME_COMMANDS and HOMELESS_COMMANDS`);
  assert.deepEqual([opensHome("box", "up"), opensHome("box", "connect"), opensHome("box", "build"), opensHome("frobnicate"), opensHome(undefined)], [true, false, false, false, false]);

  // On a machine with nothing in it: each of these stops at its own usage line, as before, and leaves no ~/.agentbox behind.
  const runs = await Promise.all([["frobnicate"], ["node", "run"], ["box", "connect"], ["watchdog"], ["supervise"], ["mcp"]].map(args => cli(t, undefined, args)));
  for (const run of runs) {
    assert.equal(run.status, 1, run.stderr);
    assert.equal(existsSync(join(run.userHome, ".agentbox")), false, `a home was made: ${readdirSync(run.userHome).join(", ")}`);
  }
  assert.match(runs[0]!.stderr, /Unknown command: frobnicate/);
  // And a command that does use one makes it, stamped.
  const made = await cli(t, undefined, ["agents"]);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(formatOf(join(made.userHome, ".agentbox")), `${CURRENT}\n`);
});

test("a home that cannot be written still answers a command that only reads; what would need writing still stops", { skip: process.getuid?.() === 0 ? "root writes anywhere" : false }, async t => {
  const home = join(scratch(t), "home");
  cpSync(FIXTURE, home, { recursive: true });
  chmodSync(home, 0o500);
  try {
  const said: string[] = [];
  assert.deepEqual(openHome({ home, appVersion: "0.4.9", log: line => said.push(line) }), { format: 0, applied: [], created: false, unstamped: true });
  assert.equal(said.length, 1, "said once");
  assert.match(said[0]!, /cannot be written \(EACCES\), so its format number was not recorded; reading it as it is/);
  assert.equal(existsSync(join(home, HOME_FORMAT_FILE)), false);

  const listed = await cli(t, home, ["agents"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Nova/, "the command ran, as it did before there was a number");
  assert.match(listed.stderr, /cannot be written/);

  // A migration that rewrites cannot be skipped: the layout would not be the one this version reads.
  const rewriting: HomeMigration[] = [{ to: 1, name: "stamp", rewrites: false, run: () => {} }, { to: 2, name: "split the ledger", rewrites: true, run: () => assert.fail("not run") }];
  assert.throws(() => openHome({ home, appVersion: "0.5.0", migrations: rewriting, backup: () => "/b" }), (error: unknown) => {
    assert.ok(error instanceof HomeFormatError);
    assert.match(error.message, /is format 0 and has to be upgraded to format 2 \(split the ledger\) before this version can use it, but it cannot be written \(EACCES\)\. Nothing was changed/);
    return true;
  });
  // And a newer home is refused whether or not it can be written.
  chmodSync(home, 0o700);
  writeFileSync(join(home, HOME_FORMAT_FILE), "99\n");
  chmodSync(home, 0o500);
  assert.throws(() => openHome({ home, appVersion: "0.4.9" }), /is format 99\. A newer LumenBox wrote this home/);
  } finally {
    chmodSync(home, 0o700); // so the scratch directory can be removed
  }
});

test("two starts at once: the second is told another process is upgrading while the first lives, reads plainly once it is done, and takes over if it was killed", async t => {
  // A process that takes the lock and stays in its migration until told to go on (or killed).
  const holder = (home: string) => {
    const script = `
      import { openHome } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./home-format.ts", import.meta.url))).href)};
      import { existsSync } from "node:fs";
      const wait = () => { while (!existsSync(${JSON.stringify(join(home, "go"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
      const opened = openHome({ home: ${JSON.stringify(home)}, appVersion: "0.4.9", migrations: [{ to: 1, name: "slow stamp", rewrites: false, run: () => { console.log("holding"); wait(); } }] });
      console.log(JSON.stringify(opened));`;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    const holding = new Promise<void>(resolve => child.stdout.on("data", chunk => { out += String(chunk); if (out.includes("holding")) resolve(); }));
    const done = new Promise<number | null>(resolve => child.on("close", status => resolve(status)));
    t.after(() => child.kill("SIGKILL"));
    return { child, holding, done, said: () => out };
  };
  const slow: HomeMigration[] = [{ to: 1, name: "slow stamp", rewrites: false, run: () => {} }];

  const home = oldHome(t);
  const first = holder(home);
  await first.holding;
  assert.throws(() => openHome({ home, appVersion: "0.4.9", migrations: slow }), (error: unknown) => {
    assert.ok(error instanceof HomeFormatError);
    assert.equal(error.transient, true, "starting again a moment later is the answer, so this is not the refused-home status");
    assert.match(error.message, new RegExp(`Another LumenBox process \\(pid ${first.child.pid}\\) is upgrading the data`));
    return true;
  });
  assert.equal(existsSync(join(home, HOME_FORMAT_FILE)), false, "the second start changed nothing");
  writeFileSync(join(home, "go"), "");
  assert.equal(await first.done, 0);
  assert.match(first.said(), /"applied":\[1\]/);
  assert.deepEqual(openHome({ home, appVersion: "0.4.9", migrations: slow }), { format: 1, applied: [], created: false }, "a third start is a plain read");
  assert.equal(readFormatLedger(home).length, 1, "brought forward once");
  assert.equal(existsSync(join(home, "FORMAT.lock")), false);

  // Killed while it held the lock: the lock names a process that is gone, and the next start takes it over.
  const abandoned = oldHome(t);
  const killed = holder(abandoned);
  await killed.holding;
  killed.child.kill("SIGKILL");
  await killed.done;
  assert.equal(readFileSync(join(abandoned, "FORMAT.lock"), "utf8").trim(), String(killed.child.pid), "the lock was left behind");
  assert.deepEqual(openHome({ home: abandoned, appVersion: "0.4.9", migrations: slow }).applied, [1]);
  assert.equal(existsSync(join(abandoned, "FORMAT.lock")), false);
});

test("the desktop app shows a refused home instead of restarting the server: the status is its own, and the dialog is the server's sentence", async t => {
  const shell = createRequire(import.meta.url)("../electron/home-refused.cjs") as { HOME_REFUSED_EXIT: number; homeRefusal(recentLog: string[]): { title: string; message: string } };
  assert.equal(shell.HOME_REFUSED_EXIT, HOME_REFUSED_EXIT, "the shell and the server agree on the number");

  // What the shell does with the server it starts: `web --desktop`, its output kept line by line.
  const newer = oldHome(t);
  writeFileSync(join(newer, HOME_FORMAT_FILE), "99\n");
  writeFileSync(join(newer, HOME_FORMAT_LEDGER), `${JSON.stringify({ format: 99, from: 98, name: "later", at: "2027-06-01T00:00:00.000Z", appVersion: "0.6.3" })}\n`);
  const server = await cli(t, newer, ["web", "--port", "0", "--desktop"]);
  assert.equal(server.status, HOME_REFUSED_EXIT, server.stderr);
  const recentLog = `${server.stdout}${server.stderr}`.split("\n").filter(line => line.trim() !== "");
  const dialog = shell.homeRefusal(recentLog);
  assert.equal(dialog.title, "LumenBox cannot open its data");
  assert.match(dialog.message, /^The data in .* is format 99, written by LumenBox 0\.6\.3\. A newer LumenBox wrote this home: .*Install LumenBox 0\.6\.3 or later to use it\. Nothing was changed/);
  assert.match(shell.homeRefusal([]).message, /did not say why/, "and a server that said nothing is still not a blank dialog");

  // The shell's exit handler takes that path before its crash counter: no retry, the dialog, then quit.
  const main = readFileSync(fileURLToPath(new URL("../electron/main.cjs", import.meta.url)), "utf8");
  const handler = main.slice(main.indexOf('serverChild.on("exit"'), main.indexOf("crashRestarts += 1"));
  assert.match(handler, /if \(code === HOME_REFUSED_EXIT\) \{[\s\S]*homeRefusal\(recentLog\)[\s\S]*dialog\.showErrorBox\(refusal\.title, refusal\.message\)[\s\S]*app\.quit\(\)[\s\S]*return;/);
});
