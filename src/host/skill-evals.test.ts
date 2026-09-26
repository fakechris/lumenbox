import { test } from "node:test";
import assert from "node:assert/strict";
import { starterSkillsWithEvals } from "./starter-skills.ts";
import { hubSkillSlugs } from "./catalog.ts";
import { filesRead, judgeSkillEval, validateSkillEvals, type SkillEval } from "./skill-evals.ts";

const known = new Set([...starterSkillsWithEvals().map(starter => starter.slug), ...hubSkillSlugs()]);

test("every starter says when it is used and when it is not, and the cases are sound", () => {
  const problems = starterSkillsWithEvals().flatMap(starter => validateSkillEvals(starter.slug, starter.evals, known));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a starter without a no-trigger case fails the guard, and so does one without a trigger", () => {
  const onlyTrigger: SkillEval[] = [{ name: "t", kind: "trigger", says: "do it" }];
  assert.match(validateSkillEvals("x", onlyTrigger, known).join(" "), /no no-trigger case/);
  const onlyNo: SkillEval[] = [{ name: "n", kind: "no-trigger", says: "something else" }];
  assert.match(validateSkillEvals("x", onlyNo, known).join(" "), /no trigger case/);
});

test("a case is refused for what would make its result meaningless", () => {
  const bad: SkillEval[] = [
    { name: "t", kind: "trigger", says: "" },
    { name: "t", kind: "no-trigger", says: "x", instead: "no-such-skill" },
    { name: "u", kind: "no-trigger", says: "x", files: { "/etc/passwd": "" } },
    { name: "v", kind: "trigger", says: "x", instead: "research-brief" },
  ];
  const problems = validateSkillEvals("x", bad, known).join("\n");
  assert.match(problems, /says is empty/);
  assert.match(problems, /two cases share this name/);
  assert.match(problems, /no-such-skill, which is not a skill/);
  assert.match(problems, /outside \/home\/box/);
  assert.match(problems, /instead only means something on a no-trigger case/);
});

test("used means opened: the judgement reads read_file calls off the transcript", () => {
  const path = "/home/box/work/skills/research-brief/SKILL.md";
  const transcript = [
    { role: "user", text: "research this" },
    { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "t1", name: "read_file", input: { path } }] },
    { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "t2", name: "bash", input: { command: `cat ${path}` } }] },
  ];
  const read = filesRead(transcript);
  assert.deepEqual(read, [path], "only read_file counts; a cat in bash is not the skill being chosen");
  assert.equal(judgeSkillEval({ name: "t", kind: "trigger", says: "x" }, path, read), "pass");
  assert.equal(judgeSkillEval({ name: "n", kind: "no-trigger", says: "x" }, path, read), "fail");
  assert.equal(judgeSkillEval({ name: "n", kind: "no-trigger", says: "x" }, path, []), "pass");
  assert.equal(judgeSkillEval({ name: "q", kind: "trigger", says: "x", na: "needs a live chat" }, path, read), "na", "N/A is never a pass");
});
