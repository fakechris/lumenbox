/** The eval command on the stand-in: a second run costs nothing, and a stand-in's page cannot be filed as a result (INV-1772). */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "./eval-report.mjs";
import { SCENARIOS } from "./scenario-live.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const collect = async argv => {
  const lines = [];
  const code = await main(argv, line => lines.push(line));
  return { code, text: lines.join("\n") };
};

test("run --fake writes a record and a page marked as no measurement; run again offline, every call comes from the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1772-cli-"));
  try {
    const common = ["run", "--fake", "--wrong", "0.3", "--only", "steward.", "--k", "2", "--cache", join(dir, "cache")];
    const first = await collect([...common, "--out", join(dir, "a.json"), "--report", join(dir, "a.md")]);
    assert.equal(first.code, 0, first.text);
    const a = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    assert.equal(a.fake, true);
    assert.ok(a.calls.made === a.tasks.length * 2 && a.calls.cached === 0, JSON.stringify(a.calls));
    assert.match(readFileSync(join(dir, "a.md"), "utf8"), /^<!-- eval-report: REPORT-\d{4}-\d{2}-\d{2}\n {5}measured: no /);

    const second = await collect([...common, "--offline", "--out", join(dir, "b.json")]);
    const b = JSON.parse(readFileSync(join(dir, "b.json"), "utf8"));
    assert.deepEqual(b.calls, { made: 0, cached: a.calls.made }, "the re-run made no call");
    assert.deepEqual(b.tasks, a.tasks);
    assert.match(second.text, /NOT A MEASUREMENT/, "with no --report the page is printed, still labelled");

    // The judges ran after the attempts, on the stand-in too, and are on the record with who they were.
    assert.deepEqual(a.judges.model, { provider: "fake", model: "deterministic stand-in" });
    assert.equal(a.judges.verdicts.length, a.tasks.length * 2, "every steward attempt has a question");
    assert.deepEqual(b.judges.calls, { made: 0, cached: a.judges.calls.made });
    const { judges: _dropped, ...bare } = b;
    writeFileSync(join(dir, "c.json"), JSON.stringify(bare));
    const judged = await collect(["judge", join(dir, "c.json"), "--fake", "--offline", "--cache", join(dir, "cache")]);
    assert.match(judged.text, /0 calls made/, "a record judged later is asked the same questions, from the cache");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "c.json"), "utf8")).judges.verdicts, a.judges.verdicts);
    await assert.rejects(collect(["label-sheet", join(dir, "a.json"), "--out", join(dir, "sheet.jsonl")]), /no judged output of a real model/, "a stand-in's outputs are not put in front of a person to label");
    await assert.rejects(collect(["judge", join(dir, "a.json")]), /stand-in's/, "nor in front of a real judge");

    const again = await collect(["report", join(dir, "b.json"), "--baseline", join(dir, "a.json")]);
    assert.match(again.text, /not comparable\*\* \| one side was answered by a stand-in/, "two stand-in runs are not a comparison of anything");
    assert.match((await collect(["trend", "--dir", dir])).text, /No evaluation results/, "only files named eval-*.json are results");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stand-in's page is refused in docs/evals/, and plan counts calls without making any", async () => {
  const target = join(root, "docs/evals/REPORT-2099-01-01.md");
  await assert.rejects(collect(["run", "--fake", "--only", "steward.", "--k", "1", "--report", target]), /may not be written into docs\/evals/);
  assert.equal(existsSync(target), false);
  const plan = await collect(["plan", "--only", "steward.", "--k", "3"]);
  const [, tasks, calls, judgeCalls] = /^(\d+) tasks from the test split × 3 attempts: at most (\d+) model calls, and (\d+) judge calls after them/.exec(plan.text);
  assert.equal(Number(calls), Number(tasks) * 3);
  assert.equal(Number(judgeCalls), Number(tasks) * 3, "one judge question per steward attempt");
  assert.match((await collect(["plan", "--only", "skill.", "--k", "3"])).text, /and 0 judge calls/, "which skill was opened is decided by code alone");
  await assert.rejects(collect(["plan", "--split", "train"]), /--split needs dev or test/);
});

test("--compare freezes two commits, finds the one whose prompt points at a file that is not there red, and asks nothing twice (INV-1862)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1862-cli-"));
  // The frozen trees go under a temporary directory of this test's own, so what is left of them can be counted.
  const scratch = join(dir, "tmp");
  mkdirSync(scratch);
  const realTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    // A throwaway repository of this product with one more commit: the candidate's prompt lists every
    // skill at a path no skill is at. Nothing is written to the repository the suite runs in.
    const repo = join(dir, "repo");
    const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, repo], { stdio: ["ignore", "pipe", "pipe"] });
    const skills = join(repo, "src/host/skills.ts");
    const source = readFileSync(skills, "utf8");
    const named = 'export const SKILL_FILENAME = "SKILL.md";';
    assert.ok(source.includes(named), "the fixture edits the one line that names a skill's file");
    writeFileSync(skills, source.replace(named, 'export const SKILL_FILENAME = "SKILL.txt";'));
    git("commit", "--quiet", "-am", "the prompt names a file no skill has");

    const plan = await collect(["plan", "--compare", "HEAD~1", "HEAD", "--only", "skill.", "--k", "2"]);
    const [, twice, once] = /at most (\d+) model calls, twice the (\d+) of a plain run/.exec(plan.text);
    assert.equal(Number(twice), Number(once) * 2, "the cost of both versions is said before anything is spent");
    assert.match(plan.text, /No judge is asked/);

    const common = ["--compare", "HEAD~1", "HEAD", "--repo", repo, "--fake", "--wrong", "0", "--only", "skill.", "--k", "2", "--cache", join(dir, "cache")];
    const first = await collect([...common, "--out", join(dir, "a.json"), "--report", join(dir, "a.md")]);
    assert.equal(first.code, 0, first.text);
    const a = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    assert.notEqual(a.base.sha, a.candidate.sha);
    assert.notEqual(a.base.surface.digest, a.candidate.surface.digest, "the two sides were built from two trees: their prompts differ");
    assert.equal(a.base.run.split, "dev+test");
    assert.match(first.text, /gate: RED — the pass rate fell by .* \(stand-in; not a measurement\)/);
    const page = readFileSync(join(dir, "a.md"), "utf8");
    assert.match(page, /^<!-- eval-report: COMPARE-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}-[0-9a-f]{7}\n {5}measured: no /);
    const mustOpen = a.base.run.tasks.filter(task => task.failureType === "skill-not-opened");
    assert.ok(mustOpen.length > 10 && mustOpen.every(task => page.includes(`| ${task.id} **(outright)** |`)), "every skill the candidate can no longer open is listed as broken");
    assert.match(page, /## Tasks that got better\n\nNone\./);

    // A commit against itself sends the same requests: the second side costs nothing and nothing moves.
    const same = await collect(["--compare", "HEAD", "HEAD", "--repo", repo, "--fake", "--wrong", "0.3", "--only", "steward.", "--k", "2", "--cache", join(dir, "cache"), "--out", join(dir, "c.json")]);
    const c = JSON.parse(readFileSync(join(dir, "c.json"), "utf8"));
    assert.ok(c.base.run.calls.made > 0 && c.candidate.run.calls.made === 0, JSON.stringify([c.base.run.calls, c.candidate.run.calls]));
    assert.match(same.text, /gate: NOT RED \(stand-in; not a measurement\)/);
    assert.match(same.text, /The two versions send the same prompt and the same tools/);

    await assert.rejects(collect([...common, "--report", join(root, "docs/evals/COMPARE-2099-01-01-aaaaaaa-bbbbbbb.md")]), /may not be written into docs\/evals/);
    await assert.rejects(collect(["--compare", "HEAD", "no-such-ref", "--repo", repo, "--fake"]), /no-such-ref names no commit/);
    await assert.rejects(collect(["--compare", "HEAD", "--fake"]), /--compare needs two refs/);
    assert.deepEqual(readdirSync(scratch), [], "every frozen tree and scratch home was removed");
    assert.ok(existsSync(join(root, "node_modules/@anthropic-ai/sdk")), "and removing one left this checkout's packages where they are");
  } finally {
    if (realTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scenario tasks ask what the live scenarios ask", async () => {
  const { loadCorpus } = await import("../src/evals/corpus.ts");
  const corpus = loadCorpus(join(root, "evals/corpus"));
  for (const task of [...corpus.dev, ...corpus.test].filter(one => one.source.kind === "scenario")) {
    const name = task.source.ref.split("#")[1];
    assert.equal(task.input.says, SCENARIOS.find(scenario => scenario.name === name)?.say, `${task.id} has drifted from scripts/scenario-live.mjs#${name}`);
  }
});
