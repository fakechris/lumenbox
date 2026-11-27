/**
 * The home's format number (docs/05 §2.0, docs/106 §6): a newer home is refused, an older one is
 * brought forward in order and stamped, a failed migration changes no number and is retried, and
 * a home 0.4.9 wrote still opens. The last test is the one a future format change must keep
 * green: `src/fixtures/home-0.4.9/` is what that release wrote, kept as files
 * (scripts/upgrade-fixture.ts says how), opened here by the code as it is now.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "./agents/registry.ts";
import { loadConfig } from "./config.ts";
import { HOME_FORMAT_FILE, HOME_FORMAT_LEDGER, HOME_MIGRATIONS, type HomeMigration, HomeFormatError, openHome, readFormatLedger } from "./home-format.ts";
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

test("the command line passes through it: a home it cannot read stops the command, a 0.4.9 home is stamped and answered from, help needs no home", t => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const run = (home: string, ...args: string[]) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch(t), AGENTBOX_TEST: "1", AGENTBOX_HOME: home } });

  const newer = oldHome(t);
  writeFileSync(join(newer, HOME_FORMAT_FILE), "99\n");
  const refused = run(newer, "agents");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /error: The data in .* is format 99\. A newer LumenBox wrote this home/);
  assert.equal(refused.stdout, "", "the command did not run");
  assert.equal(run(newer, "help").status, 0, "help is not held hostage by a home");
  assert.equal(formatOf(newer), "99\n");

  const home = join(scratch(t), "home");
  cpSync(FIXTURE, home, { recursive: true });
  const listed = run(home, "agents");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Nova/);
  assert.equal(formatOf(home), `${CURRENT}\n`);
});
