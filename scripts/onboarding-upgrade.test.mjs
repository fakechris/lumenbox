/** The upgrade acceptance's judgements (INV-2209): the format record, what reads back, and the refusal of a downgrade. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareVersions, downgradeExpectation, homeSnapshot, judgeFormat, judgeRefusal, knownFormat, readBackProblems, requiredFreeGb, servingProblems } from "./onboarding-upgrade.mjs";

const made = { format: 1, from: null, name: "new home", at: "t0", appVersion: "0.4.11" };
const stamp2 = { format: 2, from: 1, name: "activations nobody signed in on become roster people", at: "t1", appVersion: "0.4.12" };

test("versions compare by number, and an upgrade run asks for room for two apps and a second image", () => {
  assert.equal(compareVersions("0.4.9", "0.4.10"), -1);
  assert.equal(compareVersions("0.4.11", "0.4.11"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(requiredFreeGb({ version: "0.4.12" }), 8);
  assert.ok(requiredFreeGb({ version: "0.4.11", upgradeFrom: "0.4.11" }) > 8);
  assert.ok(requiredFreeGb({ version: "0.4.12", upgradeFrom: "0.4.11" }) > requiredFreeGb({ version: "0.4.11", upgradeFrom: "0.4.11" }), "a new version pulls a second image");
});

test("an app's format is the highest migration it ships; an app with none predates the number", () => {
  const shipped = knownFormat(readFileSync(new URL("../src/home-format.ts", import.meta.url), "utf8"));
  assert.ok(Number.isInteger(shipped) && shipped >= 2, `the registry in src/home-format.ts is found (read ${shipped})`);
  assert.equal(knownFormat(`export const HOME_MIGRATIONS = [{ to: 1, name: "x" }, { to: 2, name: "y" }];`), 2);
  assert.equal(knownFormat(undefined), undefined);
  assert.equal(knownFormat("export const nothing = 1;"), undefined);
});

test("the format record: a stamp-only upgrade adds one line by the candidate and takes no copy", () => {
  const before = { format: 1, ledger: [made], backups: [] };
  const ok = judgeFormat({ before, after: { format: 2, ledger: [made, stamp2], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12" });
  assert.deepEqual(ok.problems, []);
  assert.match(ok.detail, /1 → 2.*stamp only.*no copy was taken/);

  const backedUp = { ...stamp2, backup: "/h-backups/x-before-format-2" };
  assert.deepEqual(judgeFormat({ before, after: { format: 2, ledger: [made, backedUp], backups: ["x-before-format-2"] }, candidateFormat: 2, candidateVersion: "0.4.12", backupExists: () => true }).problems, []);
  assert.match(judgeFormat({ before, after: { format: 2, ledger: [made, backedUp], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12", backupExists: () => false }).problems.join(), /does not exist/);
  assert.match(judgeFormat({ before, after: { format: 2, ledger: [made, stamp2], backups: ["stray"] }, candidateFormat: 2, candidateVersion: "0.4.12" }).problems.join(), /no migration recorded one/);

  assert.match(judgeFormat({ before, after: { format: 1, ledger: [made], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12" }).problems.join(), /FORMAT is 1, the candidate writes 2/);
  assert.match(judgeFormat({ before, after: { format: 2, ledger: [stamp2], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12" }).problems.join(), /append-only/);
  assert.match(judgeFormat({ before, after: { format: 2, ledger: [made, { ...stamp2, appVersion: "0.4.11" }], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12" }).problems.join(), /not the candidate/);
  assert.match(judgeFormat({ before: { format: undefined, ledger: [], backups: [] }, after: { format: 2, ledger: [stamp2], backups: [] }, candidateFormat: 2, candidateVersion: "0.4.12" }).problems.join(), /expected 2/, "a home from before the number goes through every migration");
  assert.match(judgeFormat({ before, after: { format: 1, ledger: [made], backups: [] }, candidateFormat: 1, candidateVersion: "0.4.12" }).detail, /no migration owed/);
});

test("read back: every seeded item is named when the candidate does not show it", () => {
  const seed = { word: "ZEPHYR1", agent: { id: "a2", name: "Probe" }, said: ["one", "two"], replies: 2, routine: { slug: "probe", schedule: "0 9 * * 1" }, task: { id: "t1", title: "Task ZEPHYR1" }, provider: "MiniMax m3" };
  const seen = { agents: [{ id: "a1", name: "Ada" }, { id: "a2", name: "Probe" }], userTexts: ["hello", "one", "two"], replies: 3, memory: ["the code word is ZEPHYR1"], routines: [{ slug: "probe", schedule: "0 9 * * 1" }], tasks: [{ id: "t1", title: "Task ZEPHYR1" }], key: true, provider: "MiniMax m3" };
  assert.deepEqual(readBackProblems(seed, seen), []);
  const lost = readBackProblems(seed, { agents: [], userTexts: ["one"], replies: 1, memory: [], routines: [{ slug: "probe", schedule: "* * * * *" }], tasks: [], key: false, provider: "other" });
  for (const what of [/agent Probe/, /"two/, /replies: 1 of the 2/, /memory holding ZEPHYR1/, /schedule/, /task "Task ZEPHYR1"/, /saved key/, /provider/]) assert.ok(lost.some(line => what.test(line)), `${what} is reported: ${lost.join(" | ")}`);
});

test("a downgrade owes a refusal only when the previous app knows formats and the candidate's is higher", () => {
  assert.equal(downgradeExpectation(1, 2, "0.4.11").refuse, true);
  assert.match(downgradeExpectation(2, 2, "0.4.12").why, /nothing to refuse/);
  assert.match(downgradeExpectation(undefined, 2, "0.4.10").why, /predates the home format number/);
  assert.equal(downgradeExpectation(undefined, 2, "0.4.10").refuse, false);
});

test("a refusal is exit 78, the server's newer-data sentence with the format, and a home left as it was", () => {
  const home = { format: 2, ledger: [made, stamp2] };
  const said = "error: The data in /h is format 2, written by LumenBox 0.4.12. A newer LumenBox wrote this home: this is LumenBox 0.4.11, which reads up to format 1. Install LumenBox 0.4.12 or later to use it.";
  const ok = judgeRefusal({ code: 78, output: `starting\n${said}\n`, format: 2, before: home, after: home });
  assert.deepEqual(ok.problems, []);
  assert.match(ok.message, /^The data in \/h is format 2/);
  assert.match(judgeRefusal({ code: 1, output: said, format: 2, before: home, after: home }).problems.join(), /exit status 1, not 78/);
  assert.match(judgeRefusal({ code: null, output: "serving on 7796", format: 2, before: home, after: home }).problems.join(), /none.*no `error/);
  assert.match(judgeRefusal({ code: 78, output: "error: cannot read config", format: 2, before: home, after: home }).problems.join(), /does not say a newer version/);
  assert.match(judgeRefusal({ code: 78, output: said, format: 2, before: home, after: { format: 1, ledger: [made] } }).problems.join(), /changed/);
});

test("the home's record is read from disk the way the candidate wrote it, a torn line skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-snapshot-"));
  const home = join(root, "home");
  mkdirSync(home);
  assert.deepEqual(homeSnapshot(home), { format: undefined, ledger: [], backups: [] });
  writeFileSync(join(home, "FORMAT"), "2\n");
  writeFileSync(join(home, "format-migrations.jsonl"), `${JSON.stringify(made)}\n${JSON.stringify(stamp2)}\n{"torn`);
  mkdirSync(join(`${home}-backups`, "2026-11-28-before-format-2"), { recursive: true });
  assert.deepEqual(homeSnapshot(home), { format: 2, ledger: [made, stamp2], backups: ["2026-11-28-before-format-2"] });
});

test("after the upgrade the server answering must be the candidate's version and build, not a previous server left on the port", () => {
  const stamped = { version: "0.4.12", buildCommit: "6128a7bf" };
  assert.deepEqual(servingProblems({ version: "0.4.12", commit: "6128a7b" }, stamped), [], "a short and a longer form of one commit agree");
  assert.deepEqual(servingProblems({ version: "0.4.12", commit: "unknown" }, { version: "0.4.12" }), [], "a build with no stamp is judged by the version");
  const old = servingProblems({ version: "0.4.11", commit: "a1b2c3d" }, stamped);
  assert.equal(old.length, 2);
  assert.match(old.join("; "), /version 0\.4\.11, the candidate is 0\.4\.12.*build a1b2c3d, the candidate is 6128a7bf/);
  assert.match(servingProblems({ version: "0.4.12", commit: "0000000" }, stamped)[0], /build 0000000/, "the same version from another build (an upgrade of 0.4.11 to a 0.4.11 candidate) is caught by the commit");
  assert.match(servingProblems(undefined, stamped)[0], /says version nothing/);
});
