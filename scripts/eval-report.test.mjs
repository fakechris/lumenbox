/** The eval command on the stand-in: a second run costs nothing, and a stand-in's page cannot be filed as a result (INV-1772). */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.match(plan.text, /^(\d+) tasks from the test split × 3 attempts: at most (\d+) model calls/);
  const [, tasks, calls] = /^(\d+) tasks .* at most (\d+) model calls/.exec(plan.text);
  assert.equal(Number(calls), Number(tasks) * 3);
  await assert.rejects(collect(["plan", "--split", "train"]), /--split needs dev or test/);
});

test("the scenario tasks ask what the live scenarios ask", async () => {
  const { loadCorpus } = await import("../src/evals/corpus.ts");
  const corpus = loadCorpus(join(root, "evals/corpus"));
  for (const task of [...corpus.dev, ...corpus.test].filter(one => one.source.kind === "scenario")) {
    const name = task.source.ref.split("#")[1];
    assert.equal(task.input.says, SCENARIOS.find(scenario => scenario.name === name)?.say, `${task.id} has drifted from scripts/scenario-live.mjs#${name}`);
  }
});
