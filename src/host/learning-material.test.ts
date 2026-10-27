/** Learning material (INV-1377): a schema'd directory evaluations write and an improvement turn reads. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { improvementCue, materialProblem, readMaterial, writeMaterial, type MaterialTask } from "./learning-material.ts";

const task = (over: Partial<MaterialTask>): MaterialTask => ({ id: "t1", source: "skill-eval", input: "make me a weekly report", passed: false, feedback: "should have opened weekly-report", skill: { slug: "weekly-report" }, ...over });

test("material round-trips through the fixed layout, redacted and schema-checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "material-"));
  try {
    writeMaterial(dir, [task({ output: `token ghp_${"a".repeat(36)}`, tools: ["read_file(/x)"] }), task({ id: "t2", passed: true, feedback: "opened as it should" })]);
    assert.deepEqual(readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), [
      { id: "t1", source: "skill-eval", passed: false, skill: "weekly-report" },
      { id: "t2", source: "skill-eval", passed: true, skill: "weekly-report" },
    ]);
    const back = readMaterial(dir);
    assert.equal(back.length, 2);
    assert.match(back[0]!.output!, /\[credential:github-pat\]/, "a credential never lands in the material");
    writeFileSync(join(dir, "tasks", "t2.json"), JSON.stringify({ id: "t2", source: "nope", input: "x", passed: true, feedback: "y" }));
    assert.throws(() => readMaterial(dir), /source must be one of/, "a broken task is an error, not skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(materialProblem({ ...task({}), id: "../x" }) ?? "", /id/);
  assert.match(materialProblem({ ...task({}), feedback: "" }) ?? "", /feedback/);
  assert.throws(() => writeMaterial(mkdtempSync(join(tmpdir(), "material-bad-")), [task({ input: "" })]), /input is required/);
});

test("the improvement cue carries the skill, its failing tasks as the basis, and passing ones to keep", () => {
  const skill = "---\nname: Weekly report\ndescription: Report\nscope: global\n---\n\nSteps.";
  const { cue, basis } = improvementCue("weekly-report", skill, [
    task({ id: "miss-1" }),
    task({ id: "ok-1", passed: true, feedback: "opened as it should" }),
    task({ id: "other", skill: { slug: "research-brief" } }),
  ]);
  assert.deepEqual(basis, ["miss-1"]);
  assert.match(cue, /The skill as it stands:\n```\n---\nname: Weekly report/);
  assert.match(cue, /Tasks that failed:\n- miss-1 \(FAILED\): asked "make me a weekly report"/);
  assert.match(cue, /Tasks that passed \(keep them passing\):\n- ok-1/);
  assert.ok(!cue.includes("research-brief"), "another skill's tasks stay out");
  assert.match(cue, /usually fixed in the description: it is the trigger/);
  assert.deepEqual(improvementCue("weekly-report", skill, [task({ passed: true })]).basis, []);
});
