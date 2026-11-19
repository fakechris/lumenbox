/** Code graders: each part of a task's gold is one finding with its evidence (INV-1772). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalTask, Gold } from "./corpus.ts";
import { gradeObservation, type Observation, textMatches } from "./graders.ts";

const task = (gold: Gold, input: Record<string, unknown> = {}): EvalTask => ({ id: "t", subject: "episode", source: { kind: "scenario", ref: "x" }, failureType: "f", input, gold });
const seen = (more: Partial<Observation> = {}): Observation => ({ output: "", labels: [], state: {}, ...more });
const verdicts = (gold: Gold, observation: Observation) => Object.fromEntries(gradeObservation(task(gold), observation).map(result => [result.name, result.pass]));

test("labels: what must be carried and what must not, with what was found", () => {
  const gold: Gold = { labels: { all: ["skill:data-brief"], none: ["skill:research-brief"] } };
  assert.deepEqual(verdicts(gold, seen({ labels: ["skill:data-brief"] })), { labels: true });
  const [missing] = gradeObservation(task(gold), seen({ labels: [] }));
  assert.equal(missing!.pass, false);
  assert.match(missing!.detail!, /missing skill:data-brief.*got: none/);
  const [both] = gradeObservation(task(gold), seen({ labels: ["skill:data-brief", "skill:research-brief"] }));
  assert.match(both!.detail!, /must not carry skill:research-brief/);
});

test("required facts and forbidden words are found without case, or by pattern", () => {
  assert.equal(textMatches("Reference EX-2291", "the reference ex-2291 is shown"), true);
  assert.equal(textMatches("re:\\bfork(ed)?\\b", "I Forked a helper"), true);
  assert.equal(textMatches("re:\\bfork\\b", "a pitchfork"), false);
  const gold: Gold = { facts: ["三段", "re:risk|风险"], forbidden: ["re:fork|delegat|子代理"] };
  assert.deepEqual(verdicts(gold, seen({ output: "分三段：进展、风险、计划。" })), { facts: true, forbidden: true });
  const results = gradeObservation(task(gold), seen({ output: "I delegated it." }));
  assert.match(results.find(one => one.name === "facts")!.detail!, /missing: 三段 \| re:risk/);
  assert.match(results.find(one => one.name === "forbidden")!.detail!, /contains: re:fork/);
});

test("format: an object or a list is JSON, prose is not, and a fenced block is read as its contents", () => {
  assert.deepEqual(verdicts({ format: "json" }, seen({ output: '```json\n{"a":1}\n```' })), { format: true });
  assert.deepEqual(verdicts({ format: "json" }, seen({ output: "Sure! {a:1}" })), { format: false });
  assert.deepEqual(verdicts({ format: "json" }, seen({ output: "42" })), { format: false });
  assert.deepEqual(verdicts({ format: "nonempty" }, seen({ output: "  \n" })), { format: false });
});

test("terminal state: each bound is its own finding, and a state the run never reported fails rather than passes", () => {
  const gold: Gold = { state: { questions: { max: 1 }, agents: { min: 6 }, engaged: { eq: true } } };
  assert.deepEqual(verdicts(gold, seen({ state: { questions: 1, agents: 6, engaged: true } })), { "state:questions": true, "state:agents": true, "state:engaged": true });
  assert.deepEqual(verdicts(gold, seen({ state: { questions: 3, agents: 2, engaged: false } })), { "state:questions": false, "state:agents": false, "state:engaged": false });
  const [unreported] = gradeObservation(task({ state: { questions: { max: 1 } } }), seen());
  assert.equal(unreported!.pass, false);
  assert.match(unreported!.detail!, /did not report/);
});

test("the teach scorer is the one in teach-evals: its checks come back by name, and echoing the hidden rubric fails", () => {
  const skill = "---\nname: Find issues\ndescription: Use when asked to find issues on github\nscope: global\n---\n\nInputs: {repo}, {query}.\n\n1. Open the issues page and search for {query}.\n";
  const expect = { skill: true, trigger: ["issue"], steps: ["issues", "search"], inputs: ["flaky test"], rubric: ["open-issue-triage-rubric"] };
  const teach = (output: string) => Object.fromEntries(gradeObservation({ ...task({ scorer: { name: "teach", expect } }, { fixture: "issue-search", trace: [] }), subject: "teach" }, seen({ output })).map(result => [result.name, result.pass]));
  const good = teach(JSON.stringify({ skill, question: null }));
  assert.ok(Object.values(good).every(Boolean), JSON.stringify(good));
  assert.ok("teach:steps in order" in good && "teach:inputs are {placeholders}" in good);
  assert.equal(teach(JSON.stringify({ skill: `${skill}\nSee open-issue-triage-rubric.`, question: null }))["teach:no rubric echo"], false);
  assert.deepEqual(teach("prose, not the object"), { "teach:parses": false });
});
