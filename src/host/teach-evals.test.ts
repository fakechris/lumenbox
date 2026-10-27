/** The teach eval scorer (INV-1369): reference answers pass, the failure each check exists for fails it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { absenceProbe, runTeachEvals, scoreTeaching, TEACH_FIXTURES } from "./teach-evals.ts";

const fixture = (id: string) => TEACH_FIXTURES.find(f => f.id === id)!;
const failing = (id: string, skill: string) =>
  scoreTeaching(fixture(id), JSON.stringify({ skill, question: null })).filter(check => !check.ok).map(check => check.name);
const head = (description: string) => `---\nname: x\ndescription: ${description}\nscope: global\n---\n\n`;

test("every reference answer passes and no cue carries its answer key", async () => {
  assert.ok(TEACH_FIXTURES.length >= 5);
  const rows = await runTeachEvals(async (_cue, f) => f.reference);
  for (const row of rows) assert.ok(row.passed, `${row.fixture}: ${JSON.stringify(row.checks.filter(c => !c.ok))}${row.failure ?? ""}`);
  for (const f of TEACH_FIXTURES) assert.equal(absenceProbe(f), undefined);
});

test("each check fails on the draft it exists to catch", () => {
  const good = JSON.parse(fixture("issue-search").reference).skill as string;
  assert.deepEqual(failing("issue-search", good), []);
  assert.ok(failing("issue-search", good.replace("{query}", "flaky test")).includes("inputs are {placeholders}"), "a typed value kept literally");
  const placed = failing("issue-search", `${good}\nClick at (640, 182).`);
  assert.ok(placed.includes("no coordinates"), JSON.stringify(placed));
  assert.ok(failing("issue-search", good.replace("Use when asked to find open issues in a GitHub repository about a topic", "Steps for a page")).includes("description is a trigger"));
  assert.ok(failing("issue-search", `${head("find github issues")}Search for {query} first. Then open the issues page.`).includes("steps in order"));
  assert.ok(failing("issue-search", `${good}\nopen-issue-triage-rubric`).includes("no rubric echo"), "the tripwire");
  assert.ok(failing("token-in-url", `${head("check status")}Open https://status.example.com/feed?token=${"t0k".repeat(8)} and read the status.`).includes("no credential"));
  assert.ok(failing("expense-submit", `${head("file an expense")}Fill {amount} and {category}, press Submit.`).includes("confirms before committing"));
  assert.deepEqual(scoreTeaching(fixture("only-sign-in"), JSON.stringify({ skill: good, question: null })).filter(c => !c.ok).map(c => c.name), ["asks instead of writing"]);
  assert.equal(scoreTeaching(fixture("issue-search"), "not json")[0]!.ok, false);
});
